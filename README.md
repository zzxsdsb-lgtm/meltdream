# SPILLED ✦ 亢奋 · 液体 · 梦境（v2：水钻贴纸交互版）

基于稳定版（`../spilled-shader-稳定版/`，与 :8818 端口版本相同）的副本。

**本版唯一新增：水钻贴纸点击交互**，Spilled 核心流体、70 秒自动循环、全部滑杆原样保留：

- **流速重标定**：滑杆"流动强度" 1.0 = 原版速度的一半（新默认），2.0 = 原版速度，4.0 = 原版两倍

- 点击画面任意位置 → 从 14 个水钻贴纸中随机生成一个，严格出现在点击位置
- 点击后原地快速渐隐（约 0.5 秒，亮度调低不抢戏），无位移、无飞出动画
- 同时最多 12 个，自动回收，不堆积
- 点击只生成贴纸，绝不扰动流体；鼠标移动仍只是局部发光

## 运行

```bash
cd spilled-shader-v2
python3 tools/server.py 8819
# 打开 http://localhost:8819
```

## 实现

- 贴纸素材：`assets/stickers/st01..14.png`（由作者提供的 14 个水钻 SVG 烘焙而成——
  原始 SVG 为 Illustrator 导出的"内嵌 base64 位图壳"，直接用 <img> 渲染会被
  viewBox 裁剪到不可见；`tools/bake.html` 一次性把每个 SVG 的内嵌位图提取、
  alpha 裁剪、缩放到 ≤512px 的透明 PNG。黑底素材自动按亮度抠成透明）
- 贴纸渲染：DOM 叠层（screen 混合已移除），原地透明度渐隐 ≈0.5s，亮度已调低

原作：flockaroo (2016) · CC BY-NC-SA 3.0 · shadertoy.com/view/MsGSRd
