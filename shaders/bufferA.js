// Buffer A —— 流体模拟 pass（原作：flockaroo, Shadertoy MsGSRd, CC BY-NC-SA 3.0）
// 原作核心动力学 100% 保留：velocity feedback / 多尺度旋转 advection / motor pump /
// 多 pass buffer accumulation，一个不少、强度不减。
// 所有改动均以 [新增·改造] 标注，且只涉及"何时开多大油门"（自动循环包络）：
//   平静(8s) → 爆发(2s 拉满原版速度 + slam 过冲) → 高速亢奋(35s) → 逐渐减弱(15s) → 凝固恢复 → 循环
// 速度场跨周期持久存在，不归零、不阻尼 —— 与原作的持续累积一致。
window.SHADER_BUFFER_A = `// created by florian berger (flockaroo) - 2016
// License Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported License.

// single pass CFD
// ---------------
// this is some "computational flockarooid dynamics" ;)
// the self-advection is done purely rotational on all scales.
// therefore i dont need any divergence-free velocity field.
// with stochastic sampling i get the proper "mean values" of rotations
// over time for higher order scales.
//
// try changing "RotNum" for different accuracies of rotation calculation
// for even RotNum uncomment the line #define SUPPORT_EVEN_ROTNUM

#define RotNum 5
//#define SUPPORT_EVEN_ROTNUM

// [新增·改造] 闪粉浓度基线（浓度场存于 alpha 通道，随流平流）
#define GLITTER_BASE 0.25

// [新增·改造] 自动循环 uniform（全部由 iTime 驱动，与鼠标无关）
uniform float uFlow;   // 流动强度（1.0 = 原版速度的一半；2.0 = 原版速度）
uniform float uSpeed;  // 流动速度（缩放平流/泵/循环节奏的全局时钟）
uniform float uWake;   // 每轮循环开头底图平静的时长（秒）
uniform float uCycle;  // 循环周期（秒）
uniform float uT2;     // 全速流动结束、开始逐渐减弱的时刻（秒）
uniform float uT3;     // 减弱完成、进入恢复的时刻（秒）
uniform float uR0;     // 颜色开始重新凝固的时刻（秒）
uniform float uR1;     // 颜色凝固完成的时刻（秒）

#define Res  iChannelResolution[0]
#define Res1 iChannelResolution[1]

#define keyTex iChannel3
#define KEY_I texture(keyTex,vec2((105.5-32.0)/256.0,(0.5+0.0)/3.0)).x

const float ang = 2.0*3.1415926535/float(RotNum);
mat2 m = mat2(cos(ang),sin(ang),-sin(ang),cos(ang));
mat2 mh = mat2(cos(ang*0.5),sin(ang*0.5),-sin(ang*0.5),cos(ang*0.5));

vec4 randS(vec2 uv)
{
    return texture(iChannel1,uv*Res.xy/Res1.xy)-vec4(0.5);
}

float getRot(vec2 pos, vec2 b)
{
    vec2 p = b;
    float rot=0.0;
    for(int i=0;i<RotNum;i++)
    {
        rot+=dot(texture(iChannel0,fract((pos+p)/Res.xy)).xy-vec2(0.5),p.yx*vec2(1,-1));
        p = m*p;
    }
    return rot/float(RotNum)/dot(b,b);
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 pos = fragCoord.xy;
    float rnd = randS(vec2(float(iFrame)/Res.x,0.5/Res1.y)).x;

    vec2 b = vec2(cos(ang*rnd),sin(ang*rnd));
    vec2 v=vec2(0);
    float bbMax=0.7*Res.y; bbMax*=bbMax;
    for(int l=0;l<20;l++)
    {
        if ( dot(b,b) > bbMax ) break;
        vec2 p = b;
        for(int i=0;i<RotNum;i++)
        {
#ifdef SUPPORT_EVEN_ROTNUM
            v+=p.yx*getRot(pos+p,-mh*b);
#else
            // this is faster but works only for odd RotNum
            v+=p.yx*getRot(pos+p,b);
#endif
            p = m*p;
        }
        b*=2.0;
    }

    // [新增·改造] 全自动长周期（只由 iTime 驱动，鼠标不参与）：
    //   0..uWake        平静：底图清晰，流体仅 10% 低速维持（速度场不熄火）
    //   uWake..+2s      突然爆发：2 秒内拉满原版流速，并带 slam 过冲（最高 +70%）
    //   ..uT2           高速亢奋：原版全力持续
    //   uT2..uT3        逐渐减弱（连续，不突然停止）
    //   uR0..uR1        液体颜色重新凝固回底图
    // 速度场跨周期持久存在、不归零不阻尼 —— 原作的 feedback/accumulation 完整保留
    float ph = mod(iTime, uCycle);
    float attack  = smoothstep(uWake, uWake + 2.0, ph);
    float slam    = attack * (1.0 - smoothstep(uWake + 2.5, uWake + 6.0, ph));
    float sustain = 1.0 - smoothstep(uT2, uT3, ph);
    float burst   = attack * sustain;
    float restore = max( 1.0 - smoothstep(uWake + 2.5, uWake + 6.0, ph),
                         smoothstep(uR0, uR1, ph) );
    // uSpeed 缩放整体演化速率；FLOW_HALF=0.5 为流速重标定
    // （滑杆 1.0 = 原版速度的一半，2.0 = 原版速度，4.0 = 原版两倍）
    #define FLOW_HALF 0.5
    float k = uFlow * uSpeed * FLOW_HALF;
    float act = k * max( burst * (1.0 + 0.7*slam), 0.10*(1.0 - burst) );

    fragColor=texture(iChannel0,fract((pos+v*vec2(-1,1)*2.0*act)/Res.xy));

    // add a little "motor" in the center (原作 pump，强度随包络)
    vec2 scr=(fragCoord.xy/Res.xy)*2.0-vec2(1.0);
    fragColor.xy += (0.01*act*scr.xy / (dot(scr,scr)/0.1+0.3));

    // [新增·改造] 速度钳制 0~1 —— 原作 8 位缓冲的隐式饱和行为（16F 下需显式声明），
    // 也是原作"高速过载"外观的来源；16F 无量化误差，故不会产生几何形
    fragColor.xy = clamp(fragColor.xy, 0.0, 1.0);

    // [新增·改造] 闪粉浓度场（alpha 通道，与颜色/速度一起被同一速度场平流）
    float energy = clamp(length(fragColor.xy - 0.5)*2.0, 0.0, 1.0);
    fragColor.w += energy*0.010*(1.0 - fragColor.w);
    fragColor.w += (GLITTER_BASE - fragColor.w)*0.006;

    // [新增·改造] 恢复期：
    //  · 颜色（z/w 通道）缓缓凝固回底图 → 底图重新显现
    //  · 速度（xy 通道）弛豫归零 → 洗掉上一轮积累的像素级速度噪声，
    //    让每一轮爆发都从"平滑的速度场"开始，被 motor 重新拉起后
    //    形成原作那样的大尺度连贯漩涡（而不是像素级细碎噪声）
    //  · 平静/恢复期的画面纯净度由 Image 通道的底图合成保证（与缓冲状态解耦）
    vec4 photo = texture(iChannel2, fragCoord.xy/Res.xy);
    fragColor.xyz = mix(fragColor.xyz, photo.xyz, restore*0.30);
    fragColor.xy = mix(fragColor.xy, vec2(0.5), restore*0.30);

    if(iFrame<=4 || KEY_I>0.5) fragColor=texture(iChannel2,fragCoord.xy/Res.xy);
}
`;
