'use strict';
/* spilled —— Shadertoy MsGSRd 本地 WebGL2 复刻运行时
 * 双 pass 流水线：Buffer A（流体模拟，ping-pong 自反馈）→ Image（液面光照合成）
 */

const ST_HEADER = `#version 300 es
precision highp float;
precision highp int;

uniform vec3      iResolution;
uniform float     iTime;
uniform float     iTimeDelta;
uniform int       iFrame;
uniform float     iFrameRate;
uniform vec4      iMouse;
uniform vec4      iDate;
uniform float     iChannelTime[4];
uniform vec3      iChannelResolution[4];
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
out vec4 shadertoy_out_color;
`;

const ST_FOOTER = `
void main(){ mainImage(shadertoy_out_color, gl_FragCoord.xy); }
`;

const VERT_SRC = `#version 300 es
void main(){
  vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}`;

const NOISE_SRC = (window.ASSET_NOISE) || 'assets/noise.png';
const DREAM_SRC = (window.ASSET_DREAM) || 'assets/dream.png';
const NOISE_SIZE = [256, 256];
const INIT_FRAMES = 5; // 原版 iFrame<=4 时写入初始图片

const canvas = document.getElementById('view');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false });
if (!gl) fail('当前浏览器不支持 WebGL2，无法运行。');

const ui = {
  fps: document.getElementById('fps'),
  mood: document.getElementById('phase'),
  btnReset: document.getElementById('btn-reset'),
  btnDefault: document.getElementById('btn-default'),
  panel: document.getElementById('panel'),
  err: document.getElementById('err'),
};
// 参数抽屉默认收起
ui.panel.classList.add('hidden');
// 三个胶囊按钮 / 全部参数按钮：展开或收起抽屉
for (const id of ['pp-flow', 'pp-speed', 'pp-spark', 'pp-set']) {
  const b = document.getElementById(id);
  if (b) b.addEventListener('click', (e) => {
    ui.panel.classList.toggle('hidden');
    e.currentTarget.blur();
  });
}

function fail(msg) {
  ui.err.textContent = msg;
  ui.err.style.display = 'block';
  throw new Error(msg);
}

function compile(type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    fail(`${label} 编译失败：\n${log}`);
  }
  return sh;
}

function program(fragSrc, label) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT_SRC, label + ' (vert)'));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, ST_HEADER + fragSrc + ST_FOOTER, label));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    fail(`${label} 链接失败：\n` + gl.getProgramInfoLog(p));
  }
  const u = {};
  for (const name of ['iResolution', 'iTime', 'iTimeDelta', 'iFrame', 'iFrameRate', 'iMouse', 'iDate',
    'iChannel0', 'iChannel1', 'iChannel2', 'iChannel3', 'iChannelResolution[0]', 'iChannelTime[0]',
    'uFlow', 'uSpeed', 'uWake', 'uCycle', 'uT2', 'uT3', 'uR0', 'uR1',
    'uRelief', 'uGloss', 'uGlow', 'uGlitter', 'uHue', 'uBurst', 'uRestore', 'uGlowPos', 'uGlowOn']) {
    u[name] = gl.getUniformLocation(p, name);
  }
  return { prog: p, u };
}

// 模拟缓冲优先用半浮点（RGBA16F）：速度/颜色不再受 8 位量化限制，
// 长时间流动更顺滑，消除后期出现的方块/色带（需 EXT_color_buffer_float）
const floatOK = gl.getExtension('EXT_color_buffer_float');

function createTarget(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (floatOK) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo };
}

// Shadertoy 纹理：vflip + repeat + mipmap 线性过滤
function imageTexture(url, [w, h]) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const tex = gl.createTexture();
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      resolve({ tex, size: [img.naturalWidth || w, img.naturalHeight || h] });
    };
    img.onerror = () => reject(new Error('贴图加载失败：' + url));
    img.src = url;
  });
}

// iChannel2 底图（用户提供背景）：cover-crop 到画布比例再上传，
// 使 Buffer A 的 0-1 采样正好等于"裁剪铺满"的构图，不拉伸人物
let dreamImg = null, dreamTex = null, dreamSize = [2, 2];
function uploadDream() {
  if (!dreamImg || !W) return;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const s = Math.max(W / dreamImg.width, H / dreamImg.height);
  const dw = dreamImg.width * s, dh = dreamImg.height * s;
  ctx.drawImage(dreamImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
  if (!dreamTex) dreamTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, dreamTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  dreamSize = [W, H];
}

// iChannel3 键盘贴图（256x3）：row0=按住 row1=开关 row2=本帧按下
const KEY_I = 105; // 'i'
const keyData = new Uint8Array(256 * 3 * 4);
const keyTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, keyTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 3, 0, gl.RGBA, gl.UNSIGNED_BYTE, keyData);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

// Shadertoy 键盘贴图布局：可打印字符的键状态写在 (charCode-32) 号 texel
function setKey(code, down) {
  const t = code - 32;
  if (t < 0 || t >= 256) return;
  const off = t * 3 * 4;
  const v = down ? 255 : 0;
  keyData[off] = v; keyData[off + 1] = v; keyData[off + 2] = v; keyData[off + 3] = 255;
  if (down) { const o1 = (t * 3 + 1) * 4; keyData[o1] = 255; keyData[o1 + 1] = 255; keyData[o1 + 2] = 255; keyData[o1 + 3] = 255; }
  gl.bindTexture(gl.TEXTURE_2D, keyTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 3, gl.RGBA, gl.UNSIGNED_BYTE, keyData);
}
function pulseKeys() { // 每帧结束后清空 row2
  for (let t = 0; t < 256; t++) {
    const off = (t * 3 + 2) * 4;
    if (keyData[off]) {
      keyData[off] = 0; keyData[off + 1] = 0; keyData[off + 2] = 0;
      gl.bindTexture(gl.TEXTURE_2D, keyTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, keyData.subarray(off, off + 4));
    }
  }
}
window.addEventListener('keydown', (e) => {
  const c = e.key.toLowerCase().charCodeAt(0);
  if (c === KEY_I) e.preventDefault();
  if (!e.repeat) {
    setKey(c, true);
    if (c === 114) reset();            // R：重新泼洒
    if (c === 32) {                    // 空格：暂停/继续
      e.preventDefault();
      paused = !paused;
    }
  }
});
window.addEventListener('keyup', (e) => setKey(e.key.toLowerCase().charCodeAt(0), false));

// ---- 状态 ----
let W = 0, H = 0;
let rtA = null, rtB = null; // ping-pong
let frame = 0, time = 0, paused = false;
const mouse = [0, 0, 0, 0];

const bufA = program(window.SHADER_BUFFER_A, 'Buffer A');
const imgP = program(window.SHADER_IMAGE, 'Image');

function setSize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1); // 流体模拟按 1:1 像素跑，性能优先
  const w = Math.max(2, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(2, Math.floor(canvas.clientHeight * dpr));
  if (w === W && h === H) return;
  W = w; H = h;
  canvas.width = W; canvas.height = H;
  if (rtA) { gl.deleteTexture(rtA.tex); gl.deleteFramebuffer(rtA.fbo); }
  if (rtB) { gl.deleteTexture(rtB.tex); gl.deleteFramebuffer(rtB.fbo); }
  rtA = createTarget(W, H);
  rtB = createTarget(W, H);
  uploadDream(); // 画布比例变化时按新比例重新 cover-crop 底图
  reset();
}

function reset() {
  for (const rt of [rtA, rtB]) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  frame = 0; time = 0;
}

ui.btnReset.addEventListener('click', (e) => { reset(); e.currentTarget.blur(); });
// ---- 鼠标光晕跟踪（唯一保留的鼠标交互：仅发光，完全不参与流体） ----
let lastMoveT = -1e9;
const glowTarget = [0.5, 0.5], glowPos = [0.5, 0.5];
let glowOn = 0, glowOnTarget = 0;

function trackGlow(e) {
  const r = canvas.getBoundingClientRect();
  glowTarget[0] = (e.clientX - r.left) / r.width;
  glowTarget[1] = 1 - (e.clientY - r.top) / r.height;
  lastMoveT = performance.now() / 1000;
}
canvas.addEventListener('pointermove', trackGlow);
canvas.addEventListener('pointerdown', trackGlow);

let lastT = 0, dtSmooth = 1 / 60, fpsSmooth = 60, fpsShown = 0;

// ---- 滑杆参数 ----
const params = { flow: 1.0, wake: 3, cycle: 35, speed: 1.0, relief: 150, gloss: 1.0, glow: 0.7, hue: 0.15, glitter: 0.6 };
const DEFAULTS = { ...params };
const sliderRefresh = [];
function bindSlider(key, fmt) {
  const el = document.getElementById('s-' + key);
  const val = document.getElementById('v-' + key);
  if (!el || !val) return;
  el.value = params[key];
  val.textContent = fmt(params[key]);
  el.addEventListener('input', () => {
    params[key] = parseFloat(el.value);
    val.textContent = fmt(params[key]);
  });
  sliderRefresh.push(() => { el.value = params[key]; val.textContent = fmt(params[key]); });
}
bindSlider('flow', v => v.toFixed(2));
bindSlider('wake', v => v.toFixed(0) + 's');
bindSlider('cycle', v => v.toFixed(0) + 's');
bindSlider('speed', v => v.toFixed(2) + 'x');
bindSlider('relief', v => v.toFixed(0));
bindSlider('gloss', v => v.toFixed(2));
bindSlider('glow', v => v.toFixed(2));
bindSlider('hue', v => v.toFixed(2));
bindSlider('glitter', v => v.toFixed(2));
if (ui.btnDefault) ui.btnDefault.addEventListener('click', (e) => {
  Object.assign(params, DEFAULTS);
  sliderRefresh.forEach(f => f());
  e.currentTarget.blur();
});

// 爆发包络（含 slam 过冲）：与 Buffer A 的循环节奏公式保持一致
// 长周期：平静 wake 秒 → 爆发 2 秒拉满 → 高速亢奋至 uT2 → 逐渐减弱至 uT3 → 恢复
function smoothstepJS(a, b, x) {
  x = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return x * x * (3 - 2 * x);
}
function burstEnvelope(tsec) {
  const p = ((tsec % params.cycle) + params.cycle) % params.cycle;
  const attack = smoothstepJS(params.wake, params.wake + 2.0, p);
  const slam = attack * (1 - smoothstepJS(params.wake + 2.5, params.wake + 6.0, p));
  const t2 = params.wake + (params.cycle - params.wake) * 0.60;
  const t3 = params.wake + (params.cycle - params.wake) * 0.84;
  const sustain = 1 - smoothstepJS(t2, t3, p);
  return attack * sustain * (1 + 0.7 * slam);
}

// 恢复包络：与 Buffer A 的 restore 公式保持一致（颜色凝固 + 底图淡入）
function restoreEnvelope(tsec) {
  const p = ((tsec % params.cycle) + params.cycle) % params.cycle;
  const r0 = params.wake + (params.cycle - params.wake) * 0.68;
  const r1 = params.wake + (params.cycle - params.wake) * 0.93;
  const melt = 1 - smoothstepJS(params.wake + 2.5, params.wake + 6.0, p);
  const regel = smoothstepJS(r0, r1, p);
  return Math.max(melt, regel);
}

function drawImagePass(tex) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, W, H);
  gl.useProgram(imgP.prog);
  gl.uniform3f(imgP.u['iResolution'], W, H, 1);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(imgP.u['iChannel0'], 0);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, dreamTex); gl.uniform1i(imgP.u['iChannel2'], 2);
  gl.uniform3f(imgP.u['iChannelResolution[0]'], W, H, 1);
  gl.uniform3f(imgP.u['iChannelResolution[2]'], dreamSize[0], dreamSize[1], 1);
  gl.uniform1f(imgP.u['uRelief'], params.relief);
  gl.uniform1f(imgP.u['uGloss'], params.gloss);
  gl.uniform1f(imgP.u['uGlow'], params.glow);
  gl.uniform1f(imgP.u['uGlitter'], params.glitter);
  gl.uniform1f(imgP.u['uHue'], params.hue);
  gl.uniform1f(imgP.u['uBurst'], burstEnvelope(time));
  gl.uniform1f(imgP.u['uRestore'], restoreEnvelope(time));
  gl.uniform2f(imgP.u['uGlowPos'], glowPos[0], glowPos[1]);
  gl.uniform1f(imgP.u['uGlowOn'], glowOn);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ---- 鼠标光晕平滑跟随（仅发光，不影响流体） ----
function updateGlow(dt, now) {
  glowOnTarget = (now - lastMoveT) < 1.5 ? 1 : 0;
  glowOn += (glowOnTarget - glowOn) * (1 - Math.exp(-dt * (glowOnTarget > glowOn ? 6 : 1.5)));
  const k = 1 - Math.exp(-dt * 10);
  glowPos[0] += (glowTarget[0] - glowPos[0]) * k;
  glowPos[1] += (glowTarget[1] - glowPos[1]) * k;
}

// ═══════════════════════════════════════════════════════════
// 水钻贴纸点击交互（仅 DOM 叠层；点击不改变流体）
// 点击 → 原位出现 → 原地快速渐隐（约 0.5s），无位移、无飞出
// ═══════════════════════════════════════════════════════════
const STICKER_MAX = 12;
const STICKER_SRCS = Array.from({ length: 14 }, (_, i) =>
  `assets/stickers/st${String(i + 1).padStart(2, '0')}.png`);
const stickerLayer = document.getElementById('stickers');
const stickerPool = [];
let stickerSVGs = [];

function preloadStickers() {
  return Promise.all(STICKER_SRCS.map(src => new Promise(res => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  }))).then(list => { stickerSVGs = list.filter(Boolean); });
}

function spawnSticker(cx, cy) {
  if (!stickerSVGs.length) return;
  if (stickerPool.length >= STICKER_MAX) {   // 防堆积：挤掉最老的
    const old = stickerPool.shift();
    old.el.remove();
  }
  const src = stickerSVGs[(Math.random() * stickerSVGs.length) | 0].src;
  const el = document.createElement('img');
  el.className = 'sticker';
  el.src = src;
  const size = 30 + Math.random() * 22;
  el.style.width = size + 'px';
  el.style.opacity = '0';
  stickerLayer.appendChild(el);
  stickerPool.push({
    el, x: cx, y: cy,
    age: 0,
    maxLife: 0.42 + Math.random() * 0.16,   // ≈0.5s 原地渐隐
    rot: (Math.random() - 0.5) * 30,
    size,
  });
}

function updateStickers(dt) {
  if (!stickerPool.length) return;
  for (let i = stickerPool.length - 1; i >= 0; i--) {
    const s = stickerPool[i];
    s.age += dt;
    const k = s.age / s.maxLife;
    if (k >= 1) { s.el.remove(); stickerPool.splice(i, 1); continue; }
    // 原地渐隐：透明度 1→0，轻微缩小，无任何位移
    s.el.style.opacity = (0.85 * (1 - k) * (1 - k)).toFixed(3);
    const sc = (1 - 0.18 * k).toFixed(3);
    s.el.style.transform =
      `translate(${(s.x - s.size / 2).toFixed(1)}px, ${(s.y - s.size / 2).toFixed(1)}px) rotate(${s.rot.toFixed(1)}deg) scale(${sc})`;
  }
}

// 点击 → 随机水钻贴纸（仅生成，不改变流体）
canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  spawnSticker(e.clientX - r.left, e.clientY - r.top);
});
// ═══════════════════ 水钻贴纸结束 ═══════════════════

// [调试] 同步推进 n 帧（每帧恒定 1/60s，页面被宿主节流时仍可渲染/老化测试）
window.__frame = (n = 1) => {
  const base = performance.now();
  for (let i = 0; i < n; i++) {
    lastT = base + i * (1000 / 60);
    step(lastT + 1000 / 60);
  }
  lastT = performance.now();
  return frame;
};
// [调试] 推进到指定帧号并截图（POST 到本地服务器保存）
window.__snapAt = (targetFrame, name = 'shot') => {
  const cur = frame;
  if (targetFrame > cur) __frame(targetFrame - cur);
  __snap(name);
  return frame;
};
// [调试] 读取内部状态与缓冲区采样（排错用）
window.__dbg = () => {
  const px = new Float32Array(4 * 4);
  const errs = [];
  gl.bindFramebuffer(gl.FRAMEBUFFER, rtA.fbo);
  gl.readPixels(Math.floor(W / 2) - 2, Math.floor(H / 2) - 2, 4, 4, gl.RGBA, gl.FLOAT, px);
  let e = gl.getError(); if (e) errs.push('rtA:' + e);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const avg = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) for (let c = 0; c < 4; c++) avg[c] += px[i * 4 + c];
  return {
    time: time.toFixed(2), frame, paused,
    bufA_center: avg.map(v => (v / 4).toFixed(3)),
    glErrs: errs,
  };
};
// [调试] 渲染一帧并把画布 POST 到本地服务器（配合 tools/server.py 保存截图）
window.__snap = (name = 'shot') => {
  __frame(1);
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  c.getContext('2d').drawImage(canvas, 0, 0);
  const dataURL = c.toDataURL('image/png');
  fetch('/__snap?name=' + encodeURIComponent(name), { method: 'POST', body: dataURL });
  return frame;
};

let rafQueued = false;
// 循环阶段标签（HUD 显示用，与 70s 长周期包络一致）
function phaseLabel(tsec) {
  const p = ((tsec % params.cycle) + params.cycle) % params.cycle;
  const t2 = params.wake + (params.cycle - params.wake) * 0.60;
  const t3 = params.wake + (params.cycle - params.wake) * 0.84;
  const r0 = params.wake + (params.cycle - params.wake) * 0.68;
  if (p < params.wake) return '平静';
  if (p < params.wake + 2) return '爆发';
  if (p < t2) return '高速亢奋';
  if (p < r0) return '减弱';
  return '恢复';
}

function step(t) {
  rafQueued = false;
  if (!rafQueued) { rafQueued = true; requestAnimationFrame(step); }
  setSize();
  const dt = Math.min((t - lastT) / 1000 || 1 / 60, 0.1);
  lastT = t;
  dtSmooth = dtSmooth * 0.9 + dt * 0.1;
  fpsSmooth = fpsSmooth * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
  if (t - fpsShown > 500) {
    fpsShown = t;
    ui.fps.textContent = fpsSmooth.toFixed(0) + ' fps';
    ui.mood.textContent = '阶段 · ' + phaseLabel(time);
  }
  updateGlow(dt, t / 1000);

  if (!paused) {
    // ---- Buffer A：流体模拟（读写 ping-pong）----
    gl.bindFramebuffer(gl.FRAMEBUFFER, rtB.fbo);
    gl.viewport(0, 0, W, H);
    gl.useProgram(bufA.prog);
    gl.uniform3f(bufA.u['iResolution'], W, H, 1);
    gl.uniform1f(bufA.u['iTime'], time);
    gl.uniform1f(bufA.u['iTimeDelta'], dtSmooth);
    gl.uniform1i(bufA.u['iFrame'], frame);
    gl.uniform1f(bufA.u['iFrameRate'], 1 / Math.max(dtSmooth, 1e-4));
    const d = new Date();
    gl.uniform4f(bufA.u['iDate'], d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds());

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rtA.tex); gl.uniform1i(bufA.u['iChannel0'], 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, noiseTex.tex); gl.uniform1i(bufA.u['iChannel1'], 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, dreamTex); gl.uniform1i(bufA.u['iChannel2'], 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, keyTex); gl.uniform1i(bufA.u['iChannel3'], 3);

    gl.uniform3f(bufA.u['iChannelResolution[0]'], W, H, 1);
    gl.uniform3f(bufA.u['iChannelResolution[1]'], noiseTex.size[0], noiseTex.size[1], 1);
    gl.uniform3f(bufA.u['iChannelResolution[2]'], dreamSize[0], dreamSize[1], 1);
    gl.uniform3f(bufA.u['iChannelResolution[3]'], 256, 3, 1);
    gl.uniform1fv(bufA.u['iChannelTime[0]'], [time, time, time, time]);
    gl.uniform1f(bufA.u['uFlow'], params.flow);
    gl.uniform1f(bufA.u['uSpeed'], params.speed);
    gl.uniform1f(bufA.u['uWake'], params.wake);
    gl.uniform1f(bufA.u['uCycle'], params.cycle);
    gl.uniform1f(bufA.u['uT2'], params.wake + (params.cycle - params.wake) * 0.60);
    gl.uniform1f(bufA.u['uT3'], params.wake + (params.cycle - params.wake) * 0.84);
    gl.uniform1f(bufA.u['uR0'], params.wake + (params.cycle - params.wake) * 0.68);
    gl.uniform1f(bufA.u['uR1'], params.wake + (params.cycle - params.wake) * 0.93);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- Image：液面光照合成到屏幕 ----
    drawImagePass(rtB.tex);

    // ---- 水钻贴纸：在最新缓冲上采样速度场并积分运动（DOM 叠层） ----
    updateStickers(dtSmooth);

    const tmp = rtA; rtA = rtB; rtB = tmp;
    time += dtSmooth * params.speed;   // 流动速度滑杆：缩放模拟时间流
    frame++;
    pulseKeys();
  } else {
    // 暂停时仍把上一帧结果合成到屏幕（窗口变化时保持画面正确）
    drawImagePass(rtA.tex);
  }
}

let noiseTex = null;
function loadDream() {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('底图加载失败：' + DREAM_SRC));
    img.src = DREAM_SRC;
  });
}

Promise.all([
  imageTexture(NOISE_SRC, NOISE_SIZE),
  loadDream(),
]).then(([n, img]) => {
  noiseTex = n;
  dreamImg = img;
  setSize();
  preloadStickers();    // 预载 14 个水钻贴纸 PNG（不阻塞启动）
  requestAnimationFrame(step);
}).catch((e) => fail(e.message));
