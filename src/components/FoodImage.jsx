import { useEffect, useRef, useState } from 'react'
import { resolveFoodImage } from '../lib/foodImages.js'

/* ═══════════════════════════════════════════════════════════════════════
   FoodImage · 美食图片组件（真实图片 + 程序化占位图双轨）
   ─────────────────────────────────────────────────────────────────────
   优先加载真实美食摄影图（按名称关键词匹配），没有匹配时回退到
   Canvas 2D 程序化生成的暗调抽象艺术图。

   每张程序化图由菜品名称哈希驱动（同名同图），确保重新渲染时不会跳动。
   生成过程放在 useEffect + requestAnimationFrame 中异步执行，避免阻塞首屏。
   ═══════════════════════════════════════════════════════════════════════ */

function makeRng(seed) {
  let s = seed | 0
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

function stringHash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0
  }
  return h
}

function generateFoodImage(name, type, width = 360, height = 220) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  const seed = stringHash(name)
  const rng = makeRng(seed)
  const baseHue = type === 'dish' ? 38 : 330

  ctx.fillStyle = `hsl(${baseHue}, 25%, 5%)`
  ctx.fillRect(0, 0, width, height)

  for (let i = 0; i < 4; i++) {
    const bx = rng() * width
    const by = rng() * height
    const br = 60 + rng() * 120
    const bh = baseHue + (rng() - 0.5) * 50
    const grad = ctx.createRadialGradient(bx, by, 0, bx, by, br)
    grad.addColorStop(0, `hsla(${bh}, ${55 + rng() * 25}%, ${18 + rng() * 12}%, ${0.12 + rng() * 0.15})`)
    grad.addColorStop(1, `hsla(${bh}, ${55 + rng() * 25}%, ${18 + rng() * 12}%, 0)`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, width, height)
  }

  for (let i = 0; i < 3; i++) {
    const cx = width * (0.2 + rng() * 0.6)
    const cy = height * (0.2 + rng() * 0.6)
    const r = 30 + rng() * 60
    const h = baseHue + (rng() - 0.5) * 40
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    grad.addColorStop(0, `hsla(${h}, ${60 + rng() * 30}%, ${30 + rng() * 20}%, ${0.2 + rng() * 0.2})`)
    grad.addColorStop(1, `hsla(${h}, ${60 + rng() * 30}%, ${30 + rng() * 20}%, 0)`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, width, height)
  }

  const gx = width * (0.4 + rng() * 0.2)
  const gy = height * (0.35 + rng() * 0.3)
  const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, 80 + rng() * 50)
  const glowHue = baseHue + (rng() - 0.5) * 20
  glow.addColorStop(0, `hsla(${glowHue}, 80%, 45%, 0.25)`)
  glow.addColorStop(0.5, `hsla(${glowHue}, 70%, 30%, 0.1)`)
  glow.addColorStop(1, `hsla(${glowHue}, 70%, 30%, 0)`)
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, width, height)

  for (let i = 0; i < 400; i++) {
    const x = rng() * width
    const y = rng() * height
    const s = rng() < 0.8 ? 1 : 1 + rng() * 2
    const light = 30 + rng() * 50
    const alpha = 0.04 + rng() * 0.1
    ctx.fillStyle = `hsla(${baseHue + (rng() - 0.5) * 30}, 30%, ${light}%, ${alpha})`
    ctx.fillRect(x, y, s, s)
  }

  const streakY = height * (0.3 + rng() * 0.4)
  const streakGrad = ctx.createLinearGradient(0, streakY - 20, 0, streakY + 20)
  streakGrad.addColorStop(0, `hsla(${baseHue}, 60%, 50%, 0)`)
  streakGrad.addColorStop(0.5, `hsla(${baseHue}, 60%, 50%, 0.08)`)
  streakGrad.addColorStop(1, `hsla(${baseHue}, 60%, 50%, 0)`)
  ctx.fillStyle = streakGrad
  ctx.fillRect(0, streakY - 20, width, 40)

  return canvas.toDataURL('image/png')
}

/* 占位图缓存：同一个「名字 + 类型」算一次就够了。
   ⚠️ 为什么要缓存：抽奖轮播是 80ms 换一次名字，切回同一个名字时如果还要重算
      （400 个粒子 + 5 层渐变，几十毫秒），那几十毫秒里就会露出上一道菜的图。
      缓存命中时是**同步** setSrc，没有空窗。 */
const placeholderCache = new Map()

function cacheKeyOf(name, type) {
  return `${type || 'dish'}|${name || ''}`
}

export default function FoodImage({ name, type, className = '' }) {
  const cacheKey = cacheKeyOf(name, type)

  /* ⚠️ 关键：**真实图和已缓存的占位图都在渲染期间同步算**，不放 useEffect。
     useEffect 在浏览器**绘制之后**才执行 —— 里面 setSrc 永远慢一帧，
     那一帧就是「兰州拉面」配着上一道菜的「辣子鸡」图（Day 24 实测抓到过 240ms 那一帧）。
     resolveFoodImage 是纯查表、placeholderCache 是同步 Map，都没有副作用，
     完全可以、也应该在 render 里算。 */
  const realPath = resolveFoodImage(name)
  const isReal = Boolean(realPath)
  const cachedPlaceholder = realPath ? '' : placeholderCache.get(cacheKey) || ''

  /* 还没生成过的占位图才需要异步（canvas 画 400 个粒子要几十毫秒，塞进渲染会掉帧）。
     存的时候带上 cacheKey：只认「属于当前这道菜」的结果，上一道菜的结果不许顶上。 */
  const [generated, setGenerated] = useState({ key: '', src: '' })
  const rafRef = useRef(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (realPath) return // 有真实图，不需要生成
    if (placeholderCache.has(cacheKey)) return // 缓存已有，渲染时已经同步取到

    rafRef.current = requestAnimationFrame(() => {
      try {
        const dataUrl = generateFoodImage(name, type)
        placeholderCache.set(cacheKey, dataUrl)
        setGenerated({ key: cacheKey, src: dataUrl })
      } catch (e) {
        console.warn('[FoodImage] generate failed:', e)
      }
    })
    return () => cancelAnimationFrame(rafRef.current)
  }, [cacheKey, name, type, realPath])

  /* 取值顺序：真实图 → 已缓存占位图 → 本次生成的（且必须属于当前这道菜）。
     三者都拿不到就显示底色块 —— **宁可空着，绝不显示别人的菜**。 */
  const src = realPath || cachedPlaceholder || (generated.key === cacheKey ? generated.src : '')

  if (!src) {
    return (
      <div
        className={className}
        style={{
          background: type === 'dish'
            ? 'linear-gradient(135deg, hsl(38,25%,8%) 0%, hsl(38,25%,5%) 100%)'
            : 'linear-gradient(135deg, hsl(330,25%,8%) 0%, hsl(330,25%,5%) 100%)',
        }}
        aria-hidden="true"
      />
    )
  }

  return (
    <img
      /* ⚠️ key={src}：换图时让 React **重建** <img>，而不是原地改 src。
         原地改 src 时，浏览器会一直显示上一张（stale image）直到新图解码完 ——
         那张 jpg 有 1MB+，慢的时候能挂住一秒，"名字和图对不上"就是这么来的。
         重建的代价是空一帧底色，但绝不会张冠李戴。 */
      key={src}
      src={src}
      alt={isReal ? name : ''}
      className={`${className}${isReal ? ' is-real' : ''}`}
      loading="lazy"
      aria-hidden={!isReal}
    />
  )
}
