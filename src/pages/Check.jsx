import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE, createItem, fetchHealth, fetchItems } from '../lib/api.js'

/* 页面 5 · 检查台（Day 20）
   ═══════════════════════════════════════════════════════════════════
   给**开发和验收**看的一页，回答三个问题：
     ① 后端活着吗？          → GET /api/health（不查库，最轻）
     ② 数据库里有多少数据？   → GET /api/items
     ③ 能不能写得进去？       → POST /api/items（一次**真实**的写入）

   ⚠️ **故意不放进顶部导航**：那四个页面是给客户用的，检查台是给自己用的。
      地址栏敲 `#/check` 就能进，客户的菜单里不会多这一项。
      （他要求"给客户用要正式"—— 页面上也不该出现"检查台"这种词。）
   ═══════════════════════════════════════════════════════════════════ */

const STATE = { idle: 'idle', loading: 'loading', ok: 'ok', fail: 'fail' }

/** 记一下"数据是什么时候拉的" —— 排查时有用：
    页面上的数字是刚才的，还是十分钟前的？ */
function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export default function Check() {
  const [health, setHealth] = useState({ status: STATE.loading })
  const [table, setTable] = useState({ status: STATE.loading })
  const [write, setWrite] = useState({ status: STATE.idle })
  const [busy, setBusy] = useState(false)

  /* 防连点：和 Add.jsx 一样用 **ref**，而不是看 busy 状态 ——
     setState 是异步的，同一帧里连点多次时 `busy` 还是 false，`if (busy) return` 拦不住。

     🔴 2026-10-17 实测（Day 24）：连点 5 次 → 5 个 POST 全发出去
        → 1 个 201 + 4 个 409（名字只精确到秒，同秒必撞）
        → **最后那个 409 把 201 的成功提示覆盖掉**，界面显示「写失败」，
          可数据其实已经写进去了 —— 用户以为没成功，会再点一次，写出更多重复。

     ref 是同步的：赋值那一刻就生效，同一帧的后续点击立刻能看到。 */
  const busyRef = useRef(false)

  /* ① 健康检查 */
  const runHealth = useCallback(async () => {
    setHealth({ status: STATE.loading })
    try {
      const { service, ms } = await fetchHealth()
      setHealth({ status: STATE.ok, service, ms })
    } catch (err) {
      setHealth({ status: STATE.fail, msg: err?.message || '连不上服务器' })
    }
  }, [])

  /* ② 读核心表 */
  const runTable = useCallback(async () => {
    setTable({ status: STATE.loading })
    try {
      const { items, total } = await fetchItems()
      setTable({ status: STATE.ok, rows: items, total, at: Date.now() })
    } catch (err) {
      setTable({ status: STATE.fail, msg: err?.message || '读不到数据' })
    }
  }, [])

  useEffect(() => {
    runHealth()
    runTable()
  }, [runHealth, runTable])

  /* ③ 写入测试 —— 真发一次 POST，往库里写一条 */
  async function runWrite() {
    if (busyRef.current) return // 同步锁：同一帧只放行一次（这才是真正拦住连点的那道）
    busyRef.current = true
    setBusy(true)
    setWrite({ status: STATE.loading })

    /* 名字带时间戳，**保证不撞重名** —— 这一条测的是"能不能写进去"，
       不是"重名会不会被拒"（那是另一件事，Day 18 已经验过了）。 */
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const name = `检查台测试${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

    try {
      const { item } = await createItem({
        name,
        type: 'shop',
        platform: 'any',
        spicy: 'any',
        tags: [],
      })
      setWrite({ status: STATE.ok, name: item.name, id: item.id })
      runTable() // 写完顺手刷一下表 —— 能亲眼看到条数 +1
    } catch (err) {
      setWrite({ status: STATE.fail, msg: err?.message || '写入失败' })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="check-page">
      {/* ⚠️ 这里**不写 h1** —— 页面标题（「检查台」+ 那句说明）由 App.jsx 统一渲染。
          自己再写一个，页面上就会连着出现两遍（Day 20 实测踩到）。 */}

      {/* ① 接口健康 */}
      <section className="check-card">
        <div className="check-card-head">
          <h2 className="check-card-title">① 接口健康</h2>
          <button className="btn ghost small" type="button" onClick={runHealth}>
            重新检查
          </button>
        </div>
        {health.status === STATE.loading && <p className="check-line dim">检查中…</p>}
        {health.status === STATE.ok && (
          <p className="check-line ok">
            <span className="dot" aria-hidden="true" />
            后端活着　·　服务名 <b>{health.service}</b>　·　往返 <b>{health.ms} ms</b>
          </p>
        )}
        {health.status === STATE.fail && (
          <p className="check-line fail">
            <span className="dot" aria-hidden="true" />
            连不上：{health.msg}
          </p>
        )}
      </section>

      {/* ② 核心表真实数据 */}
      <section className="check-card">
        <div className="check-card-head">
          <h2 className="check-card-title">② 核心表 items 的真实数据</h2>
          <button className="btn ghost small" type="button" onClick={runTable}>
            重新读取
          </button>
        </div>

        {table.status === STATE.loading && <p className="check-line dim">读取中…</p>}
        {table.status === STATE.fail && (
          <p className="check-line fail">
            <span className="dot" aria-hidden="true" />
            读不到：{table.msg}
          </p>
        )}
        {table.status === STATE.ok && (
          <>
            <p className="check-line ok">
              <span className="dot" aria-hidden="true" />
              共 <b>{table.total}</b> 行
            </p>
            <ul className="check-rows">
              {table.rows.slice(0, 6).map((it) => (
                <li key={it.id} className="check-row">
                  <span className="check-row-name">{it.name}</span>
                  <span className="check-row-meta">
                    {it.type === 'shop' ? '店' : '菜'} · {it.platform} · {it.source}
                  </span>
                </li>
              ))}
            </ul>
            {table.total > 6 && (
              <p className="check-line dim">…… 还有 {table.total - 6} 条没列出来</p>
            )}
          </>
        )}
      </section>

      {/* ③ 一次写入测试 */}
      <section className="check-card">
        <div className="check-card-head">
          <h2 className="check-card-title">③ 写入测试</h2>
          <button
            className="btn small"
            type="button"
            onClick={runWrite}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
          >
            {busy ? '写入中…' : '写一条试试'}
          </button>
        </div>
        <p className="check-line dim">
          真发一次 POST 到接口，名字带时间戳（不会撞重名）。写完上面那块自动刷新。
        </p>
        {write.status === STATE.ok && (
          <p className="check-line ok">
            <span className="dot" aria-hidden="true" />
            写成功了：「<b>{write.name}</b>」
            <br />
            <span className="check-id">id = {write.id}</span>
          </p>
        )}
        {write.status === STATE.fail && (
          <p className="check-line fail">
            <span className="dot" aria-hidden="true" />
            写失败：{write.msg}
          </p>
        )}
      </section>

      {/* 最后更新时间（余力加练）*/}
      <footer className="check-foot">
        数据最后读取于 <b>{formatTime(table.at)}</b>　·　接口地址{' '}
        <code className="check-api">{API_BASE}</code>
      </footer>
    </div>
  )
}
