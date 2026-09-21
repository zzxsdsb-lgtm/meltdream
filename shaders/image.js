// Image pass —— 原作骨架 + Euphoria/Y2K 换皮
// 原作：florian berger (flockaroo) 2016 · CC BY-NC-SA 3.0 · shadertoy.com/view/MsGSRd
// 本 pass 与原作逐字同构：亮度梯度 → 法线(z=150) → 漫反射 → pow(spec,36) 高光 →
// fragColor = texture(iChannel0,uv)*diff + spec
// 视觉改造只有三处，且都不触碰流体结构：
//  1) 换皮：对平流结果做整体色相旋转（深蓝紫/电光紫/糖果粉/冰蓝）——原作的颜色结构保留
//  2) 闪粉：随流平流的浓度场 + 流场位移采样（跟随液体运动，非屏幕噪点）
//  3) 鼠标光晕：跟随光标的柔和发光（唯一鼠标交互，不扰动流体）
window.SHADER_IMAGE = `// created by florian berger (flockaroo) - 2016
// License Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported License.

// single pass CFD
// ---------------
// this is some "computational flockarooid dynamics" ;)
// the self-advection is done purely rotational on all scales.

// [新增·改造] 滑杆 / 循环 / 鼠标光晕 uniform
uniform float uRelief;   // 法线深度（原作 150）
uniform float uGloss;    // 高光倍率（原作 2.5）
uniform float uGlow;     // 光晕/辉光强度
uniform float uGlitter;  // 闪粉含量
uniform float uHue;      // 换皮色相旋转（弧度）
uniform float uBurst;    // 爆发包络 0~1（自动循环）
uniform float uRestore;  // 恢复包络 0~1（1 = 平静/恢复期，底图逐像素直出）
uniform vec2  uGlowPos;  // 鼠标光晕位置（uv，y 已翻转）
uniform float uGlowOn;   // 光晕出现系数 0~1

float getVal(vec2 uv)
{
    return length(texture(iChannel0,uv).xyz);
}

vec2 getGrad(vec2 uv,float delta)
{
    vec2 d=vec2(delta,0);
    return vec2(
        getVal(uv+d.xy)-getVal(uv-d.xy),
        getVal(uv+d.yx)-getVal(uv-d.yx)
    )/delta;
}

float hash12(vec2 p)
{
    p = fract(p*vec2(123.34,345.45));
    p += dot(p,p+34.345);
    return fract(p.x*p.y);
}

// [新增·改造] 闪粉层：液体的一部分。采样坐标经与平流相同的速度场位移，
// 亮度由随流平流的浓度场（alpha 通道）与局部能量调制 —— 闪粉随液体流动/聚集/拉伸
vec3 glitterLayer(vec2 uv, vec2 flowVel, float conc, float slope, float t)
{
    float energy = clamp(length(flowVel)*2.0, 0.0, 1.0);
    vec2 warp = uv + flowVel*0.18;
    vec3 acc = vec3(0.0);
    for(int k=0;k<2;k++)
    {
        float scale = (k==0) ? 5.0 : 12.0;
        vec2 p = warp*iResolution.xy/scale;
        vec2 cell = floor(p);
        float h = hash12(cell);
        float present = step(0.5, fract(h*7.13));
        vec2 off = vec2(fract(h*127.3), fract(h*311.7))*0.6 + 0.2;
        float d = length(fract(p)-off);
        float star = smoothstep(0.20, 0.02, d);
        float tw = pow(0.5 + 0.5*sin(h*6.2831 + t*(0.8+h*3.0) + energy*12.0), 5.0);
        vec3 tint = mix(vec3(1.04,0.70,0.94), vec3(0.70,0.94,1.12), fract(h*5.77));
        tint = mix(tint, vec3(1.06,1.02,1.0), slope*0.5);
        acc += tint * star * tw * present;
    }
    float amount = smoothstep(0.20, 0.75, conc) * (0.30 + 1.5*slope) * (0.45 + energy*1.0);
    return acc * amount;
}

// [新增·改造] 换皮 v2：亮度结构 100% 保留，色相压缩到 蓝紫↔糖果粉 扇区。
// 原作高速期的"彩虹色块"来自速度通道饱和（黄/青/品红）——这里把色相
// 归入 Euphoria 色板，同时保留通道间的变化与全部明暗对比
vec3 hueShift(vec3 color, float angle)
{
    const vec3 k = vec3(0.57735);
    float c = cos(angle);
    return color*c + cross(k, color)*sin(angle) + k*dot(k, color)*(1.0 - c);
}

vec3 recolor(vec3 col, float hue)
{
    col = hueShift(col, hue);
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    // 目标调：暗部=深蓝紫 → 中间=电光紫 → 亮部=糖果粉 → 最高=珍珠白/冰蓝
    vec3 tone = mix(vec3(0.09, 0.05, 0.28), vec3(0.62, 0.30, 0.98), smoothstep(0.05, 0.55, l));
    tone      = mix(tone, vec3(1.00, 0.55, 0.90), smoothstep(0.50, 0.88, l));
    tone      = mix(tone, vec3(0.85, 0.98, 1.10), smoothstep(0.86, 1.00, l));
    // 保留原作各通道的差异作为"色度微偏移"，整体并入目标色板
    vec3 chroma = col - vec3(l);
    return clamp(tone + chroma * 0.55, 0.0, 1.2);
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    // ================= 原作骨架（逐字） =================
    vec2 uv = fragCoord.xy / iResolution.xy;
    vec2 g = getGrad(uv,1.0/iResolution.y);
    vec3 n = vec3(g, uRelief);
    n = normalize(n);
    float slope = clamp(length(g)*(400.0/uRelief)*0.12, 0.0, 1.0);
    vec3 light = normalize(vec3(1,1,2));
    float diff = clamp(dot(n,light),0.5,1.0);
    float spec = clamp(dot(reflect(light,n),vec3(0,0,-1)),0.0,1.0);
    spec = pow(spec,36.0)*2.5*uGloss;

    // ================= 原作合成 + 换皮 =================
    vec4 s0 = texture(iChannel0, uv);
    vec2 flowVel = s0.xy - 0.5;          // 流体速度场（与平流相同）
    float conc   = s0.a;                 // 随流平流的闪粉浓度

    vec3 col = s0.rgb;
    col = recolor(col, uHue);                         // 换皮：色相压入蓝紫粉扇区
    col = pow(col, vec3(0.96));                       // 轻微提亮

    // 闪粉：液体内部的亮片（随流运动，浓度随平流聚集/分散）
    col += glitterLayer(uv, flowVel, conc, slope, iTime)
           * uGlitter * (1.0 + 0.4*uBurst);

    // 原作合成：颜色×漫反射 + 高光（高光带轻微糖果粉/冰蓝珠光偏色）
    vec3 irid = mix(vec3(1.02,0.92,1.00), vec3(0.92,0.98,1.05),
                    clamp(0.5+0.5*n.x+0.3*slope, 0.0, 1.0));
    vec3 outCol = col*diff + spec*irid;

    // [新增] 爆发期的轻微紫雾（亢奋氛围，量很小）
    outCol += vec3(0.10,0.04,0.16)*uBurst*0.35*(0.3+0.7*slope);

    // [新增] 底图层：随爆发包络淡入淡出 ——
    //   平静/恢复期流体层完全退场，底图逐像素原样显现；
    //   高速亢奋期流体完全接管（允许底图 100% 被液体覆盖）
    vec3 bg = texture(iChannel2, uv).rgb;
    float flowVis = clamp(uBurst*1.25, 0.0, 1.0);
    outCol = mix(bg, outCol, flowVis);

    // [新增] 鼠标光晕：唯一保留的鼠标交互 —— 跟随光标的柔和发光（不扰动流体）
    vec2 dgl = (uv - uGlowPos) * vec2(iResolution.x/iResolution.y, 1.0);
    float halo = exp(-dot(dgl,dgl)/0.016) * uGlowOn;
    vec3 haloCol = mix(vec3(0.45,0.30,1.00), vec3(1.00,0.55,0.90),
                       0.5 + 0.5*sin(iTime*1.3 - dgl.y*9.0));

    // 轻微暗角
    vec2 scr = uv*2.0-1.0;

    // [新增] 恢复/平静期：底图逐像素直出（完全不受流体/调色影响），严格保持原样
    outCol = mix(outCol, texture(iChannel2, uv).rgb, uRestore);

    // 光晕在底图之上叠加（平静期也可交互发光）
    outCol += haloCol * halo * 0.30;

    // 暗角（仅作用于流体/合成层之外的最后一瞥，平静期同样轻微）
    outCol *= 1.0 - 0.08*dot(scr,scr)*(0.4 + 0.6*uBurst);

    fragColor = vec4(outCol,1.0);
}
`;
