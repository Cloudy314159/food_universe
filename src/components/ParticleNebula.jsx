import { useEffect, useRef } from 'react'

/* ═══════════════════════════════════════════════════════════════════════
   ParticleNebula · 真三维粒子层
   ─────────────────────────────────────────────────────────────────────
   和 NebulaCanvas 的关系（**两层叠加，不是替换**）：
     · NebulaCanvas = 底色：屏幕空间噪声，4KB，**首屏就在**
     · 本组件      = 上层：真 3D 粒子 + additive 发光，**延迟挂载**

   为什么一定要分层：
     three.js 打包后 100KB+。塞进首屏 →「打开就能看到结果」变慢，
     而背景是**装饰**。装饰可以晚到，内容不能。

   ⚠️ 这个文件里**没有任何静态 `import three`**。
      只有组件真正挂载后，`await import('three')` 才触发下载 ——
      那 100KB 是独立 chunk，首屏 HTML 里连 preload link 都不会有。

   性能与无障碍的三道闸（缺一个都不该上）：
     ① `prefers-reduced-motion` → 直接不渲染
     ② 没有 WebGL → 静默退出（由 NebulaCanvas 兜底）
     ③ 页面切到后台 → 暂停渲染（省电）
   ═══════════════════════════════════════════════════════════════════════ */

/* 顶点着色器：每个粒子的位置**在这里算**，不在 JS 里算。
   ⚠️ 这是整件事的关键：JS 每帧只传一个 u_time，
      十万个新位置是 GPU 并行算出来的。用 for 循环在 JS 里改
      一万个坐标就会掉帧。 */
const VERT = `
  attribute float aSeed;
  attribute float aSize;
  attribute vec3  aColor;

  uniform float uTime;
  uniform float uDpr;

  varying vec3  vColor;
  varying float vTwinkle;

  void main() {
    vec3 pos = position;

    /* 绕中心自转：半径越大转得越慢 —— 像星系，不像整个刚体在转 */
    float r   = length(pos.xz);
    float ang = uTime * (0.055 + 0.09 / (r + 1.2)) + aSeed * 6.2831;
    pos.x = r * cos(ang);
    pos.z = r * sin(ang);

    /* 上下浮动，相位各不同 */
    pos.y += sin(uTime * 0.25 + aSeed * 6.2831) * 0.55;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    /* 近大远小。系数 210 是配合相机退到 z=58 调的 ——
       相机拉远后 -mv.z 变大，不补偿的话粒子会小一圈。 */
    gl_PointSize = aSize * uDpr * (210.0 / max(-mv.z, 0.1));

    /* 每颗星有自己的闪烁频率 */
    vTwinkle = 0.45 + 0.55 * sin(uTime * (0.4 + aSeed * 1.6) + aSeed * 10.0);
    vColor = aColor;
  }
`

/* 片元着色器：把方点画成"会发光的软圆点"。
   核心 + 光晕两层叠加 —— 这是不用 Bloom 也能有发光感的原因：
   亮部向外溢出一截，粒子密集处自然会更亮。 */
const FRAG = `
  precision mediump float;
  varying vec3  vColor;
  varying float vTwinkle;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;                        /* 必须是圆的，不能是方块 */

    float core = smoothstep(0.5, 0.05, d);       /* 实的核心 */
    float halo = pow(1.0 - d * 2.0, 3.0);        /* 外扩的光晕 */
    float a = (core * 0.55 + halo * 0.5) * vTwinkle;

    gl_FragColor = vec4(vColor, a);
  }
`

/* 品牌色（和 --brand 那套一致）：金 / 粉 / 紫 / 青 */
const GOLD = [1.0, 0.78, 0.32]
const PINK = [1.0, 0.45, 0.72]
const VIOLET = [0.68, 0.52, 1.0]
const CYAN = [0.42, 0.86, 1.0]

export default function ParticleNebula() {
  const canvasRef = useRef(null)

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

      /* ── 真正下载 three.js 的时刻（独立 chunk） ── */
      const THREE = await import('three')
      if (disposed) return

      const w = window.innerWidth
      const h = window.innerHeight
      const dpr = Math.min(window.devicePixelRatio || 1, 2)

      /* 粒子数：手机上砍到 1/3。手机 GPU 弱、电量金贵，
         而 5000 颗 additived 的点在手机上已经够看。 */
      const isSmall = w < 768
      const COUNT = isSmall ? 5000 : 14000

      /* ── 粒子属性（全部一次提交给 GPU）─────────────────────────────
         位置不是均匀撒的：内圈密、外围疏，y 方向压扁 ——
         撒成一团球会像雪球，压扁了才像"盘"。
         1/6 的粒子放到远处当"光晕云"，撑出空间感。

         ⚠️ 半径范围是调过的：第一版内圈只到 23、相机在 z=44，
            结果粒子全挤在视口中间，被内容面板一挡，只剩左右两团亮斑。
            现在铺开到 39 / 70，相机退到 58 —— 才像"满天星"而不是"两团光"。 */
      const pos = new Float32Array(COUNT * 3)
      const seed = new Float32Array(COUNT)
      const size = new Float32Array(COUNT)
      const col = new Float32Array(COUNT * 3)

      for (let i = 0; i < COUNT; i++) {
        const far = i % 6 === 0
        const r = far ? 30 + Math.random() * 40
                      : 5 + Math.pow(Math.random(), 0.55) * 34
        const theta = Math.random() * Math.PI * 2

        pos[i * 3] = r * Math.cos(theta)
        pos[i * 3 + 1] = (Math.random() - 0.5) * (far ? 18 : 7)
        pos[i * 3 + 2] = r * Math.sin(theta)

        seed[i] = Math.random()
        size[i] = far ? 5 + Math.random() * 8 : 1.8 + Math.random() * 3

        /* 内圈偏暖（金/粉），外圈偏冷（紫/青）—— 色彩有层次，
           不是一锅乱炖 */
        const c = r < 22
          ? (Math.random() < 0.72 ? GOLD : PINK)
          : (Math.random() < 0.5 ? VIOLET : CYAN)
        col[i * 3] = c[0]
        col[i * 3 + 1] = c[1]
        col[i * 3 + 2] = c[2]
      }

      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 220)
      camera.position.set(0, 8, 58)

      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3))

      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uTime: { value: 0 },
          uDpr: { value: dpr },
        },
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

      /* ── 交互：鼠标视差（lerp 平滑，不做生硬的跟随） ── */
      const target = { x: 0, y: 0 }
      const cur = { x: 0, y: 0 }
      const onMove = (e) => {
        target.x = (e.clientX / w - 0.5) * 2
        target.y = (e.clientY / h - 0.5) * 2
      }
      window.addEventListener('mousemove', onMove, { passive: true })

      const onResize = () => {
        const nw = window.innerWidth
        const nh = window.innerHeight
        camera.aspect = nw / nh
        camera.updateProjectionMatrix()
        renderer.setSize(nw, nh, false)
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
        mat.uniforms.uTime.value += dt

        cur.x += (target.x - cur.x) * 0.03
        cur.y += (target.y - cur.y) * 0.03
        camera.position.x = cur.x * 6
        camera.position.y = 8 - cur.y * 3
        camera.lookAt(0, 0, 0)

        renderer.render(scene, camera)
      }
      raf = requestAnimationFrame(frame)

      cleanup = () => {
        cancelAnimationFrame(raf)
        window.removeEventListener('mousemove', onMove)
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
