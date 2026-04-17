import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import fs from 'fs';

// 🆕 [v3.8.25] D-1: Vite 構建配置
// 讀取 .env 文件（兼容既有格式）
function loadDotEnv() {
    const vars = {};
    try {
        const content = fs.readFileSync('.env', 'utf8');
        content.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const [key, ...rest] = trimmed.split('=');
                vars[key.trim()] = rest.join('=').trim();
            }
        });
    } catch (e) {
        // .env not found, use process.env
    }
    return vars;
}

export default defineConfig(({ mode }) => {
    const dotEnv = loadDotEnv();

    // 將 .env 的 FIREBASE_API_KEY 映射到 VITE_FIREBASE_API_KEY
    // 優先級: process.env > .env > placeholder
    const firebaseKey = process.env.VITE_FIREBASE_API_KEY
        || process.env.FIREBASE_API_KEY
        || dotEnv.FIREBASE_API_KEY
        || '__FIREBASE_API_KEY__';
    const geminiKey = process.env.VITE_GEMINI_API_KEY
        || process.env.GEMINI_API_KEY
        || dotEnv.GEMINI_API_KEY
        || '__GEMINI_API_KEY__';

    return {
        // 開發伺服器配置
        server: {
            port: 8080,
            open: '/index.html'
        },

        // 構建配置
        build: {
            target: 'es2020',
            outDir: 'dist',
            // 不拆分 chunks（單一檔案輸出）
            codeSplitting: false
        },

        // 環境變數注入（替換 import.meta.env.VITE_*）
        define: {
            'import.meta.env.VITE_FIREBASE_API_KEY': JSON.stringify(firebaseKey),
            'import.meta.env.VITE_GEMINI_API_KEY': JSON.stringify(geminiKey),
        },

        // 插件
        plugins: [
            // 將所有 JS/CSS 內聯回 HTML（輸出單一檔案）
            viteSingleFile()
        ]
    };
});
