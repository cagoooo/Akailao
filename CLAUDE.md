# 剛好學（Akailao）— 專案開發指南

## 專案概述
- **用途**：國小課堂互動工具（13 種互動模式 + AI 出題 + 即時排行榜）
- **架構**：Vite 構建 → 單一 HTML 輸出 + Firebase Firestore 後端 + GitHub Pages 部署
- **版本**：V4.3.0+（V4.3.0 新增 Chrome 擴充套件）；V3.9.4+（V3.9.x 為三大入口頁 + set.html + 學生中斷彈窗「黑板筆記版」全新視覺；版本徽章 build-time 自動同步）
- **Firebase 專案 ID**：`class-4719f`
- **GitHub Pages**：https://cagoooo.github.io/Akailao/

## 專案結構（V3.8.25 Vite 架構）

```
H:/Akailao/
├── index.html              # HTML 模板（~3,000 行，純結構）
├── src/
│   ├── app.js              # 全部 JavaScript（~19,300 行）
│   └── styles.css          # 全部 CSS（~2,900 行）
├── dist/                   # Vite 構建輸出（單一 HTML，不 commit）
│   └── index.html          # 構建產物（JS/CSS 內聯，gzip ~291KB）
├── chrome-extension/       # 🆕 V4.3.0 Chrome 擴充套件（側邊欄 iframe + 分頁出閱讀測驗，見其 README）
├── set.html                # Firebase 配置生成器（老師下載用）
├── firestore.rules         # Firestore 安全規則
├── vite.config.mjs         # Vite 構建配置
├── package.json            # npm 依賴 + 腳本
├── tailwind.input.css      # Tailwind v4 入口 CSS
├── tailwind-build.css      # Tailwind 預編譯產出
├── .env                    # 本地 API Keys（不可 commit）
├── .github/
│   ├── workflows/deploy.yml # GitHub Actions 部署流程
│   └── inject.py           # API Keys 注入腳本（備用）
├── CLAUDE.md               # 本文件
└── DEVELOPMENT_PROGRESS.md # 開發進度與路線圖
```

## 開發流程

### 本地開發（推薦）
```bash
cd H:/Akailao

# 啟動 Vite 開發伺服器（熱更新）
npm run dev
# → 瀏覽器自動開啟 http://localhost:8080

# 或手動構建 + 預覽
npm run build      # 輸出 dist/index.html
npm run preview    # 預覽構建結果
```

### 舊式本地測試（不使用 Vite）
```bash
cd H:/Akailao
# 產生注入副本
python -c "
import os, sys
sys.stdout.reconfigure(encoding='utf-8')
env = {}
with open('.env', 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if line and '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
for src, dst in [('index.html', 'index.local.html'), ('set.html', 'set.local.html')]:
    with open(src, 'r', encoding='utf-8') as f:
        content = f.read()
    content = content.replace('__FIREBASE_API_KEY__', env.get('FIREBASE_API_KEY', ''))
    content = content.replace('__GEMINI_API_KEY__', env.get('GEMINI_API_KEY', ''))
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'{src} -> {dst} ({len(content)} bytes)')
"
python -m http.server 8080 --bind 127.0.0.1
# → http://localhost:8080/index.local.html
```

## 部署流程

### 1. GitHub Pages 部署（前端）
- **觸發**：push 到 `main` branch 自動觸發 GitHub Actions
- **流程**：`.github/workflows/deploy.yml`
  1. `npm ci` 安裝依賴
  2. `npm run build`（Vite 構建，API Keys 透過環境變數注入）
  3. 複製 `set.html`、`icons/`、`manifest.json` 等靜態資源到 `dist/`
  4. upload + deploy `dist/` 到 GitHub Pages
- **API Keys 注入**：Vite 構建時透過 `vite.config.mjs` 的 `define` 讀取環境變數
  - 本地：從 `.env` 讀取（`FIREBASE_API_KEY=xxx`）
  - GitHub Actions：從 Secrets 讀取（`${{ secrets.FIREBASE_API_KEY }}`）

### 2. Firestore Rules 部署（安全規則）
- **何時需要**：修改 `firestore.rules` 後
- **指令**：
  ```bash
  cd H:/Akailao
  firebase deploy --only firestore:rules --project class-4719f
  ```
- **驗證**：https://console.firebase.google.com/project/class-4719f/firestore/rules
- **注意**：GitHub Actions 不會自動部署 Firestore Rules，需手動執行
- ⚠️ **規則正本在這裡**：`H:\Class`（班級小管家）的 `firebase.json` 也指向同一個資料庫，兩個網站共用同一份規則（含班級小管家的 `petShares` 寵物分享）。
  - 改規則一律改 `H:\Akailao\firestore.rules`、從這裡部署，再 `cp` 到 `H:\Class\firestore.rules`，兩份必須 `cmp` 完全相同。
  - 班級小管家那邊的對應說明：`H:\Class\CLAUDE.md`（共用的規則、函式、登入設定、瀏覽器名稱前綴）。
  - 2026-11-21 同步時發現：剛好學 V4.6.0 起部署的規則沒有 `petShares`，班級小管家寵物分享連結被擋（403）；已併入並部署，恢復為 404（找不到）＝放行。
  - 部署前跑模擬資料庫測試：`cd tests/firestore-rules && npm install && npm test`（2026-11-24 起放進 repo，13 項，涵蓋兩個網站：教室與代碼、保留代碼、班級小管家的老師資料與寵物分享、後端專用資料；只連本機模擬資料庫）。
  - 2026-11-24：教室（`classrooms`）與教室代碼（`classroomClaims`）改成只能用代碼查單一筆，不能列出全部；保留代碼要求 Google 驗證過的信箱。前端不要新增「列出全部教室」的查詢，會被規則擋下。
  - 部署前先確認線上規則和 repo 上一版相同（沒有人另外部署過）；線上規則可用 Firebase Rules API 讀出來比對，回傳內容要存檔後用 UTF-8 讀，直接接到 Python 會被 Windows 的編碼讀錯而誤判成不同。

### 2.5 Cloud Functions 部署（⚠️ 與班級小管家共用專案）
- `class-4719f` 同時放剛好學與班級小管家（`H:\Class`）的 Cloud Functions，兩邊 `functions/` 都用 codebase `default`。
- **剛好學這邊只部署 callGemini**：`firebase deploy --only functions:callGemini --project class-4719f --account cagooo@gmail.com`
- `notifyUsage`、`dailyUsageDigest` 等的正本在 `H:\Class\functions`（成功事件只留底給每日戰報，錯誤才即時推 Chat）。不要在這裡跑 `--only functions`，會蓋掉或刪掉班級小管家的函式（2026-11-19 曾因此每個學生登入都推一張 Chat 卡片）。
- 部署規則與函式都要加 `--account cagooo@gmail.com`；函式探索逾時加 `FUNCTIONS_DISCOVERY_TIMEOUT=60`。

### 3. Tailwind CSS 重建
- **何時需要**：修改 `index.html` 或 `src/styles.css` 中的 Tailwind class 後
- **指令**：
  ```bash
  npm run build:css
  ```
- **注意**：Vite 構建時不會重建 Tailwind，需先手動執行

## 重要檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | HTML 模板（引用 `src/app.js` 和 `src/styles.css`） |
| `src/app.js` | 全部 JavaScript（Firebase npm + 13 個互動模式邏輯） |
| `src/styles.css` | 全部 CSS（含 `.hidden` !important 修復） |
| `vite.config.mjs` | Vite 構建配置（API Key 注入 + 單一檔案輸出） |
| `set.html` | Firebase 配置生成器（老師下載用） |
| `firestore.rules` | Firestore 安全規則（8 個子集合獨立權限） |
| `tailwind-build.css` | Tailwind 預編譯產出（commit 進 git） |
| `.env` | 本地 API Keys（`FIREBASE_API_KEY` / `GEMINI_API_KEY`，不可 commit） |
| `.github/inject.py` | 部署時注入 API Keys（Vite 的備用方案） |

## CSS 注意事項

### .hidden class 衝突（V3.8.17 修復）
- Tailwind 的 `.hidden { display: none }` 在 `<link>` 載入
- `src/styles.css` 的 `.btn { display: inline-flex }` 在後載入
- **source order 後者勝** → `.btn.hidden` 仍然可見
- **解法**：`src/styles.css` 最頂端有 `[class~="hidden"] { display: none !important }`
- **新增 CSS class 有 `display:*` 時務必確認不會覆蓋 `.hidden`**

### showView / setInteractionMode 呼叫順序
- `showView('teacherMonitor')` 內會呼叫 `hideAllOptionalButtons()`
- **必須在 `setInteractionMode()` 之前呼叫**，否則按鈕會消失
- 閱讀測驗 V3.8.21 已修復此順序

## 安全設計

### 答案防偷看（SEC-1）
- 學生端 `readingComprehensionData.questions[].correctAnswer` 在渲染後 1 秒被 `delete`
- 真正的答案存在閉包變數 `_secureAnswerKey`
- DevTools Console 看不到，但 Network tab 仍可看到 Firestore snapshot
- 完全防護需 Firebase Functions（Blaze 方案）

### 防重複提交（SEC-2）
- 前端 flag `_hasSubmittedThisRound`，模式切換時重置
- Firestore Rules 已設定細粒度權限

### Firebase Config 注入（V3.8.25）
- `src/app.js` 使用 `import.meta.env.VITE_FIREBASE_API_KEY`
- Vite 構建時透過 `vite.config.mjs` 的 `define` 替換為實際值
- 本地開發：`.env` 中的 `FIREBASE_API_KEY` 自動映射
- 線上部署：GitHub Secrets 環境變數自動注入

## 命名規範
- 變數：camelCase（`currentInteractionMode`）
- 常數：UPPER_CASE（`READING_MIN_DURATION_MS`）
- 模組：IIFE pattern（`const ModuleName = (() => { ... return { api }; })()`）
- 版本註解：`// 🆕 NEW [vX.Y.Z]: 描述`
- commit message：emoji + 版本 + 描述（`🎉 V3.8.22：...`）

## 13 種互動模式

| 代碼 | 模式名稱 | 按鈕位置 |
|------|----------|----------|
| `true_false` | 是非題 | A |
| `multiple_choice` | 選擇題 | B（子選單） |
| `sequencing` | 排序題 | B（子選單） |
| `matching` | 配對題 | B（子選單） |
| `text_input` | 文字題 | C |
| `drawing` | 繪圖題 | D |
| `url_dispatch` | 派送網址/HTML | E |
| `recording` | 錄音題 | F |
| `reading_comprehension` | 閱讀測驗 | G |
| `quick_answer` | 搶答 | H |
| `quick_poll` | 快速投票 | I |
| `team_battle` | 分組競賽 | J |
| `word_cloud` | 文字雲 | K |
| `photo_wall` | 相片牆 | L |
| `course_feedback` | 課後回饋 | M |
