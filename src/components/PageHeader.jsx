/* 页面顶部：标题 + 副标题 + 「更新时间」。

   「更新时间」的口径（Day 8 爸爸要求首页有它）：
   指的是**清单最近一次被改动的时间**（存在 localStorage 的 meta.updatedAt 里，
   每次增删条目由 storage.js 的 touchUpdatedAt() 写入）。
   **不是**页面渲染时间 —— 那样每次刷新数字都变，等于没有信息量。 */

function formatUpdatedAt(ts) {
  if (!ts) return '还没有改动过'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '还没有改动过'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function PageHeader({ eyebrow, title, subtitle, updatedAt, children }) {
  const label = formatUpdatedAt(updatedAt)

  return (
    <header className="page-header">
      <div className="page-header-main">
        {/* 标题上方的小标签（Day 21 加）。不传 `eyebrow` 就整块不渲染 ——
            所以这是纯加法，别的页面一个字不受影响。 */}
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
        <p className="page-updated">
          <span className="page-updated-label">清单更新于</span>{' '}
          <time dateTime={updatedAt ? new Date(updatedAt).toISOString() : undefined}>{label}</time>
        </p>
      </div>

      {children && <div className="page-header-side">{children}</div>}
    </header>
  )
}
