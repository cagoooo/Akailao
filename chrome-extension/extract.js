// 剛好學擴充套件：擷取網頁內容
// ⚠️ extractPageContent 會被 chrome.scripting.executeScript 注入到網頁裡執行，
//    函式內不可使用外部變數或 import，所有邏輯都要寫在函式本體內。

export function extractPageContent() {
  const title = (document.querySelector('meta[property="og:title"]')?.content || document.title || '').trim();
  const url = location.href;

  const clean = (t) => String(t || '')
    .replace(/\[(\d+|註\s*\d+|編輯|edit)\]/gi, '') // 維基百科等的註腳標記
    .replace(/[ \t 　]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 1) 老師有選取文字 → 以選取內容為準
  const selection = String(window.getSelection ? window.getSelection() : '').trim();
  if (selection.length >= 30) {
    return { kind: 'selection', text: clean(selection), title, url };
  }

  // 2) 找出文章主體：比較常見容器與「段落最多的父元素」
  const SKIP = 'script,style,noscript,nav,header,footer,aside,form,button,select,textarea,iframe,svg,canvas,'
    + '[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[aria-hidden="true"],'
    + '.infobox,.navbox,.metadata,.ambox,.hatnote,.reference,.references,.mw-references-wrap,.mw-editsection,.toc,#toc,'
    + '.sidebar,.breadcrumb,.share,.social,.comments,#comments,.ad,.ads,.advertisement';

  const visible = (el) => {
    if (typeof el.checkVisibility === 'function') return el.checkVisibility();
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  };
  const paragraphScore = (root) => {
    let score = 0;
    root.querySelectorAll('p').forEach((p) => {
      if (p.closest(SKIP)) return;
      const len = (p.innerText || '').trim().length;
      if (len > 15) score += len;
    });
    return score;
  };

  let best = null;
  let bestScore = 0;
  const candidates = document.querySelectorAll(
    'article, main, [role="main"], #mw-content-text, .entry-content, .post-content, .article-content, .article, .post, #content, .content, #main'
  );
  candidates.forEach((el) => {
    const s = paragraphScore(el);
    if (s > bestScore) { best = el; bestScore = s; }
  });

  const parentScores = new Map();
  document.querySelectorAll('p').forEach((p) => {
    if (p.closest(SKIP) || !p.parentElement) return;
    const len = (p.innerText || '').trim().length;
    if (len > 15) parentScores.set(p.parentElement, (parentScores.get(p.parentElement) || 0) + len);
  });
  parentScores.forEach((s, el) => {
    // 父元素得分明顯高於候選容器時才換（避免抓到太小的區塊）
    if (s > bestScore * 1.2) { best = el; bestScore = s; }
  });

  const root = best || document.body;

  // 3) 依區塊收集文字，保留段落換行
  const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dd,dt';
  const parts = [];
  root.querySelectorAll(BLOCKS).forEach((el) => {
    if (el.closest(SKIP) || !visible(el)) return;
    // 巢狀區塊（例如 li 裡的 p）只取最內層，避免重複
    if (el.querySelector(BLOCKS)) return;
    const t = (el.innerText || '').trim();
    if (t.length >= 2) parts.push(t);
  });
  let text = clean(parts.join('\n'));

  // 4) 區塊抓不到東西（很多中文網站用 div 排版）→ 改用整塊 innerText
  if (text.length < 200) {
    const fallback = clean(root.innerText || document.body.innerText || '');
    if (fallback.length > text.length) text = fallback;
  }

  return { kind: 'page', text, title, url };
}
