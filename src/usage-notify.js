import { getFunctions, httpsCallable } from "firebase/functions";

const REGION = 'asia-east1';
const FN_NAME = 'notifyUsage';
const QKEY = 'un_queue_v1';
const SS = 'un_';
const MAX_QUEUE = 50;
const MAX_ERRORS_PER_SESSION = 5;

let callableFn = null;
let flushing = false;
let errCount = 0;

/**
 * 初始化前端遙測通知服務。
 * @param {import("firebase/app").FirebaseApp} app Firebase App 實例
 */
export function initUsageNotify(app) {
    try {
        const functions = getFunctions(app, REGION);
        callableFn = httpsCallable(functions, FN_NAME);
        
        // 確保在 Service Worker 或網路就緒後自動補發先前佇列中的事件
        setTimeout(flush, 2000);
    } catch (e) {
        console.warn("[UsageNotify] 初始化遙測通知失敗，請確認 Firebase SDK 是否完整：", e);
    }
}

function ssOnce(key) {
    try {
        if (sessionStorage.getItem(SS + key)) return false;
        sessionStorage.setItem(SS + key, '1');
        return true;
    } catch (e) {
        return true;
    }
}

function loadQ() {
    try {
        return JSON.parse(localStorage.getItem(QKEY) || '[]');
    } catch (e) {
        return [];
    }
}

function saveQ(q) {
    try {
        localStorage.setItem(QKEY, JSON.stringify(q.slice(-MAX_QUEUE)));
    } catch (e) {}
}

export function enqueue(type, data) {
    const ev = Object.assign({
        type: type,
        ts: new Date().toISOString(),
        ua: navigator.userAgent
    }, data || {});
    ev._id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const q = loadQ();
    q.push(ev);
    saveQ(q);
    flush();
}

async function flush() {
    if (flushing || !callableFn) return;
    flushing = true;
    
    try {
        while (true) {
            const q = loadQ();
            if (q.length === 0) break;
            
            const ev = q[0];
            const payload = {};
            for (const k in ev) {
                if (k !== '_id') payload[k] = ev[k];
            }
            
            try {
                await callableFn(payload);
                const cur = loadQ().filter(x => x._id !== ev._id);
                saveQ(cur);
            } catch (e) {
                console.warn("[UsageNotify] 發送遙測通知失敗，將於下次連線時重試:", e);
                break; // 網路錯誤中斷，保留佇列
            }
        }
    } finally {
        flushing = false;
    }
}

function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
}

export const UsageNotify = {
    sessionStart(role, classroom) {
        if (ssOnce('session')) {
            enqueue('session_start', { role, classroom });
        } else {
            flush();
        }
    },
    
    login(role, name, classroom) {
        const key = `${role}_${name || 'x'}_${classroom || 'x'}`;
        if (!ssOnce('login_' + hash(key))) return;
        enqueue('login', { role, name, classroom });
    },
    
    create(classroom) {
        enqueue('create', { role: 'teacher', classroom });
    },
    
    feature(name, label, classroom) {
        if (!name) return;
        if (!ssOnce('feat_' + name)) return;
        enqueue('feature', { feature: name, label: label || name, classroom });
    },
    
    error(message, context, classroom) {
        message = String(message == null ? '' : message).slice(0, 300);
        if (!message) return;
        if (errCount >= MAX_ERRORS_PER_SESSION) return;
        if (!ssOnce('err_' + hash(message))) return;
        errCount++;
        enqueue('error', { message, context: String(context == null ? '' : context).slice(0, 160), classroom });
    },

    // 每次 AI API 呼叫成功都送出（不做 ssOnce 去重，用於統計用量與頻率）
    aiApi(feature, label, details, classroom) {
        if (!feature) return;
        enqueue('ai_api', Object.assign({ feature, label: label || feature, classroom }, details || {}));
    }
};

window.UsageNotify = UsageNotify;
