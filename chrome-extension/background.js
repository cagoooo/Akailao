// 剛好學擴充套件：背景服務（右鍵選單、開啟側邊欄）
import { extractPageContent } from './extract.js';

const MENU = {
  readingSelection: 'akailao-reading-selection',
  readingPage: 'akailao-reading-page',
  dispatchPage: 'akailao-dispatch-page',
  dispatchLink: 'akailao-dispatch-link'
};

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.readingSelection, title: '📖 用選取文字出閱讀測驗', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU.readingPage, title: '📖 用這個網頁出閱讀測驗', contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU.dispatchPage, title: '🔗 把這個網頁派送給學生', contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU.dispatchLink, title: '🔗 把這個連結派送給學生', contexts: ['link'] });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  setupMenus();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// 把動作放到 session storage，側邊欄開啟後會自動接手
async function queueAction(action) {
  await chrome.storage.session.set({ pendingAction: { ...action, ts: Date.now() } });
}

async function readPage(tabId) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageContent });
  return res?.result;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id === undefined) return;
  // ⚠️ sidePanel.open 必須在使用者操作的當下呼叫，不能放在 await 之後
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => console.warn('[剛好學] 無法開啟側邊欄', e));

  (async () => {
    try {
      if (info.menuItemId === MENU.readingSelection || info.menuItemId === MENU.readingPage) {
        let content = null;
        try {
          content = await readPage(tab.id);
        } catch (e) {
          // 無法注入的頁面（例如 PDF）：選取文字仍可用右鍵選單提供的內容
          if (!info.selectionText) throw e;
        }
        if (info.menuItemId === MENU.readingSelection && (!content || content.kind !== 'selection')) {
          content = { kind: 'selection', text: info.selectionText || '', title: tab.title || '', url: tab.url || '' };
        }
        await queueAction({ type: 'reading-text', content });
      } else if (info.menuItemId === MENU.dispatchPage) {
        await queueAction({ type: 'dispatch-url', url: info.pageUrl || tab.url, title: tab.title || '' });
      } else if (info.menuItemId === MENU.dispatchLink) {
        await queueAction({ type: 'dispatch-url', url: info.linkUrl, title: info.selectionText || info.linkUrl });
      }
    } catch (e) {
      await queueAction({ type: 'error', message: '這個頁面不允許擴充套件讀取文字（例如 Chrome 內建頁面、PDF 或線上應用程式商店）。請改用側邊欄的「📸 截圖」出題。' });
    }
  })();
});
