import { useEffect, useMemo, useRef, useState } from 'react'
import {
  SPICY_LABEL,
  SPICY_MAX_OPTIONS,
  TAG_PRESETS,
  TYPE_LABEL,
  VIEW_STATE,
} from '../lib/constants.js'
import { collectTags } from '../lib/filter.js'
import { platformSearchLabel, platformSearchUrl } from '../lib/platformLink.js'
import EmptyState from '../components/EmptyState.jsx'
import FoodImage from '../components/FoodImage.jsx'
import ViewState from '../components/ViewState.jsx'

/* 页面 2 · 我的清单（杂志交替大图卡片版）
   ─────────────────────────────────────────────────────────────────────
   抛弃传统的"垂直列表"和之前"左右偏移"的不稳定感，改为：
   · 顶部：大标题 + 水平滚动过滤 pills
   · 主体：全宽交替大图卡片流
     - 奇数项：左图（42%）右文，图片左侧大圆角
     - 偶数项：左文右图（42%），图片右侧大圆角
   · 卡片有真实美食图、玻璃态背景、hover 抬起发光
   · 移动端自动改为上图下文垂直堆叠
   ═══════════════════════════════════════════════════════════════════════ */

export default function List({
  items,
  filter,
  stateOverride,
  errorActions,
  errorText,
  onRetry,
  onRemove,
  onRestore,
  onFilterChange,
}) {
  const [customTag, setCustomTag] = useState('')

  /* ── 删除的三样状态（Day 22 新增）─────────────────────────────────────
     为什么要把它们分开，而不是一个"删除中"的布尔：

       · `confirmId` —— 哪一条**正在等你确认**（点了删除、还没点确认）
       · `pendingId` —— 哪一条**正在删**（请求已经发出去、还没回来）
       · `notice`    —— 页面级的一句提示（删失败了、或者"本来就没了"）

     ⚠️ **为什么不用 `window.confirm()`**：原生弹窗是浏览器画的，跟这个页面
        不是一个世界；更要紧的是 —— 删除现在**要走网络**，会等待、会失败，
        而弹窗那套"点了确定就一定成功"的假设不成立了。状态得自己管。

     ⚠️ **为什么确认态会自动收回**（而不是一直挂着等人点）：
        用户手滑点了"删除"、转身去做别的，这行字要是一直挂着，
        等他绕回来看到，还以为是自己刚点的 —— 状态"粘住"比没提示更糟。
        所以到点自己收，让他重新来一遍。
        ⚠️ 但**收回的时限（6 秒）不是项目里那条"确认类反馈 2.5 秒"** ——
           两者不是一回事，见 askRemove 里的说明。 */
  const [confirmId, setConfirmId] = useState(null)
  const [pendingId, setPendingId] = useState(null)
  const [notice, setNotice] = useState(null)

  /* 三个计时器，都在卸载时清掉 —— 否则回调会在已卸载的组件上 setState */
  const confirmTimer = useRef(null)
  const noticeFadeTimer = useRef(null)
  const noticeGoneTimer = useRef(null)
  useEffect(
    () => () => {
      clearTimeout(confirmTimer.current)
      clearTimeout(noticeFadeTimer.current)
      clearTimeout(noticeGoneTimer.current)
    },
    []
  )

  /* 点「删除」→ 进入待确认（**这一步不真删**）。
     ⚠️ 思考窗口给 **6 秒**，而不是项目里那条"确认类反馈 2.5 秒"的约定 ——
        两者不是一回事，别照搬：
          · "已切换 / 已保存"那类**结果提示**，用户瞟一眼就懂了，2.5 秒够
          · 这里是**等用户做决定**（真删，还是算了）。2.5 秒太赶 ——
            用户刚点完、还在认卡片上的字，确认框就自己收了，
            他只能再点一次，像在跟界面较劲（Day 22 实测：两次截图都没抓住这个窗口，
            说明 2.5 秒确实短了）。
        6 秒是折中：够看完、够决定；又不会一直挂着（挂久了用户会以为
        "这个按钮本来就是这样"，下次点删除就当没确认）。 */
  function askRemove(id) {
    clearTimeout(confirmTimer.current)
    setNotice(null)
    setConfirmId(id)
    confirmTimer.current = setTimeout(() => setConfirmId(null), 6000)
  }

  /* 点「取消」→ 收回确认态 */
  function cancelRemove() {
    clearTimeout(confirmTimer.current)
    setConfirmId(null)
  }

  /* 点「确认删除」→ 真删。等 App 那边的结果（它负责调接口 + 同步本地） */
  async function doRemove(item) {
    clearTimeout(confirmTimer.current)
    setConfirmId(null)
    setNotice(null)
    setPendingId(item.id)

    // ⚠️ 这里 await 的是**网络**。期间按钮写着「删除中…」，
    //    并且 aria-disabled 挡着不让再点（不然会同一条删两次）
    const res = await onRemove(item.id)

    setPendingId(null)

    if (res?.ok) {
      // 云端本来就没有这条 → 不算错，说一句让用户知道（不然他会奇怪"怎么没提示"）
      if (res.alreadyGone) showNotice('ok', `「${item.name}」早已经不在云端了，顺手清掉了。`)
      return
    }
    showNotice('err', `没删掉「${item.name}」：${res?.message || '未知原因'}`)
  }

  /* 页面级提示：显示 5.5 秒 → 淡出 0.5 秒 → 移除。
     淡出用 opacity（元素留到最后一刻），这是项目里统一的反馈做法。 */
  function showNotice(kind, text) {
    clearTimeout(noticeFadeTimer.current)
    clearTimeout(noticeGoneTimer.current)
    setNotice({ kind, text, fading: false })
    noticeFadeTimer.current = setTimeout(
      () => setNotice((n) => (n ? { ...n, fading: true } : n)),
      5500
    )
    noticeGoneTimer.current = setTimeout(() => setNotice(null), 6000)
  }

  const state =
    stateOverride ?? (items.length === 0 ? VIEW_STATE.empty : VIEW_STATE.success)
  const isBusy = state === VIEW_STATE.loading || state === VIEW_STATE.error

  const userCount = items.filter((it) => it.source === 'user').length

  const tagOptions = useMemo(() => {
    return [...new Set([...TAG_PRESETS, ...collectTags(items)])]
  }, [items])

  const excludeTags = Array.isArray(filter?.excludeTags) ? filter.excludeTags : []

  function toggleTag(tag) {
    const next = excludeTags.includes(tag)
      ? excludeTags.filter((t) => t !== tag)
      : [...excludeTags, tag]
    onFilterChange({ excludeTags: next })
  }

  function addCustomTag() {
    const tag = customTag.trim()
    if (!tag) return
    if (!excludeTags.includes(tag)) onFilterChange({ excludeTags: [...excludeTags, tag] })
    setCustomTag('')
  }

  if (isBusy) {
    return (
      <ViewState
        state={state}
        errorActions={errorActions}
        errorText={errorText}
        onRetry={onRetry}
      />
    )
  }

  const isEmpty = state === VIEW_STATE.empty

  return (
    <div className="list-magazine">
      {/* 标题区 */}
      <header className="list-magazine-header">
        <div className="list-magazine-headline">
          <h1 className="list-magazine-title">我的清单</h1>
          {items.length > 0 && (
            <span className="list-magazine-count">{items.length}</span>
          )}
        </div>
        <p className="list-magazine-sub">
          {isEmpty
            ? '还没添加任何美食'
            : `${items.length} 个候选 · ${userCount} 个自己添加`}
        </p>

        {/* 过滤条 */}
        {!isEmpty && (
          <div className="list-magazine-filters">
            <div className="filter-group">
              <span className="filter-label">辣度</span>
              <select
                className="select filter-select"
                value={filter?.spicyMax ?? 'any'}
                onChange={(e) => onFilterChange({ spicyMax: e.target.value })}
              >
                {SPICY_MAX_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {SPICY_LABEL[v]}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-pill-scroll">
              {tagOptions.map((tag) => {
                const on = excludeTags.includes(tag)
                return (
                  <button
                    key={tag}
                    className={`filter-pill ${on ? 'on' : ''}`}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    aria-pressed={on}
                  >
                    {on ? '✕ ' : ''}
                    {tag}
                  </button>
                )
              })}
            </div>

            <div className="filter-custom">
              <input
                className="input filter-input"
                value={customTag}
                placeholder="自定义忌口…"
                onChange={(e) => setCustomTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addCustomTag()
                  }
                }}
              />
              <button
                className="btn ghost filter-add"
                type="button"
                onClick={addCustomTag}
              >
                加
              </button>
            </div>
          </div>
        )}
      </header>

      {isEmpty ? (
        <EmptyState
          title="清单还是空的"
          text="加几个常吃的进来，或者把默认库补回来。"
        >
          <a className="btn" href="#/add">
            去添加
          </a>
          <button className="btn ghost" type="button" onClick={onRestore}>
            恢复默认库
          </button>
        </EmptyState>
      ) : (
        <>
          {/* 页面级提示：删失败、或者"云端本来就没有这条"。
              role="status" 让读屏软件也念出来 —— 不该只有看得见的人知道。

              ⚠️ 类名写成**字面量**（不用 `card-notice ${notice.kind}` 那种拼法）：
                 静态检查（check_criteria 那套脚本）才搜得到这些类名，
                 拼接出来的动态类名它查不到，会误报"样式没定义"。 */}
          {notice && (
            <p
              className={
                notice.kind === 'ok'
                  ? notice.fading
                    ? 'card-notice ok is-fading'
                    : 'card-notice ok'
                  : notice.fading
                    ? 'card-notice err is-fading'
                    : 'card-notice err'
              }
              role="status"
            >
              {notice.text}
            </p>
          )}

          <div className="list-magazine-flow">
            {items.map((item, index) => {
              const tags = Array.isArray(item.tags) ? item.tags : []
              const searchUrl = platformSearchUrl(item.platform, item.name)
              const searchLbl = platformSearchLabel(
                item.platform,
                item.name,
                item.platform === 'tb' ? '淘宝' : '美团'
              )
              const isFlipped = index % 2 === 1
              /* 这一条是不是在"等你确认"、是不是"正在删"（见上面的说明） */
              const isConfirming = confirmId === item.id
              const isPending = pendingId === item.id

              return (
                <article
                  key={item.id}
                  className={`magazine-card ${isFlipped ? 'flipped' : ''}`}
                  style={{ animationDelay: `${Math.min(index * 60, 600)}ms` }}
                >
                  <div className="magazine-card-visual">
                    <FoodImage
                      name={item.name}
                      type={item.type}
                      className="magazine-card-img"
                    />
                    <div className="magazine-card-img-overlay" />
                  </div>

                  <div className="magazine-card-body">
                    <div className="magazine-card-meta">
                      <span
                        className={`magazine-card-type ${item.type}`}
                      >
                        {TYPE_LABEL[item.type]}
                      </span>
                      {item.source === 'user' && (
                        <span className="magazine-card-source">我加的</span>
                      )}
                    </div>

                    <h3 className="magazine-card-name">{item.name}</h3>

                    <div className="magazine-card-tags">
                      <span className="badge">{SPICY_LABEL[item.spicy]}</span>
                      {tags.map((tag) => (
                        <span className="badge tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>

                    <div className="magazine-card-actions">
                      {searchUrl ? (
                        <a
                          className="magazine-card-link"
                          href={searchUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={searchLbl}
                        >
                          去{item.platform === 'tb' ? '淘宝' : '美团'}搜 →
                        </a>
                      ) : (
                        <span className="magazine-card-link disabled">
                          未指定平台
                        </span>
                      )}
                      {/* 删除区（Day 22：二次确认 + 删除中状态）。
                          三个元素**始终都在 DOM 里**，只靠 class 切换显示 ——
                          这样"点删除 → 出现确认"不会重建 DOM：重建会让键盘焦点
                          掉回 BODY，用户 Tab 到一半的位置就丢了。
                          藏起来用的是 display:none —— 它同时把元素移出 Tab 顺序，
                          所以不用担心"看不见却还能 Tab 到"。 */}
                      <div className={`card-delete ${isConfirming ? 'is-confirming' : ''}`}>
                        <span className="card-delete-ask">确定删掉？</span>
                        <button
                          className="magazine-card-delete"
                          type="button"
                          onClick={() => {
                            /* ⚠️ aria-disabled **不阻止点击**（它只是告诉读屏"现在不可用"），
                               所以防连点得在这里自己拦一道 —— 否则同一条会被删两次，
                               第二次必然 404，白让用户看一条错误提示。 */
                            if (isPending) return
                            if (isConfirming) doRemove(item)
                            else askRemove(item.id)
                          }}
                          aria-label={isConfirming ? `确认删除 ${item.name}` : `删除 ${item.name}`}
                          /* 用 aria-disabled 而不是原生 disabled ——
                             后者会把键盘焦点踢到 BODY 且不还回来（项目约定） */
                          aria-disabled={isPending || undefined}
                        >
                          {isPending ? '删除中…' : isConfirming ? '确认删除' : '删除'}
                        </button>
                        <button
                          className="card-delete-cancel"
                          type="button"
                          onClick={cancelRemove}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>

          <div className="list-magazine-footer">
            <button
              className="btn ghost wide"
              type="button"
              onClick={onRestore}
            >
              恢复默认库
            </button>
          </div>
        </>
      )}
    </div>
  )
}
