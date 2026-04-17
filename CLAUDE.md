# 剛好學（Akailao）— 專案開發指南

## 專案概述
- **用途**：國小課堂互動工具（9 種互動模式 + AI 出題 + 即時排行榜）
- **架構**：單一 HTML 檔（index.html ~24,000 行）+ Firebase Firestore 後端 + GitHub Pages 部署
- **版本**：V3.8.25+
- **Firebase 專案 ID**：`class-4719f`
- **GitHub Pages**：https://cagoooo.github.io/Akailao/

## 部署流程

### 1. GitHub Pages 部署（前端）
- **觸發**：push 到 `main` branch 自動觸發 GitHub Actions
- **流程**：`.github/workflows/deploy.yml`
  1. checkout 程式碼
  2. `python .github/inject.py` 注入 API Keys（從 GitHub Secrets）
  3. `npx tailwindcss -i tailwind.input.css -o tailwind-build.css --minify`（Tailwind 重建）
  4. upload + deploy 到 GitHub Pages
- **API Keys**：存在 `.env`（本地）和 GitHub Secrets（線上），佔位符為 `__FIREBASE_API_KEY__` / `__GEMINI_API_KEY__`

### 2. Firestore Rules 部署（安全規則）
- **何時需要**：修改 `firestore.rules` 後
- **指令**：
  ```bash
  cd H:/Akailao
  firebase deploy --only firestore:rules --project class-4719f
  ```
- **驗證**：https://console.firebase.google.com/project/class-4719f/firestore/rules
- **注意**：GitHub Actions 不會自動部署 Firestore Rules，需手動執行

### 3. Tailwind CSS 重建
- **何時需要**：修改 index.html 或 set.html 中的 Tailwind class 後
- **指令**：
  ```bash
  npm run build:css
  # 或即時監聽
  npm run watch:css
  ```
- **產出**：`tailwind-build.css`（69KB minified）
- **來源**：`tailwind.input.css`（含 `@source` 指令指定掃描範圍）
- **GitHub Actions 雙保險**：即使本地忘記 build，Actions 會重建

### 4. 本地測試
- **產生注入副本**（不污染原始 index.html）：
  ```bash
  cd H:/Akailao
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
  ```
- **啟動本地伺服器**：
  ```bash
  python -m http.server 8080 --bind 127.0.0.1
  ```
- **測試 URL**：http://localhost:8080/index.local.html
- **注意**：`*.local.html` 已在 `.gitignore` 中，不會被 commit

## 重要檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 主程式（全功能單頁應用） |
| `set.html` | Firebase 配置生成器（老師下載用） |
| `firestore.rules` | Firestore 安全規則 |
| `firestore.indexes.json` | Firestore 索引設定 |
| `tailwind.input.css` | Tailwind v4 入口 CSS |
| `tailwind-build.css` | Tailwind 預編譯產出（commit 進 git） |
| `.env` | 本地 API Keys（不可 commit） |
| `.github/inject.py` | 部署時注入 API Keys |
| `.github/revert.py` | 還原 API Keys 為佔位符 |
| `DEVELOPMENT_PROGRESS.md` | 開發進度與路線圖 |

## CSS 注意事項

### .hidden class 衝突（V3.8.17 修復）
- Tailwind 的 `.hidden { display: none }` 在 `<link>` 載入
- inline `<style>` 的 `.btn { display: inline-flex }` 在後載入
- **source order 後者勝** → `.btn.hidden` 仍然可見
- **解法**：inline `<style>` 最頂端有 `[class~="hidden"] { display: none !important }`
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

## 命名規範
- 變數：camelCase（`currentInteractionMode`）
- 常數：UPPER_CASE（`READING_MIN_DURATION_MS`）
- 模組：IIFE pattern（`const ModuleName = (() => { ... return { api }; })()`）
- 版本註解：`// 🆕 NEW [vX.Y.Z]: 描述`
- commit message：emoji + 版本 + 描述（`🎉 V3.8.22：...`）
