// 剛好學擴充套件：側邊欄
// 下方 iframe 載入正式的剛好學網站；上方工具列負責「讀分頁 → 用 postMessage 交給剛好學」。
import { extractPageContent } from './extract.js';

const DEFAULT_APP_URL = 'https://cagoooo.github.io/Akailao/';
const ALL_SITES = { origins: ['<all_urls>'] };
const MAX_SHOTS = 8;
// 金鑰申請提醒（定稿文字）：學校信箱申請的金鑰沒有免費額度
const KEY_HELP = '打開 Google AI Studio 金鑰頁面，用個人 Gmail 帳號登入。不要用學校信箱，用個人帳號申請才能使用免費額度。';

const $ = (sel) => document.querySelector(sel);
const frame = $('#app-frame');
const chip = $('#conn-chip');
const statusEl = $('#status');
const tabTitleEl = $('#tab-title');
const readingBtn = $('#reading-btn');
const shotBtn = $('#shot-btn');
const shotGenBtn = $('#shot-gen-btn');
const dispatchBtn = $('#dispatch-btn');
const shotsEl = $('#shots');
const gradeSel = $('#grade-select');

let appUrl = DEFAULT_APP_URL;
let appOrigin = new URL(DEFAULT_APP_URL).origin;
let appReady = false;
let appState = null;
let helloTimer = null;
let queued = null;
let hasAllSites = false;
let shots = [];
let dispatchArmedUntil = 0;
let lastTip = '';
const actionTypes = new Map();

// ---------- 小工具 ----------
function setStatus(text, kind = 'info') {
  statusEl.textContent = text || '';
  statusEl.className = `status ${kind}`;
}

function setChip(text, kind) {
  chip.textContent = text;
  chip.className = `chip chip-${kind}`;
}

function getMode() {
  return document.querySelector('input[name="mode"]:checked')?.value === 'rewrite' ? 'rewrite' : 'original';
}

function isAllowedAppUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch (e) {
    return false;
  }
}

// 側邊欄載入的網址帶 from=chrome-extension：剛好學據此改用老師自己的 Gemini 金鑰
function panelUrl() {
  const u = new URL(appUrl);
  u.searchParams.set('from', 'chrome-extension');
  return u.href;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// 第一次使用時請老師允許「讀取網頁內容」。必須是按鈕事件裡的第一個 await（Chrome 要求在使用者操作當下詢問）。
async function ensureSitePermission() {
  if (hasAllSites) return true;
  try {
    hasAllSites = await chrome.permissions.request(ALL_SITES);
  } catch (e) {
    hasAllSites = false;
  }
  return hasAllSites;
}

// ---------- 與剛好學（iframe）溝通 ----------
function postToApp(type, payload) {
  const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
  actionTypes.set(id, type);
  frame.contentWindow.postMessage({ source: 'akailao-ext', type, payload, id }, appOrigin);
  return id;
}

function sendToApp(type, payload) {
  if (!appReady) {
    queued = { type, payload };
    setStatus('⏳ 剛好學還在載入，載入完成後會自動送出…', 'info');
    return;
  }
  postToApp(type, payload);
}

function startHandshake() {
  appReady = false;
  clearInterval(helloTimer);
  setChip('連線中…', 'wait');
  let tries = 0;
  const hello = () => {
    tries += 1;
    try {
      frame.contentWindow.postMessage({ source: 'akailao-ext', type: 'hello' }, appOrigin);
    } catch (e) { /* iframe 尚未就緒 */ }
    if (tries > 30) {
      clearInterval(helloTimer);
      setChip('無法連線', 'err');
      setStatus('連不上剛好學。請按 ⟳ 重新整理，或確認網路連線。', 'err');
    }
  };
  hello();
  helloTimer = setInterval(hello, 1000);
}

function renderState(state) {
  appState = state || appState;
  if (!appState) return;
  if (appState.busy) setChip('AI 處理中…', 'wait');
  else if (appState.teacherReady && appState.hasOwnKey === false) setChip(`教室 ${appState.classroomCode}・🔑 未設金鑰`, 'login');
  else if (appState.teacherReady) setChip(`教室 ${appState.classroomCode}`, 'ok');
  else if (appState.loggedIn) setChip('請選擇教室', 'login');
  else setChip('請先登入老師帳號', 'login');
}

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.origin !== appOrigin) return;
  const msg = event.data;
  if (!msg || msg.source !== 'akailao-app') return;

  if (msg.type === 'ready') {
    if (!appReady) {
      appReady = true;
      clearInterval(helloTimer);
      if (queued) {
        const q = queued;
        queued = null;
        postToApp(q.type, q.payload);
      }
    }
  }
  renderState(msg.state);

  if (msg.type === 'ack') {
    const type = actionTypes.get(msg.id) || '';
    if (msg.status === 'need-key') {
      setStatus(`🔑 出題要用你自己的免費 Gemini 金鑰，請在下方視窗貼上，存好後會自動接著出題。\n申請方式：${KEY_HELP}`, 'warn');
    } else if (msg.status === 'pending') {
      setStatus('📥 已收到！請在下方登入老師帳號並進入教室，會自動接著處理。（登入視窗沒出現時，按 ↗ 在新分頁登入一次，再按 ⟳）', 'warn');
    } else if (msg.status === 'running') {
      setStatus(type === 'dispatch-url' ? '⏳ 派送中…' : '⏳ AI 出題中，大約 10～30 秒…', 'info');
    } else if (msg.status === 'done') {
      setStatus(type === 'dispatch-url'
        ? '✅ 已派送到學生畫面！'
        : `✅ 題目完成！請在下方檢查文本與題目，沒問題就按「確認並開始互動」。${lastTip}`, 'ok');
    } else if (msg.status === 'error') {
      setStatus(`⚠️ ${msg.message || '處理失敗，請再試一次。'}`, 'err');
    }
  }
});

// ---------- 讀取分頁 ----------
async function readActiveTab(granted) {
  const tab = await getActiveTab();
  if (!tab || tab.id === undefined) throw new Error('找不到目前的分頁。');
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageContent });
    return res?.result || null;
  } catch (e) {
    throw new Error(granted
      ? '這個頁面不允許擴充套件讀取文字（例如 Chrome 內建頁面、PDF 或線上應用程式商店）。請改用「📸 截圖」出題。'
      : '需要先允許「讀取網頁內容」才能出題。請再按一次，並在跳出的視窗按「允許」。');
  }
}

function sendReading(content) {
  const text = (content?.text || '').trim();
  if (text.length < 30) {
    setStatus('這頁抓不到足夠的文字。請先在網頁上反白選取文章段落，或改用「📸 截圖」出題。', 'err');
    return;
  }
  const source = content.kind === 'selection' ? '選取文字' : '整頁';
  lastTip = (content.kind !== 'selection' && getMode() === 'original' && text.length > 3000)
    ? `\n💡 整頁有 ${text.length} 字，對學生可能偏長；可改選「改寫成適齡短文」，或先反白選取想用的段落。`
    : '';
  setStatus(`📄 已擷取${source} ${text.length} 字，交給剛好學出題…`, 'info');
  sendToApp('reading-text', {
    text,
    title: content.title || '',
    url: content.url || '',
    kind: content.kind,
    mode: getMode(),
    grade: gradeSel.value
  });
}

readingBtn.addEventListener('click', async () => {
  const granted = await ensureSitePermission();
  readingBtn.disabled = true;
  try {
    sendReading(await readActiveTab(granted));
  } catch (e) {
    setStatus(e.message, 'err');
  } finally {
    readingBtn.disabled = false;
  }
});

// ---------- 截圖出題 ----------
function renderShots() {
  shotsEl.innerHTML = '';
  shotsEl.classList.toggle('hidden', shots.length === 0);
  shots.forEach((src, idx) => {
    const box = document.createElement('div');
    box.className = 'shot';
    const img = document.createElement('img');
    img.src = src;
    img.alt = `截圖 ${idx + 1}`;
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '移除這張截圖';
    del.addEventListener('click', () => { shots.splice(idx, 1); renderShots(); });
    box.append(img, del);
    shotsEl.append(box);
  });
  shotBtn.textContent = shots.length ? `📸 再截一張（${shots.length}/${MAX_SHOTS}）` : '📸 截圖';
  shotBtn.disabled = shots.length >= MAX_SHOTS;
  shotGenBtn.disabled = shots.length === 0;
  shotGenBtn.textContent = shots.length ? `🧠 用 ${shots.length} 張截圖出題` : '🧠 用截圖出題';
}

shotBtn.addEventListener('click', async () => {
  const granted = await ensureSitePermission();
  try {
    const tab = await getActiveTab();
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
    shots.push(dataUrl);
    renderShots();
    setStatus(`已截 ${shots.length} 張。文章很長可以捲動網頁後再截，最後按「用截圖出題」。`, 'info');
  } catch (e) {
    setStatus(granted ? '這個頁面無法截圖（例如 Chrome 內建頁面）。' : '需要先允許「讀取網頁內容」才能截圖。', 'err');
  }
});

shotGenBtn.addEventListener('click', async () => {
  if (!shots.length) return;
  const tab = await getActiveTab();
  sendToApp('reading-image', { images: shots.slice(), title: tab?.title || '', url: tab?.url || '', grade: gradeSel.value });
  setStatus(`🖼️ 已把 ${shots.length} 張截圖交給剛好學辨識出題…`, 'info');
  shots = [];
  renderShots();
});

// ---------- 派送網址（按兩次確認，避免誤觸直接出現在學生畫面） ----------
dispatchBtn.addEventListener('click', async () => {
  const granted = await ensureSitePermission();
  const tab = await getActiveTab();
  const url = tab?.url || '';
  if (!/^https?:\/\//.test(url)) {
    setStatus(granted ? '這個分頁不是一般網頁，無法派送。' : '需要先允許「讀取網頁內容」才能取得網址。', 'err');
    return;
  }
  if (Date.now() > dispatchArmedUntil) {
    dispatchArmedUntil = Date.now() + 4000;
    dispatchBtn.textContent = '再按一次確認派送';
    setStatus(`要把「${tab.title || url}」派送到學生畫面嗎？4 秒內再按一次確認。`, 'warn');
    setTimeout(() => { if (Date.now() > dispatchArmedUntil) dispatchBtn.textContent = '🔗 派送網址'; }, 4100);
    return;
  }
  dispatchArmedUntil = 0;
  dispatchBtn.textContent = '🔗 派送網址';
  sendToApp('dispatch-url', { url, title: tab.title || '' });
});

// ---------- 右鍵選單交辦的工作（由 background.js 放進 session storage） ----------
async function consumePendingAction() {
  const { pendingAction } = await chrome.storage.session.get('pendingAction');
  if (!pendingAction) return;
  await chrome.storage.session.remove('pendingAction');
  if (Date.now() - (pendingAction.ts || 0) > 2 * 60 * 1000) return; // 太舊的不處理

  if (pendingAction.type === 'reading-text') sendReading(pendingAction.content);
  else if (pendingAction.type === 'dispatch-url') sendToApp('dispatch-url', { url: pendingAction.url, title: pendingAction.title });
  else if (pendingAction.type === 'error') setStatus(pendingAction.message, 'err');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.pendingAction?.newValue) consumePendingAction();
});

// ---------- 目前分頁標題 ----------
async function updateTabInfo() {
  const tab = await getActiveTab();
  tabTitleEl.textContent = tab?.title || (hasAllSites ? '—' : '（允許讀取網頁後顯示標題）');
  tabTitleEl.title = tab?.url || '';
}
chrome.tabs.onActivated.addListener(updateTabInfo);
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.title || info.status === 'complete') updateTabInfo(); });
chrome.permissions.onAdded.addListener(async () => { hasAllSites = await chrome.permissions.contains(ALL_SITES); updateTabInfo(); });
chrome.permissions.onRemoved.addListener(async () => { hasAllSites = await chrome.permissions.contains(ALL_SITES); updateTabInfo(); });

// ---------- 頂端按鈕 ----------
$('#reload-btn').addEventListener('click', () => { frame.src = panelUrl(); });
$('#open-tab-btn').addEventListener('click', () => chrome.tabs.create({ url: appUrl }));
$('#toggle-tools-btn').addEventListener('click', (e) => {
  const collapsed = document.body.classList.toggle('tools-collapsed');
  e.currentTarget.textContent = collapsed ? '▾' : '▴';
  e.currentTarget.setAttribute('aria-expanded', String(!collapsed));
  chrome.storage.local.set({ toolsCollapsed: collapsed });
});
gradeSel.addEventListener('change', () => chrome.storage.local.set({ grade: gradeSel.value }));
document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', () => chrome.storage.local.set({ mode: getMode() })));

// ---------- 啟動 ----------
(async function init() {
  const saved = await chrome.storage.local.get(['mode', 'grade', 'toolsCollapsed', 'appUrl']);
  // 預設「改寫成適齡短文」；老師曾切到「原文出題」就記住他的選擇
  if (saved.mode === 'original') document.querySelector('input[name="mode"][value="original"]').checked = true;
  if (typeof saved.grade === 'string') gradeSel.value = saved.grade;
  if (saved.toolsCollapsed) {
    document.body.classList.add('tools-collapsed');
    $('#toggle-tools-btn').textContent = '▾';
    $('#toggle-tools-btn').setAttribute('aria-expanded', 'false');
  }
  // 開發測試用：chrome.storage.local.set({ appUrl: 'http://localhost:8080/' })
  if (saved.appUrl && isAllowedAppUrl(saved.appUrl)) appUrl = saved.appUrl;
  appOrigin = new URL(appUrl).origin;

  frame.addEventListener('load', startHandshake);
  frame.src = panelUrl();

  hasAllSites = await chrome.permissions.contains(ALL_SITES);
  updateTabInfo();
  renderShots();
  consumePendingAction();
})();
