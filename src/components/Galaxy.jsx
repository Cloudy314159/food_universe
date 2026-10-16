import { useEffect, useRef } from 'react'

/* ═══════════════════════════════════════════════════════════════════════
   Galaxy · 真三维星系背景层（2026-10-14 换上新背景，替换 ParticleNebula）
   ─────────────────────────────────────────────────────────────────────
   和 NebulaCanvas 的关系（**两层叠加，不是替换**）：
     · NebulaCanvas = 底色：屏幕空间噪声，4KB，**首屏就在**
     · 本组件      = 上层：真 3D 星系 + additive 发光，**延迟挂载**

   为什么一定要分层：
     three.js 打包后 100KB+。塞进首屏 →「打开就能看到结果」变慢，
     而背景是**装饰**。装饰可以晚到，内容不能。

   ⚠️ 这个文件里**没有任何静态 `import three`**。
      只有组件真正挂载后，`await import('three')` 才触发下载 ——
      那 100KB 是独立 chunk，首屏 HTML 里连 preload link 都不会有。

   props（爸爸 2026-10-14 定的值，写在 App.jsx 里）：
     · glowIntensity = 0.3  → 光晕压到 3 成，治「太亮」
     · saturation    = 0.67 → 颜色降饱和，配合整体不糊
     · starSize      = 1.5  → 星星不大，密集处不糊成一团
     · mouseRepulsion / clickWarp → 鼠标排斥 + 点击冲击波两个交互

   性能与无障碍的三道闸（缺一个都不该上）：
     ① `prefers-reduced-motion` → 直接不渲染
     ② 没有 WebGL → 静默退出（由 NebulaCanvas 兜底）
     ③ 页面切到后台 → 暂停渲染（省电）
   ═══════════════════════════════════════════════════════════════════════ */

/* 顶点着色器：每个粒子的位置**在这里算**，不在 JS 里算。
   ⚠️ 这是整件事的关键：JS 每帧只传几个 uniform，
      一万个新位置是 GPU 并行算出来的。用 for 循环在 JS 里改
      一万个坐标就会掉帧。

   星系形状 = 核球 + 三条旋臂 + 远晕（生成逻辑在 JS 侧，见下）。
   这里只负责让它们「活」起来：差速自转、鼠标排斥、点击冲击波。 */
const VERT = `
  attribute float aSeed;
  attribute float aSize;
  attribute vec3  aColor;

  uniform float uTime;
  uniform float uDpr;
  uniform float uK;
  uniform float uSpeed;
  uniform float uStarSize;
  uniform vec2  uMouse;    /* 鼠标在星系平面（y=0）上的世界坐标 */
  uniform float uRepel;    /* 1 = 排斥开，0 = 关 */
  uniform vec2  uWarpPos;  /* 点击处的世界坐标 */
  uniform float uWarp;     /* 冲击波强度，1 → 0 衰减 */
  uniform float uWarpR;    /* 冲击波当前扩散半径 */

  varying vec3  vColor;
  varying float vTwinkle;

  void main() {
    vec3 pos = position;

    /* 差速自转：内圈快、外圈慢 —— 像星系，不像整个刚体在转。
       速度刻意压得很慢（一圈要一两分钟）：肉眼看到的是「在缓慢流动」，
       旋臂不会几秒钟就扭成麻花。 */
    float r   = length(pos.xz);
    float ang = uTime * uSpeed * 0.12 * (1.0 + 1.2 / (r * 0.08 + 1.0)) + aSeed * 6.2831;
    pos.x = r * cos(ang);
    pos.z = r * sin(ang);

    /* 鼠标排斥：在星系平面内，把鼠标附近 10 单位里的星星往外推。
       力的衰减用平方 —— 越靠近推得越狠，边缘几乎无感。 */
    if (uRepel > 0.5) {
      vec2 rel = pos.xz - uMouse;
      float d = length(rel);
      if (d < 10.0 && d > 0.001) {
        float f = 1.0 - d / 10.0;
        pos.xz += normalize(rel) * f * f * 5.0;
      }
    }

    /* 点击冲击波：一圈向外扩散的「环」，只推环经过的星星。
       exp(-t*t) 是高斯钟形 —— 环有宽度，不是一刀切的一个半径。 */
    if (uWarp > 0.001) {
      vec2 rel = pos.xz - uWarpPos;
      float d = length(rel);
      float t = (d - uWarpR) / 5.5;
      float f = uWarp * exp(-t * t);
      if (d > 0.001) {
        pos.xz += normalize(rel) * f * 7.0;
      }
      pos.y += f * 2.5;
    }

    /* 轻微上下浮动，相位各不同 */
    pos.y += sin(uTime * 0.3 + aSeed * 6.2831) * 0.4;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    /* 近大远小。uK 由 JS 按相机距离算（150 对应相机 z=74）。 */
    gl_PointSize = aSize * uStarSize * uDpr * (uK / max(-mv.z, 0.1));

    /* 每颗星有自己的闪烁频率 */
    vTwinkle = 0.55 + 0.45 * sin(uTime * (0.4 + aSeed * 1.8) + aSeed * 10.0);
    vColor = aColor;
  }
`

/* 片元着色器：把方点画成「会发光的软圆点」。
   核心 + 光晕两层叠加 —— 这是不用 Bloom 也能有发光感的原因。

   ⚠️ 两个强度都是 props 传进来的，不在着色器里写死：
      · flareIntensity → 压核心亮度
      · glowIntensity  → 压光晕亮度（0.3 = 很淡，这就是「不糊」的关键）
   ⚠️ core 用的是 `1.0 - smoothstep(...)` 而不是 `smoothstep(0.5, 0.06, d)`
      —— 后两个参数倒过来写属于 GLSL 未定义行为，多数驱动能跑，
         但不保证。安全形式一点不损失效果。 */
const FRAG = `
  precision mediump float;

  varying vec3  vColor;
  varying float vTwinkle;

  uniform float uGlow;
  uniform float uFlare;
  uniform float uSaturation;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;                        /* 必须是圆的，不能是方块 */

    float core = 1.0 - smoothstep(0.06, 0.5, d); /* 实的核心 */
    float halo = pow(1.0 - d * 2.0, 3.0);        /* 外扩的光晕 */

    /* 饱和度：1.0 = 原色，0 = 完全灰。0.67 是降一档饱和，
         颜色还在但不艳 —— 艳了就容易显「糊」。 */
    float luma = dot(vColor, vec3(0.299, 0.587, 0.114));
    vec3 col = mix(vec3(luma), vColor, uSaturation);

    float a = (core * uFlare * 0.5 + halo * uGlow * 0.5) * vTwinkle;
    if (a < 0.004) discard;                      /* 几乎看不见的点不画，省填充 */

    gl_FragColor = vec4(col, a);
  }
`

/* 品牌色（和 --brand 那套一致）：金 / 琥珀 / 粉 / 紫 / 青 */
const GOLD   = [1.0, 0.78, 0.32]
const AMBER  = [1.0, 0.62, 0.25]
const PINK   = [1.0, 0.45, 0.72]
const VIOLET = [0.68, 0.52, 1.0]
const CYAN   = [0.42, 0.86, 1.0]

export default function Galaxy({
  density = 1,
  glowIntensity = 0.3,
  flareIntensity = 1,
  starSpeed = 0.5,
  mouseRepulsion = false,
  clickWarp = false,
  saturation = 0.67,
  starSize = 1.5,
}) {
  const canvasRef = useRef(null)

  /* 最新 props 的镜像。
     为什么需要它：主 effect 里的监听器是闭包，建立那一刻 props 就被
     「冻」在里面了。以后 props 再变（比如爸爸从检查台改参数），
     闭包读到的还是旧值。存一份 ref，handler 里永远读最新的。 */
  const cfgRef = useRef({})
  cfgRef.current = {
    glowIntensity, flareIntensity, starSpeed, mouseRepulsion, clickWarp, saturation, starSize,
  }

  /* uniform 的引用：props 变了只改 uniform，不重建场景 */
  const uniformsRef = useRef(null)

  /* 热更新：除 density 外都能即时生效。
     ⚠️ density（粒子数）改不得热更新 —— 它在建场景时决定 BufferGeometry
         有多大。改它必须重建整个组件（父组件换 key）。props 是常量，无所谓。 */
  useEffect(() => {
    const u = uniformsRef.current
    if (!u) return
    u.uGlow.value = glowIntensity
    u.uFlare.value = flareIntensity
    u.uSpeed.value = starSpeed
    u.uSaturation.value = saturation
    u.uStarSize.value = starSize
    u.uRepel.value = mouseRepulsion ? 1 : 0
  }, [glowIntensity, flareIntensity, starSpeed, saturation, starSize, mouseRepulsion])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined

    /* 异步闭包：three 在这里才被下载。disposed 是竞态护栏 ——
       用户 2.9 秒就关掉页面时，import 回来还能阻止后半段执行。 */
    let disposed = false
    let cleanup = null

    const start = async () => {
      /* ── 闸 ①：用户要求减少动效，就别动 ── */
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')
      if (reduce?.matches) return

      /* ── 闸 ②：没有 WebGL 就静默退出 ──
         （ NebulaCanvas 已经兜了底，这里不必再报一次警） */
      const probe = document.createElement('canvas')
      const gl = probe.getContext('webgl') || probe.getContext('experimental-webgl')
      if (!gl) return

      /* 真正下载 three.js 的时刻（独立 chunk） */
      const THREE = await import('three')
      if (disposed) return

      let w = window.innerWidth
      let h = window.innerHeight
      const dpr = Math.min(window.devicePixelRatio || 1, 2)

      /* 粒子数：基数 × density。手机上砍到 1/3 ——
         手机 GPU 弱、电量金贵，几千颗 additive 的点已经够看。
         下限 500：density 传 0.1 也不会少到看不出是星系。 */
      const isSmall = w < 768
      const base = isSmall ? 4000 : 12000
      const COUNT = Math.max(500, Math.round(base * Math.max(0.1, density)))

      /* ── 粒子属性（全部一次提交给 GPU）─────────────────────────────
         星系分三部分，颜色随半径从暖（金/粉）过渡到冷（紫/青）：
           ① 核球（1/6）：密、小、暖 —— 中心那团亮核
           ② 旋臂（3/4）：沿三条对数螺旋撒点，内密外疏
           ③ 远晕（1/12）：稀疏冷色，撒到 26~70 半径外，撑出空间深度 */
      const pos = new Float32Array(COUNT * 3)
      const seed = new Float32Array(COUNT)
      const size = new Float32Array(COUNT)
      const col = new Float32Array(COUNT * 3)

      /* 近似高斯：三个均匀分布相加。比 Box-Muller 省事，视觉上够用。 */
      const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.9
      const pick = (a, b) => (Math.random() < 0.5 ? a : b)

      for (let i = 0; i < COUNT; i++) {
        const kind = i % 12
        let x, y, z, r, c

        if (kind === 0 || kind === 1) {
          /* 核球：半径压得小（pow 1.7 让点往中心堆），y 方向略厚 */
          r = Math.pow(Math.random(), 1.7) * 7
          const theta = Math.random() * Math.PI * 2
          x = r * Math.cos(theta)
          z = r * Math.sin(theta)
          y = gauss() * 2.6
          c = Math.random() < 0.7 ? GOLD : AMBER
          size[i] = 0.6 + Math.random() * 1.1
        } else if (kind === 7) {
          /* 远晕：冷色、大范围、扁平 */
          r = 26 + Math.random() * 44
          const theta = Math.random() * Math.PI * 2
          x = r * Math.cos(theta)
          z = r * Math.sin(theta)
          y = gauss() * 9
          c = Math.random() < 0.5 ? VIOLET : CYAN
          size[i] = 0.8 + Math.random() * 1.4
        } else {
          /* 旋臂：t^0.62 让内圈更密；0.16 是螺距（每单位半径卷多少弧度）；
             随机偏移随半径变大 —— 外圈撒得开，才看得出「臂」的形状 */
          const t = Math.pow(Math.random(), 0.62)
          r = 6 + t * 34
          const arm = Math.floor(Math.random() * 3)
          const scatter = gauss() * 0.45 * (1 - t * 0.5)
          const theta = arm * (Math.PI * 2 / 3) + r * 0.16 + scatter
          x = r * Math.cos(theta)
          z = r * Math.sin(theta)
          y = gauss() * (1.0 + t * 1.8)
          c = r < 20 ? pick(GOLD, PINK) : r < 32 ? pick(VIOLET, PINK) : pick(CYAN, VIOLET)
          size[i] = 0.9 + Math.random() * 2.1
        }

        pos[i * 3] = x
        pos[i * 3 + 1] = y
        pos[i * 3 + 2] = z
        seed[i] = Math.random()
        col[i * 3] = c[0]
        col[i * 3 + 1] = c[1]
        col[i * 3 + 2] = c[2]
      }

      /* 相机：斜俯视（y=17）—— 正俯视像盘子，平视像一条线，
         这个角度才像「悬浮在宇宙里的星系」。 */
      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 260)

      /* 竖屏（手机）时把相机拉远：星系半径 70，竖屏水平视野窄，
         不拉远就只能看到中间一条。 */
      const fitZ = (ww, hh) => 74 * (ww / hh < 1 ? 1.7 : 1)
      camera.position.set(0, 17, fitZ(w, h))
      camera.lookAt(0, 0, 0)

      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3))

      const uniforms = {
        uTime:       { value: 0 },
        uDpr:        { value: dpr },
        uK:          { value: 150 },                 /* 配合 fitZ(桌面)=74 调的 */
        uSpeed:      { value: starSpeed },
        uStarSize:   { value: starSize },
        uGlow:       { value: glowIntensity },
        uFlare:      { value: flareIntensity },
        uSaturation: { value: saturation },
        uMouse:      { value: new THREE.Vector2(9999, 9999) },  /* 9999 = 远离场，等效「没鼠标」 */
        uRepel:      { value: mouseRepulsion ? 1 : 0 },
        uWarpPos:    { value: new THREE.Vector2(0, 0) },
        uWarp:       { value: 0 },
        uWarpR:      { value: 0 },
      }
      uniformsRef.current = uniforms

      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms,
        transparent: true,
        depthWrite: false,           /* 粒子互相之间不遮，才会叠出亮度 */
        blending: THREE.AdditiveBlending,
      })

      const points = new THREE.Points(geo, mat)
      scene.add(points)

      const renderer = new THREE.WebGLRenderer({
        canvas, alpha: true, antialias: false, powerPreference: 'high-performance',
      })
      renderer.setClearColor(0x000000, 0)   /* 全透明 —— 让底下的星云透出来 */
      renderer.setPixelRatio(dpr)
      renderer.setSize(w, h, false)         /* false = 不碰 style，尺寸由 CSS 管 */

      /* ── 屏幕坐标 → 星系平面（y=0）的世界坐标 ──
         排斥和冲击波都在这个平面里算，所以鼠标/点击要先「投影」进来。
         ⚠️ unproject 依赖 camera.matrixWorld —— lookAt 之后它不会自己更新，
            必须先 updateMatrixWorld()，否则第一次调用会用到单位矩阵（原点），
            表现是「鼠标排斥时好时坏」。这个坑踩过，写在这儿。 */
      const ndc = new THREE.Vector2()
      const ray = new THREE.Vector3()
      const toPlane = (clientX, clientY) => {
        camera.updateMatrixWorld()
        ndc.set((clientX / w) * 2 - 1, -(clientY / h) * 2 + 1)
        ray.set(ndc.x, ndc.y, 0.5).unproject(camera)
        ray.sub(camera.position).normalize()
        if (Math.abs(ray.y) < 1e-4) return null    /* 视线与平面平行，别除零 */
        const t = -camera.position.y / ray.y
        if (t <= 0) return null                    /* 交点在相机背后，忽略 */
        const hit = camera.position.clone().add(ray.multiplyScalar(t))
        return hit
      }

      /* ── 交互 ①：鼠标排斥 ── */
      const onMove = (e) => {
        if (!cfgRef.current.mouseRepulsion) return
        const hit = toPlane(e.clientX, e.clientY)
        if (!hit) return
        uniforms.uMouse.value.set(hit.x, hit.z)
        uniforms.uRepel.value = 1
      }
      window.addEventListener('mousemove', onMove, { passive: true })

      /* 触屏：手指滑动也算「鼠标」（手机上没鼠标可排斥） */
      const onTouch = (e) => {
        if (!cfgRef.current.mouseRepulsion) return
        if (e.touches.length === 0) return
        const hit = toPlane(e.touches[0].clientX, e.touches[0].clientY)
        if (!hit) return
        uniforms.uMouse.value.set(hit.x, hit.z)
        uniforms.uRepel.value = 1
      }
      window.addEventListener('touchmove', onTouch, { passive: true })

      /* ── 交互 ②：点击冲击波 ──
         画布是 pointer-events:none（不能挡内容的点击），
         所以这里监听 **window** 的 click —— 点哪儿都能触发，
         冒泡上来正好。对内容按钮毫无影响。 */
      const WARP_LIFE = 1.1      /* 冲击波从发射到消失的时长（秒） */
      const WARP_MAX_R = 48      /* 最终扩散半径 */
      let warpT = 1              /* 1 = 已结束 */
      const warpFrom = new THREE.Vector2(0, 0)

      const onClick = (e) => {
        if (!cfgRef.current.clickWarp) return
        const hit = toPlane(e.clientX, e.clientY)
        if (hit) warpFrom.set(hit.x, hit.z)
        else warpFrom.set(0, 0)
        warpT = 0
      }
      window.addEventListener('click', onClick)

      const onResize = () => {
        w = window.innerWidth
        h = window.innerHeight
        const z = fitZ(w, h)
        camera.position.set(0, 17, z)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        /* 相机拉远了，点尺寸系数跟着放大，否则星星会整体小一圈 */
        uniforms.uK.value = 150 * (z / 74)
        renderer.setSize(w, h, false)
      }
      window.addEventListener('resize', onResize)

      /* ── 闸 ③：页面切后台就停渲染（笔记本/手机上很省） ── */
      let visible = true
      const onVis = () => { visible = document.visibilityState === 'visible' }
      document.addEventListener('visibilitychange', onVis)

      const clock = new THREE.Clock()
      let raf = 0

      const frame = () => {
        raf = requestAnimationFrame(frame)
        if (!visible) return

        const dt = Math.min(clock.getDelta(), 0.05)   /* 切回来时别跳一大步 */
        uniforms.uTime.value += dt

        /* 冲击波推进：半径走 smoothstep（先慢后快再收），强度 1.6 次方衰减 */
        if (warpT < 1) {
          warpT = Math.min(1, warpT + dt / WARP_LIFE)
          const k = warpT * warpT * (3 - 2 * warpT)
          uniforms.uWarpPos.value.copy(warpFrom)
          uniforms.uWarpR.value = k * WARP_MAX_R
          uniforms.uWarp.value = warpT >= 1 ? 0 : Math.pow(1 - warpT, 1.6)
        }

        renderer.render(scene, camera)
      }
      raf = requestAnimationFrame(frame)

      cleanup = () => {
        cancelAnimationFrame(raf)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('touchmove', onTouch)
        window.removeEventListener('click', onClick)
        window.removeEventListener('resize', onResize)
        document.removeEventListener('visibilitychange', onVis)
        geo.dispose()
        mat.dispose()
        renderer.dispose()
        /* 主动丢掉 WebGL 上下文：浏览器能开的 context 有上限（Chrome 约 16 个），
           不释放的话反复挂载/卸载会把它耗光。 */
        renderer.forceContextLoss?.()
      }
    }

    start()

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,          /* 与 NebulaCanvas 同级，DOM 在后 → 画在星云上面 */
        pointerEvents: 'none',
      }}
    />
  )
}
