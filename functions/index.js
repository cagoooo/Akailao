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

const { onCall } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

const GOOGLE_CHAT_WEBHOOK = defineSecret('GOOGLE_CHAT_WEBHOOK');
const REGION = 'asia-east1';

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

exports.notifyUsage = onCall(
  { region: REGION, secrets: [GOOGLE_CHAT_WEBHOOK], cors: true, maxInstances: 5 },
  async (request) => {
    const webhook = (GOOGLE_CHAT_WEBHOOK.value() || '').trim();
    if (!webhook) {
      logger.warn('GOOGLE_CHAT_WEBHOOK 未設定');
      return { ok: false, reason: 'no-webhook' };
    }
    
    const data = request.data || {};
    const type = String(data.type || '').trim();
    if (!EVENT_META[type]) {
      return { ok: false, reason: 'unknown-type' };
    }
    
    const who = identityOf(request.auth, data);
    
    try {
      const resp = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(buildCard(type, data, who)),
      });
      if (!resp.ok) {
        logger.error('Google Chat API 回傳錯誤', { status: resp.status });
        return { ok: false, status: resp.status };
      }
      return { ok: true };
    } catch (err) {
      logger.error('Google Chat 推送失敗', err);
      return { ok: false, reason: 'fetch-failed' };
    }
  }
);
