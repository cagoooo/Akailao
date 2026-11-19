/**
 * 使用情形 → Google Chat 通知（Callable Cloud Function）
 *
 * 前端用「已登入的 Firebase SDK」呼叫這支 Callable（自動帶身分、不可偽造），
 * Function 端把事件組成 cardsV2 卡片 POST 到 Google Chat incoming webhook。
 *
 * 🔐 webhook = 發文金鑰，絕不寫進原始碼 / 公開 repo。存 Secret：
 *   printf '%s' "<webhook>" | firebase functions:secrets:set GOOGLE_CHAT_WEBHOOK --data-file=- --force --project class-4719f
 * 部署（需 Blaze）：
 *   firebase deploy --only functions --force --project class-4719f
 * 區域固定 asia-east1，前端呼叫端也要用同一區域。
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');

const GOOGLE_CHAT_WEBHOOK = defineSecret('GOOGLE_CHAT_WEBHOOK');
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const REGION = 'asia-east1';
// 🆕 [V4.5.1] 每位 Google 登入老師（uid）每天最多 5 次，台北時間午夜重置（原本每小時 5 次）
// 🆕 [V4.5.10] 2026-11-19 每天 5 次下修為 3 次
const AI_DAILY_LIMIT = 3;
const AI_QUOTA_EXCEEDED_MSG = `今天的 ${AI_DAILY_LIMIT} 次已用完，明天（台北時間午夜後）再來`;

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

const EVENT_META = {
  session_start: { emoji: '👀', title: '首頁啟用' },
  login:         { emoji: '✅', title: '使用者登入' },
  create:        { emoji: '🏫', title: '建立教室' },
  feature:       { emoji: '🧩', title: '使用功能' },
  ai_api:        { emoji: '🤖', title: 'AI API 呼叫' },
  class_end:     { emoji: '🔔', title: '下課通知' },
  error:         { emoji: '🐞', title: '系統發生錯誤' },
};

function identityOf(auth, data) {
  const token = (auth && auth.token) || {};
  const provider = (token.firebase && token.firebase.sign_in_provider) || '';
  const name = data.name || token.name || '';
  const email = token.email || '';
  const role = data.role || (provider === 'anonymous' ? '學生' : '教師');
  
  let userLabel = '';
  if (role === '教師') {
    userLabel = `教師 (${[name, email].filter(Boolean).join(' · ') || '未設定姓名'})`;
  } else {
    userLabel = `學生 (${name || '匿名訪客'})`;
  }
  
  return { label: userLabel, role: role };
}

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

function requestIp(request) {
  const fwd = String(request.rawRequest?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return request.rawRequest?.ip || fwd || 'unknown-ip';
}

function getClientKey(request) {
  const uid = request.auth && request.auth.uid;
  const ip = requestIp(request);
  const ua = request.rawRequest?.headers?.['user-agent'] || '';
  return crypto.createHash('sha256').update(`${uid || 'no-auth'}|${ip}|${ua}`).digest('hex').slice(0, 40);
}

// 台北日期 YYYY-MM-DD（台北時間午夜換日）
function taipeiDateKey() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 🆕 [V4.5.1] 每日次數：rateLimits/user_<uid>_<YYYY-MM-DD>，transaction 檢查＋加 1，帶 expireAt（可設 TTL 自動清除）
function aiQuotaRef(uid, dateKey) {
  return db.collection('rateLimits').doc(`user_${uid}_${dateKey}`);
}

async function reserveAiQuota(request, dateKey) {
  const uid = request.auth.uid;
  const ref = aiQuotaRef(uid, dateKey);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? Number(snap.get('count')) || 0 : 0;
    if (count >= AI_DAILY_LIMIT) {
      return { ok: false, remaining: 0, dailyLimit: AI_DAILY_LIMIT, reason: 'daily-limit' };
    }
    tx.set(ref, {
      uid,
      date: dateKey,
      count: count + 1,
      limit: AI_DAILY_LIMIT,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + 2 * 24 * 3600 * 1000),
    }, { merge: true });
    return { ok: true, remaining: AI_DAILY_LIMIT - (count + 1), dailyLimit: AI_DAILY_LIMIT };
  });
}

// Gemini 本身失敗（滿載、逾時）時退回這次，不讓老師白白少一次
async function refundAiQuota(uid, dateKey) {
  try {
    await aiQuotaRef(uid, dateKey).update({ count: admin.firestore.FieldValue.increment(-1) });
  } catch (err) {
    logger.warn('refundAiQuota 失敗（不影響主流程）', { message: err && err.message });
  }
}

function assertGeminiPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new HttpsError('invalid-argument', 'Gemini payload 格式錯誤。');
  }
  if (!Array.isArray(payload.contents) || payload.contents.length === 0) {
    throw new HttpsError('invalid-argument', 'Gemini payload 缺少 contents。');
  }

  const serialized = JSON.stringify(payload);
  if (serialized.length > 900000) {
    throw new HttpsError('invalid-argument', 'AI 請求內容太大，請減少圖片數量或縮短文本。');
  }
}

// 2026-11-14：gemini-2.5 系列已不開放給新專案，共用金鑰改用免費層新專案。
// 依序嘗試：先用 3.1 flash-lite，遇到滿載／暫時錯誤再換 3.5 flash-lite（同為 lite 等級較划算）。
// 舊版前端送來的 2.5 型號一律改走這條鏈。
const GEMINI_MODEL_CHAIN = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
const RETRYABLE_GEMINI_STATUS = [404, 429, 500, 503];

function geminiModelChain(model) {
  const value = String(model || '').trim();
  return GEMINI_MODEL_CHAIN.includes(value)
    ? [value, ...GEMINI_MODEL_CHAIN.filter((m) => m !== value)]
    : GEMINI_MODEL_CHAIN;
}

// ===== 🆕 [V4.5.0] callGemini 每次呼叫都由後端直接發 Google Chat 通知 =====
// 前端回報可被繞過（直接打 callGemini 就不會通知），所以改由後端當唯一來源。
// 卡片只放身分、功能、模型、耗時、時間；不放學生回答、提示詞全文、圖片。
const CHAT_TIMEOUT_MS = 2500;
const BLOCKED_NOTIFY_INTERVAL_MS = 5 * 60 * 1000;
const blockedNotifyAt = new Map(); // 同一 IP 或同一 clientKey 每 5 分鐘最多 1 則（每個執行個體各自計）

function isGoogleTeacher(auth) {
  return Boolean(auth && auth.uid && auth.token?.firebase?.sign_in_provider === 'google.com');
}

function maskIp(ip) {
  const s = String(ip || '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.replace(/\.\d+$/, '.x');
  if (s.includes(':')) return s.split(':').slice(0, 3).join(':') + ':…';
  return s ? '未知格式' : '未知';
}

function shouldNotifyBlocked(ip, clientKey) {
  const now = Date.now();
  for (const [k, ts] of blockedNotifyAt) {
    if (now - ts >= BLOCKED_NOTIFY_INTERVAL_MS) blockedNotifyAt.delete(k);
  }
  const keys = [`ip:${ip}`, `ck:${clientKey}`];
  if (keys.some((k) => blockedNotifyAt.has(k))) return false;
  if (blockedNotifyAt.size > 2000) blockedNotifyAt.clear();
  keys.forEach((k) => blockedNotifyAt.set(k, now));
  return true;
}

function taipeiNow() {
  try {
    return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  } catch (e) {
    return new Date().toISOString();
  }
}

// 🆕 [V4.5.1] Chat 卡片的「AI 功能」只接受 src/app.js 實際送出的名稱（白名單），
// 防止亂碼（錯誤編碼的測試請求）或有人直接呼叫函式把任意文字塞進 Chat
const AI_FEATURE_WHITELIST = new Set([
  'AI 文字雲分析',
  'AI 生成選擇題',
  'AI 生成排序題',
  'AI 生成配對題',
  'AI 辨識題目（是非題）',
  'AI 辨識題目（選擇題）',
  'AI 生成閱讀測驗',
  'AI 補齊閱讀測驗',
  'AI 出題', // 前端 callGeminiContent 沒帶 feature 時的預設值
]);
const UNKNOWN_FEATURE_LABEL = '未知功能（已過濾）';
// U+FFFD（亂碼替代字元）與控制字元
const BAD_CHARS_TEST = /[\uFFFD\u0000-\u001F\u007F-\u009F]/;
const BAD_CHARS_ALL = /[\uFFFD\u0000-\u001F\u007F-\u009F]/g;

function aiFeatureLabel(data) {
  const raw = String(data?.label || data?.feature || '').trim();
  if (!raw || BAD_CHARS_TEST.test(raw)) return UNKNOWN_FEATURE_LABEL;
  return AI_FEATURE_WHITELIST.has(raw) ? raw : UNKNOWN_FEATURE_LABEL;
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(BAD_CHARS_ALL, '').trim().slice(0, max);
}

function cleanTopic(value) {
  return cleanText(value, 30) || '（無）';
}

function buildAiCard(kind, info) {
  const META = {
    success: { title: '✅ 有人使用了 剛好學 AI' },
    failure: { title: '❌ 剛好學 AI 失敗' },
    blocked: { title: '⚠️ 剛好學 AI：未登入的呼叫被擋下' },
    quota: { title: '⛔ 剛好學 AI：今日次數已用完被擋' },
  };
  const meta = META[kind];
  const widgets = [];
  const add = (topLabel, text) => {
    if (text == null || text === '') return;
    // 前端可控的文字一律去掉 < >，避免在 Chat 卡片裡變成連結或格式
    widgets.push({ decoratedText: { topLabel, text: String(text).replace(/[<>]/g, ''), wrapText: true } });
  };

  if (kind === 'blocked') {
    add('原因', info.reason);
    add('來源 IP（已遮蔽）', info.ip);
  } else {
    add('老師', info.teacher);
  }
  add('AI 功能', info.feature);
  if (info.topic) add('主題（前 30 字）', info.topic);
  add('教室代碼', info.classroom);
  if (kind === 'success' || kind === 'failure') {
    add('模型', info.model || '（未呼叫到模型）');
    add('耗時', `${(info.durationMs / 1000).toFixed(1)} 秒`);
  }
  if (typeof info.remaining === 'number') add('今日剩餘', `${info.remaining} 次`);
  if (kind === 'quota') add('限制', `每人每天 ${AI_DAILY_LIMIT} 次（台北時間午夜重置），已在呼叫 Gemini 前擋下`);
  if (kind === 'failure') add('錯誤訊息（前 120 字）', info.error);
  add('台北時間', taipeiNow());

  const summary = kind === 'blocked'
    ? `${meta.title}：${info.feature}（${info.reason}）`
    : `${meta.title}：${info.feature} | ${info.teacher}`;

  return {
    text: summary,
    cardsV2: [{
      cardId: `ai-${kind}-${Date.now()}`,
      card: {
        header: { title: meta.title, subtitle: '剛好學 (Akailao) 遙測系統' },
        sections: [{ widgets }],
      },
    }],
  };
}

async function postAiChat(kind, info) {
  const webhook = String(GOOGLE_CHAT_WEBHOOK.value() || '').trim();
  if (!webhook.startsWith('https://chat.googleapis.com/')) {
    logger.warn('AI Chat 通知略過：GOOGLE_CHAT_WEBHOOK 未設定或格式不符');
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(buildAiCard(kind, info)),
      signal: controller.signal,
    });
    if (!resp.ok) logger.warn('AI Chat 通知失敗', { kind, status: resp.status });
  } catch (err) {
    logger.warn('AI Chat 通知失敗', { kind, message: clip(err && err.message, 120) });
  } finally {
    clearTimeout(timer);
  }
}

function buildCard(type, data, who) {
  const meta = EVENT_META[type] || { emoji: '🔔', title: '使用事件' };
  
  // 組裝推播文字摘要 (用於手機端通知預覽)
  let textSummary = `${meta.emoji} ${meta.title}`;
  if (type === 'create') {
    textSummary += ` - 教室代碼: ${data.classroom || '未設定'}`;
  } else if (type === 'login') {
    textSummary += ` - 角色: ${data.role === 'teacher' ? '教師' : '學生'} (${data.classroom || '未設定'})`;
  } else if (type === 'feature') {
    textSummary += `: ${data.label || data.feature} (教室: ${data.classroom || '未設定'})`;
  } else if (type === 'ai_api') {
    textSummary += `: ${data.label || data.feature} (教室: ${data.classroom || '未設定'})`;
  } else if (type === 'class_end') {
    textSummary += ` - 教室 ${data.classroom || '未知'}，${data.studentCount ?? 0} 位學生，共 ${data.durationMin != null ? data.durationMin + ' 分鐘' : '時長不明'}`;
  } else if (type === 'error') {
    textSummary += `: ${clip(data.message, 100)}`;
  }
  textSummary += ` | ${who.label}`;

  // 第一段：基本身分與教室資訊
  const widgets = [
    { decoratedText: { topLabel: '使用者身分', text: who.label, wrapText: true } }
  ];
  
  if (data.classroom) {
    widgets.push({ decoratedText: { topLabel: '教室代碼', text: clip(data.classroom, 30), wrapText: true } });
  }

  // 第二段：依事件類型加入詳細資訊
  if (type === 'create' && data.classroom) {
    widgets.push({ decoratedText: { topLabel: '新班級代碼', text: clip(data.classroom, 30), wrapText: true } });
  }
  
  if (type === 'login' && data.role) {
    widgets.push({ decoratedText: { topLabel: '登入角色', text: data.role === 'teacher' ? '教師 🧑‍🏫' : '學生 🧑‍🎓', wrapText: true } });
  }
  
  if (type === 'feature') {
    widgets.push({ decoratedText: { topLabel: '使用功能', text: clip(data.label || data.feature, 80), wrapText: true } });
  }

  if (type === 'ai_api') {
    widgets.push({ decoratedText: { topLabel: 'AI 功能', text: clip(data.label || data.feature, 80), wrapText: true } });
    if (data.topic) {
      widgets.push({ decoratedText: { topLabel: '主題 / 輸入內容', text: clip(data.topic, 100), wrapText: true } });
    }
    if (data.count) {
      widgets.push({ decoratedText: { topLabel: '生成數量', text: String(data.count), wrapText: true } });
    }
    if (data.keyType) {
      widgets.push({ decoratedText: { topLabel: 'API Key 類型', text: data.keyType === 'gemini-custom' ? '🔑 自訂金鑰' : '🏫 系統內建', wrapText: true } });
    }
  }
  
  if (type === 'class_end') {
    widgets.push({ decoratedText: { topLabel: '參與學生人數', text: String(data.studentCount ?? 0) + ' 人', wrapText: true } });
    if (data.durationMin != null) {
      widgets.push({ decoratedText: { topLabel: '課堂時長', text: String(data.durationMin) + ' 分鐘', wrapText: true } });
    }
  }

  if (type === 'error') {
    widgets.push({ decoratedText: { topLabel: '錯誤訊息', text: clip(data.message, 300), wrapText: true } });
    if (data.context) {
      widgets.push({ decoratedText: { topLabel: '錯誤發生位置/上下文', text: clip(data.context, 160), wrapText: true } });
    }
    // 收集瀏覽器代理資訊
    if (data.ua) {
      widgets.push({ decoratedText: { topLabel: '瀏覽器/設備 (UA)', text: clip(data.ua, 120), wrapText: true } });
    }
  }

  // 時間與版本資訊
  let timeText = '';
  try {
    timeText = (data.ts ? new Date(data.ts) : new Date()).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  } catch (e) {
    timeText = clip(data.ts, 40);
  }
  widgets.push({ decoratedText: { topLabel: '台北時間', text: timeText, wrapText: true } });

  return {
    text: textSummary, // 手機推播通知欄摘要
    cardsV2: [{
      cardId: 'usage-' + Date.now(),
      card: {
        header: {
          title: `${meta.emoji} ${meta.title}`,
          subtitle: '剛好學 (Akailao) 遙測系統'
        },
        sections: [{
          widgets: widgets
        }]
      }
    }]
  };
}

// ⚠️ [V4.6.4] notifyUsage 已移除：剛好學與班級小管家共用 Firebase 專案 class-4719f，
//   正式版 notifyUsage 在 H:\Classunctions（成功事件只留底給每日戰報，錯誤才即時推 Chat）。
//   這裡的舊版會每個學生登入都推一張卡片；2026-11-19 曾因部署本資料夾而蓋掉正式版，害 Chat 被洗版。
//   部署本資料夾一律只指定 callGemini：firebase deploy --only functions:callGemini --project class-4719f --account cagooo@gmail.com

exports.callGemini = onCall(
  {
    region: REGION,
    secrets: [GEMINI_API_KEY, GOOGLE_CHAT_WEBHOOK],
    cors: true,
    maxInstances: 10,
    timeoutSeconds: 120,
    memory: '512MiB',
  },
  async (request) => {
    const data = request.data || {};
    const feature = aiFeatureLabel(data);
    const classroom = cleanText(data.classroom, 30);

    // 🆕 [V4.5.0] 只有用 Google 帳號登入的老師能用（沒登入、匿名登入一律拒絕）
    if (!isGoogleTeacher(request.auth)) {
      const ip = requestIp(request);
      const reason = !request.auth ? '沒有登入' : `非 Google 登入（${clip(request.auth.token?.firebase?.sign_in_provider, 20) || '未知'}）`;
      logger.warn('callGemini 擋下未登入呼叫', { reason, feature });
      if (shouldNotifyBlocked(ip, getClientKey(request))) {
        await postAiChat('blocked', { reason, ip: maskIp(ip), feature, classroom });
      }
      throw new HttpsError('unauthenticated', '請老師先用 Google 帳號登入才能使用 AI 功能');
    }

    const token = request.auth.token || {};
    const teacher = [token.name, token.email].filter(Boolean).join(' · ') || '（未提供姓名）';
    const topic = cleanTopic(data.topic);
    const startedAt = Date.now();
    let usedModel = '';
    let remaining;
    const notifyInfo = () => ({ teacher, feature, topic, classroom, model: usedModel, durationMs: Date.now() - startedAt, remaining });
    const dateKey = taipeiDateKey();
    let quotaReserved = false;

    try {
      const apiKey = (GEMINI_API_KEY.value() || '').trim();
      if (!apiKey) {
        logger.error('GEMINI_API_KEY secret 未設定');
        throw new HttpsError('failed-precondition', 'AI 服務尚未完成設定，請稍後再試。');
      }

      const payload = data.payload;
      assertGeminiPayload(payload);

      // 🆕 [V4.5.1] 每人每天 3 次（台北時間午夜重置；V4.5.10 由 5 次下修）
      const quota = await reserveAiQuota(request, dateKey);
      if (!quota.ok) {
        await postAiChat('quota', { teacher, feature, topic, classroom, remaining: 0 });
        throw Object.assign(
          new HttpsError('resource-exhausted', AI_QUOTA_EXCEEDED_MSG, quota),
          { alreadyNotified: true }
        );
      }
      quotaReserved = true;
      remaining = quota.remaining;

      let lastError = new HttpsError('internal', 'AI 服務暫時無法使用，請稍後再試。');

      for (const model of geminiModelChain(data.model)) {
        usedModel = model;
        let resp;
        let body = null;
        try {
          resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
              // Some existing Gemini keys are protected by browser referrer rules.
              'Referer': 'https://cagoooo.github.io/',
            },
            body: JSON.stringify(payload),
          });
          const bodyText = await resp.text();
          try {
            body = bodyText ? JSON.parse(bodyText) : {};
          } catch (err) {
            body = { raw: bodyText.slice(0, 1000) };
          }
        } catch (err) {
          logger.error('Gemini proxy failed', { model, message: err.message });
          continue; // 網路錯誤：換下一個模型試
        }

        if (resp.ok) {
          logger.info('Gemini proxy success', {
            model,
            remaining: quota.remaining,
            feature,
            classroom,
          });
          await postAiChat('success', notifyInfo());
          return { ok: true, data: body, quota, model };
        }

        logger.warn('Gemini API 回傳錯誤', { status: resp.status, model, feature, classroom });
        lastError = new HttpsError('internal', body?.error?.message || `Gemini API 請求失敗：${resp.status}`, {
          status: resp.status,
          body,
        });
        // 只有模型滿載／不存在／暫時性錯誤才換下一個模型；金鑰或額度問題（400/402/403）直接回報
        if (!RETRYABLE_GEMINI_STATUS.includes(resp.status)) break;
      }

      throw lastError;
    } catch (err) {
      if (err && err.alreadyNotified) throw err;
      if (quotaReserved) {
        await refundAiQuota(request.auth.uid, dateKey);
        remaining += 1;
      }
      await postAiChat('failure', Object.assign(notifyInfo(), { error: clip(err && err.message, 120) || '未知錯誤' }));
      throw err;
    }
  }
);
