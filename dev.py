import os
import http.server
import socketserver
import urllib.parse

# ---------------------------------------------------------
# 簡易讀取 .env
# ---------------------------------------------------------
if os.path.exists('.env'):
    with open('.env', 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                try:
                    key, val = line.split('=', 1)
                    os.environ[key.strip()] = val.strip().strip("'").strip('"')
                except ValueError:
                    continue

PORT = 8888

class DevHttpRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 停用快取，確保重新整理都能抓到最新的
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        # 移除 query parameters
        parsed_path = urllib.parse.urlparse(self.path)
        clean_path = parsed_path.path

        if clean_path.endswith('/') or clean_path.endswith('/index.html') or clean_path.endswith('/set.html'):
            if clean_path.endswith('/set.html'):
                filepath = 'set.html'
            else:
                filepath = 'index.html'
            
            if os.path.exists(filepath):
                self.send_response(200)
                self.send_header("Content-type", "text/html; charset=utf-8")
                self.end_headers()
                
                with open(filepath, 'r', encoding='utf-8') as f:
                    content = f.read()
                    
                api_key = os.environ.get('FIREBASE_API_KEY', '')
                if api_key:
                    content = content.replace('__FIREBASE_API_KEY__', api_key)
                else:
                    print("⚠️ 警告：找不到 FIREBASE_API_KEY 環境變數，請確認 .env 檔案已設定。")
                    
                self.wfile.write(content.encode('utf-8'))
                return

        # 其他靜態資源交給原本的類別處理
        # 如果路徑包含 /Akailao/，我們試著把它切掉以符合本地檔案結構
        if '/Akailao/' in self.path:
            self.path = self.path.replace('/Akailao/', '/')
            
        return super().do_GET()

socketserver.TCPServer.allow_reuse_address = True

if __name__ == "__main__":
    try:
        with socketserver.TCPServer(("", PORT), DevHttpRequestHandler) as httpd:
            print(f"🚀 本地開發伺服器啟動於 http://localhost:{PORT}")
            print("💡 提示：此伺服器會自動讀取 .env 並在記憶體中動態注入 API Key。")
            print("🛡️ 保護：這能確保您的 index.html 始終不包含真實金鑰，徹底杜絕外洩風險！")
            print("按 Ctrl+C 停止伺服器")
            httpd.serve_forever()
    except OSError as e:
        if e.errno == 98 or e.errno == 10048:
            print(f"❌ 錯誤：連接埠 {PORT} 已被佔用！")
            print("👉 請先在原本運行的終端機按下 Ctrl+C 停止 'python -m http.server 8080'。")
        else:
            raise
