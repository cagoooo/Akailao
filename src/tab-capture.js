// 🆕 [V4.7.0] 網站版「擷取分頁畫面」：老師不用裝擴充套件，也能直接抓 Chrome 分頁／視窗的畫面，
// 框選要的範圍（或整張）後當成閱讀題組的圖片。做法同 PIRLS 小幫手 v0.4.2（web-tab-capture-crop）。
// - getDisplayMedia 只抓一張畫面就停止分享（上方「正在分享」提示列馬上消失）
// - CaptureController.setFocusBehavior('no-focus-change')：選好分頁後留在剛好學，直接框選
// - 使用者在 Chrome 選單按「取消」→ 安靜結束，不跳錯誤

/** 這台裝置能不能用（手機平板、被嵌在擴充套件側邊欄裡都不顯示按鈕） */
export function canCaptureTab() {
    try {
        if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') return false;
        if (navigator.userAgentData?.mobile) return false;
        if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return false;
        // iPadOS 會假裝成 Mac：有觸控點的 Mac 視為平板
        if (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) return false;
        if (window.top !== window.self) return false; // 擴充套件側邊欄有自己的「📸 截圖」
        return true;
    } catch (_) {
        return false;
    }
}

async function grabOneFrame() {
    const Ctor = window.CaptureController;
    const controller = Ctor ? new Ctor() : undefined;
    const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', frameRate: 5 },
        audio: false,
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
        ...(controller ? { controller } : {}),
    });
    // 要在 promise 完成後馬上呼叫，Chrome 才會留在原本的網站
    try { controller?.setFocusBehavior?.('no-focus-change'); } catch (_) { /* 舊版 Chrome 沒有 */ }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    try {
        video.srcObject = stream;
        await video.play();
        await new Promise(resolve => {
            const done = () => resolve();
            const safety = setTimeout(done, 1500);
            if (typeof video.requestVideoFrameCallback === 'function') {
                video.requestVideoFrameCallback(() => { clearTimeout(safety); done(); });
            } else {
                setTimeout(() => { clearTimeout(safety); done(); }, 300);
            }
        });
        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) throw new Error('沒有抓到畫面');
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        return canvas;
    } finally {
        stream.getTracks().forEach(t => t.stop());
        video.srcObject = null;
    }
}

function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('圖片轉換失敗'))), 'image/png');
    });
}

function timeTag() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join('');
}

/** 框選視窗：回傳 { action: 'full' | 'crop' | 'retake' | 'cancel', rect } */
function showCropDialog(canvas) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'tabcap-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', '框選要用的範圍');
        overlay.innerHTML = `
            <div class="tabcap-dialog">
                <div class="tabcap-head">
                    <strong>✂️ 框選要出題的範圍</strong>
                    <span>用滑鼠拖曳框出文章，或直接用整張畫面</span>
                </div>
                <div class="tabcap-stage"><div class="tabcap-frame"><img alt="擷取到的畫面" draggable="false"><div class="tabcap-sel hidden"></div></div></div>
                <div class="tabcap-actions">
                    <button type="button" data-act="cancel" class="tabcap-btn">取消</button>
                    <button type="button" data-act="retake" class="tabcap-btn">🔄 重新擷取</button>
                    <button type="button" data-act="full" class="tabcap-btn tabcap-btn-soft">🖼️ 使用整張畫面</button>
                    <button type="button" data-act="crop" class="tabcap-btn tabcap-btn-main" disabled>✂️ 使用框選範圍</button>
                </div>
            </div>`;
        const img = overlay.querySelector('img');
        const frame = overlay.querySelector('.tabcap-frame');
        const sel = overlay.querySelector('.tabcap-sel');
        const cropBtn = overlay.querySelector('[data-act="crop"]');
        img.src = canvas.toDataURL('image/png');

        let start = null, rect = null; // rect：以顯示中的圖片座標（px）
        const point = (e) => {
            const r = img.getBoundingClientRect();
            return {
                x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
                y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
            };
        };
        const draw = () => {
            if (!rect) { sel.classList.add('hidden'); return; }
            sel.classList.remove('hidden');
            Object.assign(sel.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
        };
        frame.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            frame.setPointerCapture?.(e.pointerId);
            start = point(e);
            rect = { x: start.x, y: start.y, w: 0, h: 0 };
            draw();
            cropBtn.disabled = true;
        });
        frame.addEventListener('pointermove', (e) => {
            if (!start) return;
            const p = point(e);
            rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
            draw();
        });
        const endDrag = () => {
            if (!start) return;
            start = null;
            if (!rect || rect.w < 16 || rect.h < 16) { rect = null; draw(); } // 只點一下不算框選
            cropBtn.disabled = !rect;
        };
        frame.addEventListener('pointerup', endDrag);
        frame.addEventListener('pointercancel', endDrag);

        const close = (action) => {
            let out = null;
            if (action === 'crop' && rect) {
                const scale = canvas.width / img.getBoundingClientRect().width;
                out = {
                    x: Math.round(rect.x * scale), y: Math.round(rect.y * scale),
                    w: Math.round(rect.w * scale), h: Math.round(rect.h * scale),
                };
            }
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve({ action, rect: out });
        };
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close('cancel'); } };
        document.addEventListener('keydown', onKey, true);
        overlay.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => close(b.dataset.act)));
        document.body.appendChild(overlay);
        overlay.querySelector('[data-act="full"]').focus();
    });
}

/**
 * 擷取一個分頁畫面並讓使用者框選。
 * @returns {Promise<{blob: Blob, name: string} | null>} 使用者取消時回傳 null
 */
export async function captureTabImage() {
    for (;;) {
        let canvas;
        try {
            canvas = await grabOneFrame();
        } catch (e) {
            if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return null; // 按了取消
            throw e;
        }
        const { action, rect } = await showCropDialog(canvas);
        if (action === 'cancel') return null;
        if (action === 'retake') continue;
        let out = canvas;
        if (action === 'crop' && rect && rect.w > 0 && rect.h > 0) {
            out = document.createElement('canvas');
            out.width = rect.w;
            out.height = rect.h;
            out.getContext('2d').drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
        }
        return { blob: await canvasToBlob(out), name: `分頁擷取-${timeTag()}.png` };
    }
}
