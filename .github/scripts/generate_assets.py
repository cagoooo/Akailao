#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
剛好學 — 圖示與社群卡片產生器
一次產出 favicon / apple-touch-icon / PWA icon / OG 社群分享圖。

用法：
    python .github/scripts/generate_assets.py

需求：Pillow >= 9（專案已有）
輸出：icons/*.png
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ICONS = os.path.join(ROOT, "icons")
os.makedirs(ICONS, exist_ok=True)

# --- 品牌色（與 index.html / src/styles.css 一致）---
INDIGO = (99, 102, 241)       # #6366f1
PURPLE = (168, 85, 247)       # #a855f7
PINK = (236, 72, 153)         # #ec4899
WHITE = (255, 255, 255)
YELLOW = (255, 217, 61)       # #ffd93d
GREEN = (127, 255, 127)       # #7fff7f (像素讀取條配色)
DARK = (15, 15, 35)           # #0f0f23


# --- 字體路徑（Windows）---
FONT_CJK_BOLD = "C:/Windows/Fonts/msjhbd.ttc"   # Microsoft JhengHei Bold
FONT_CJK_REG = "C:/Windows/Fonts/msjh.ttc"      # Microsoft JhengHei Regular
FONT_LATIN_BOLD = "C:/Windows/Fonts/arialbd.ttf"


def load_font(path, size, index=0):
    try:
        return ImageFont.truetype(path, size, index=index)
    except Exception:
        return ImageFont.load_default()


def gradient_background(w, h, c1, c2, direction="diag"):
    """產生 c1 → c2 漸層背景（diag 對角線、h 水平、v 垂直）"""
    img = Image.new("RGB", (w, h), c1)
    px = img.load()
    for y in range(h):
        for x in range(w):
            if direction == "diag":
                t = (x + y) / (w + h)
            elif direction == "h":
                t = x / w
            else:
                t = y / h
            r = int(c1[0] + (c2[0] - c1[0]) * t)
            g = int(c1[1] + (c2[1] - c1[1]) * t)
            b = int(c1[2] + (c2[2] - c1[2]) * t)
            px[x, y] = (r, g, b)
    return img


def rounded_mask(size, radius):
    """圓角遮罩"""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size, size], radius=radius, fill=255)
    return mask


def make_icon(size):
    """方形 PWA / Apple icon：漸層圓角方塊 + 「剛」字"""
    radius = int(size * 0.22)
    bg = gradient_background(size, size, INDIGO, PURPLE, "diag")
    mask = rounded_mask(size, radius)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(canvas)
    # 「剛」字大小：size 的 72%
    font_size = int(size * 0.72)
    font = load_font(FONT_CJK_BOLD, font_size)
    text = "剛"
    bbox = d.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    # 置中（考慮 bbox 偏移）
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1] - int(size * 0.03)

    # 陰影
    shadow_offset = max(1, int(size * 0.02))
    d.text((x + shadow_offset, y + shadow_offset), text, font=font, fill=(0, 0, 0, 80))
    d.text((x, y), text, font=font, fill=WHITE)
    return canvas


def make_og_image():
    """社群分享卡片 1200×630（LINE / Facebook / Twitter / Slack 通用）"""
    W, H = 1200, 630
    # 漸層底
    img = gradient_background(W, H, INDIGO, PURPLE, "diag")
    d = ImageDraw.Draw(img, "RGBA")

    # 角落光暈裝飾
    for cx, cy, r, a in [(1050, 120, 180, 50), (120, 520, 220, 40), (1080, 560, 140, 35)]:
        overlay = Image.new("RGBA", (r * 2, r * 2), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.ellipse([0, 0, r * 2, r * 2], fill=(255, 255, 255, a))
        img.paste(overlay, (cx - r, cy - r), overlay)

    # 主標題「剛好學」
    font_title = load_font(FONT_CJK_BOLD, 180)
    title = "剛好學"
    tb = d.textbbox((0, 0), title, font=font_title)
    tw = tb[2] - tb[0]
    tx = (W - tw) // 2 - tb[0]
    ty = 120
    # 陰影
    d.text((tx + 5, ty + 6), title, font=font_title, fill=(0, 0, 0, 110))
    d.text((tx, ty), title, font=font_title, fill=WHITE)

    # 副標：課堂互動 so easy
    font_sub = load_font(FONT_CJK_BOLD, 54)
    sub = "課堂互動 so easy"
    sb = d.textbbox((0, 0), sub, font=font_sub)
    sw = sb[2] - sb[0]
    sx = (W - sw) // 2 - sb[0]
    sy = 330
    d.text((sx + 2, sy + 3), sub, font=font_sub, fill=(0, 0, 0, 90))
    d.text((sx, sy), sub, font=font_sub, fill=YELLOW)

    # 下方說明 tagline（國小課堂用）
    font_tag = load_font(FONT_CJK_REG, 30)
    tagline = "國小課堂互動工具 · 13 種模式 · AI 出題 · 即時排行榜"
    tgb = d.textbbox((0, 0), tagline, font=font_tag)
    tgw = tgb[2] - tgb[0]
    tgx = (W - tgw) // 2 - tgb[0]
    tgy = 450
    d.text((tgx, tgy), tagline, font=font_tag, fill=(255, 255, 255, 230))

    # 底部膠囊：v3.8.29 + 網址
    pill_text = "V3.8.29  ·  cagoooo.github.io/Akailao"
    font_pill = load_font(FONT_LATIN_BOLD, 24)
    pb = d.textbbox((0, 0), pill_text, font=font_pill)
    pw = pb[2] - pb[0]
    ph = pb[3] - pb[1]
    pad_x, pad_y = 22, 12
    pill_w = pw + pad_x * 2
    pill_h = ph + pad_y * 2
    px = (W - pill_w) // 2
    py = 540
    d.rounded_rectangle([px, py, px + pill_w, py + pill_h],
                        radius=pill_h // 2, fill=(0, 0, 0, 120))
    d.text((px + pad_x - pb[0], py + pad_y - pb[1]), pill_text,
           font=font_pill, fill=WHITE)

    # 裝飾：左上 🚀 / 右上 📚 / 四角點綴 emoji（用系統 emoji 字體）
    # 放棄 emoji（不同系統字體差異大），改用幾何裝飾
    # 左上與右上小型像素方塊裝飾（呼應 v3.8.28 像素風）
    for bx, by, clr in [(80, 90, YELLOW), (110, 90, GREEN),
                        (1080, 500, YELLOW), (1050, 500, GREEN)]:
        d.rectangle([bx, by, bx + 20, by + 20], fill=clr)

    return img


def main():
    outputs = []

    # Favicon / PWA 多尺寸
    for size in [16, 32, 48, 64, 180, 192, 512]:
        img = make_icon(size)
        name = {
            16: "favicon-16.png",
            32: "favicon-32.png",
            48: "favicon-48.png",
            64: "favicon-64.png",
            180: "apple-touch-icon.png",
            192: "icon-192.png",
            512: "icon-512.png",
        }[size]
        path = os.path.join(ICONS, name)
        img.save(path, "PNG", optimize=True)
        outputs.append((name, os.path.getsize(path)))

    # favicon.ico（包 16/32/48）
    ico = Image.open(os.path.join(ICONS, "favicon-48.png"))
    ico.save(os.path.join(ICONS, "favicon.ico"),
             format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    outputs.append(("favicon.ico", os.path.getsize(os.path.join(ICONS, "favicon.ico"))))

    # 社群分享圖（OG）
    og = make_og_image()
    og_path = os.path.join(ICONS, "og-image.png")
    og.save(og_path, "PNG", optimize=True)
    outputs.append(("og-image.png", os.path.getsize(og_path)))

    # 輸出報告
    print("✅ 產出完成：")
    for name, size in outputs:
        print(f"  icons/{name}  ({size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
