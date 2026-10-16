import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  adoptServerData,
  appendHistory,
  appendItem,
  getFilter,
  getHistory,
  getMeta,
  getStorageStatus,
  loadItems,
  removeItem,
  restoreBuiltin,
  setFilter,
  validateNewItem,
} from './lib/storage.js'
import { createItem, deleteItem, fetchHistory, fetchItems } from './lib/api.js'
import { applyFilter, collectTags } from './lib/filter.js'
import { describeError, fetchNextResult } from './lib/drawService.js'
import { SPICY_ANY, TAG_PRESETS, VIEW_STATE } from './lib/constants.js'
import Home from './pages/Home.jsx'
import List from './pages/List.jsx'
import Add from './pages/Add.jsx'
import History from './pages/History.jsx'
import Check from './pages/Check.jsx'
import NebulaCanvas from './components/NebulaCanvas.jsx'

/* 真三维星系层（three.js）—— **动态 import，懒加载**。
   ⚠️ 这里写 `import(...)` 而不是顶部静态 import，就是为了让 three.js
      那 100KB+ 走独立 chunk：只有这个组件真正渲染时才下载，
      首屏 HTML 里连 preload link 都不会有（构建时会验证这一点）。

   2026-10-14：背景从 ParticleNebula（旧粒子层）换成 Galaxy。
   换的原因：旧层「太亮、太糊」—— additive 叠加 + 大光晕，密集处糊成一片。
   新层的 props 是爸爸定的：glowIntensity 0.3 压光晕、starSize 1.5 不糊团。 */
const Galaxy = lazy(() => import('./components/Galaxy.jsx'))

// 四个页面。路由方式见 TECH_DESIGN.md §8.2：
// 用 hash 路由，因为 PRD 的 J3 要求「不经过首页刷新直接进入历史记录页」
const PAGES = [
  { hash: '#/', title: '首页', hint: '' },
  { hash: '#/list', title: '我的清单', hint: '看看有哪些候选，也可以删掉不想吃的。' },
  { hash: '#/add', title: '添加', hint: '把常吃的那几家也加进来。' },
  { hash: '#/history', title: '历史记录', hint: '最近推荐过什么，都记在这儿。' },

  /* ⚠️ 检查台（Day 20）**不进导航** —— 靠 hidden: true 挡掉。
     它是给开发/验收用的（后端活不活、数据多少、能不能写），不是给客户用的功能。
     地址栏敲 #/check 就进得来 —— 路由认得它（readHash 用 PAGES.some 校验），
     但菜单里不会多这一项。 */
  {
    hash: '#/check',
    title: '检查台',
    hint: '后端活不活、数据有多少、写不写得进去。',
    hidden: true,
  },
]

function readHash() {
  const hash = window.location.hash || '#/'
  return PAGES.some((p) => p.hash === hash) ? hash : '#/'
}

/* ── 「状态演示」开关（Day 13）────────────────────────────────────────
   地址栏加 ?demo=normal ｜ empty ｜ loading ｜ error。

   它当初是个"补丁"：Day 13 时数据全在 localStorage、同步读，
   「加载中」和「错误」**物理上不可能发生**，只能这样手动调出来看一眼，
   免得接 API 那天才发现样式全不对。

   ⭐ Day 17 接口接上之后，这两种状态**自己就会发生**（见下面的 boot）——
      这个开关于是退回它本来的用途：**验收时想单独看某一种状态**，
      不用真的去断网或拔网线。

   ⚠️ 它**只给验收和开发用，不给用户看**：
      页脚那个下拉只在地址里带了 `?demo=` 时才出现 ——
      客户打开产品时，页面上一个字都不会多出来。                        */
const DEMO_OPTIONS = [
  { value: VIEW_STATE.success, label: '正常' },
  { value: VIEW_STATE.empty, label: '空' },
  { value: VIEW_STATE.loading, label: '加载中' },
  { value: VIEW_STATE.error, label: '错误' },
]

/* 读地址栏里的 ?demo=。没有、或者值不认识 → 返回 null（= 正常产品状态） */
function readDemoState() {
  if (typeof window === 'undefined') return null
  const s = new URLSearchParams(window.location.search).get('demo')
  return DEMO_OPTIONS.some((o) => o.value === s) ? s : null
}

/* 数据说明 —— 放在页脚，所有页面都看得到。
   它同时顶掉了两件事：① 让人知道店名是真品牌、菜品是内置清单
   ② 说清"不涉及交易、不接平台数据"，免得用户以为这里能下单 */
const DATA_NOTE =
  '店名为真实连锁品牌，菜品为内置清单。本工具只帮你决定吃什么、去哪家 —— ' +
  '不涉及任何交易，也不接入任何平台数据。'

export default function App() {
  const [hash, setHash] = useState(readHash)
  const [items, setItems] = useState([])
  const [filter, setFilterState] = useState({ spicyMax: SPICY_ANY, excludeTags: [] })
  const [history, setHistory] = useState([])
  const [updatedAt, setUpdatedAt] = useState(null)
  const [rec, setRec] = useState({
    status: 'idle',
    item: null,
    candidateCount: 0,
    itemCount: 0,
    error: null,
  })
  const [storageIssue, setStorageIssue] = useState(false)

  /* ── 启动加载（Day 17）──────────────────────────────────────────────
     数据源从「浏览器本地」换成了「云上的数据库」。过网络必然带来两件
     本地同步读取没有的事 —— **要等** 和 **可能失败**。

     ⚠️ 这两件事正好就是 Day 13 预留的 loading / error 两态。
        当时数据在 localStorage、同步读，它们**物理上不可能发生**；
        今天接口接上了，它们第一次**真的发生**，而样式和文案一个字没改。

     fromCache = 启动失败后用户选了「先用缓存看」，页面顶部会挂一条提示。 */
  const [boot, setBoot] = useState({
    status: VIEW_STATE.loading,
    error: null,
    fromCache: false,
  })

  /* 演示状态（地址栏 ?demo=）。放成 state 而不是每次读地址栏 ——
     这样页脚那个下拉一改，界面立刻跟着变。 */
  const [demoState, setDemoState] = useState(readDemoState)

  /* 星系层**延迟挂载**（three.js 走独立 chunk）。
     为什么等 2.5 秒：首屏最重要的是「马上能看到推荐结果」。
     接口请求 + 渲染完之前，那 100KB+ 一个字节都不该来抢带宽。
     2.5 秒是留足"内容已经出来了"的时间，又不至于让人等到忘记有这回事。

     ⚠️ 这里用「到点才渲染」而不是「渲染时再 import」——
         React.lazy 在组件**挂载那一刻**就开始下载了。
         想真的晚下载，必须先晚挂载。 */
  const [showGalaxy, setShowGalaxy] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShowGalaxy(true), 2500)
    return () => clearTimeout(timer)
  }, [])

  /* 「返回上一页」用：记住上一个页面是哪一个。
     ⚠️ 不用 history.back() —— 用户直接打开 #/list（没有上一页）时，
        history.back() 会把他**带出站外**，那就成了 bug。
        自己记一个"上一个页面"，没有记录就退回首页，行为可控。 */
  const prevHashRef = useRef(null)
  const lastHashRef = useRef(hash)

  // 洗牌袋只放内存，不写本地存储 —— PRD §5.2 规定「刷新就重新装袋」，
  // 所以它天生是个运行态。放进 useRef，切页面不丢，刷新才重置。
  const bagRef = useRef(null)
  const drawnForRef = useRef(null)
  /* 防连点：正在取数时又点就忽略。按钮也会被禁用 ——
     按钮禁用是给用户看的，这个 ref 是给逻辑兜底的（万一将来有人把 disabled 拿掉）。 */
  const drawingRef = useRef(false)
  /* 用来取消上一轮取数：连点多次时，只有最后一次的结果会生效 */
  const drawAbortRef = useRef(null)

  /* 把数据层的真实状态同步到界面。
     存储才是唯一真相，界面不自己造一份 —— 这样任何时候显示的都是存储里的东西。 */
  const sync = useCallback(() => {
    setItems(loadItems())
    setFilterState(getFilter())
    setHistory(getHistory())
    setUpdatedAt(getMeta().updatedAt)
  }, [])

  /* 向服务器要数据 → 灌进本地存储 → 刷新界面。
     灌进存储（而不是让页面直接读接口返回值）的理由见 storage.js 的 adoptServerData：
     **页面代码一行都不用改**，数据从哪来这件事被挡在了数据层里面。

     两个接口并发拉，比串行快一倍 —— 首屏首页和页脚都要用这两份数据。 */
  const loadFromServer = useCallback(async () => {
    setBoot({ status: VIEW_STATE.loading, error: null, fromCache: false })
    try {
      const [itemsRes, historyRes] = await Promise.all([fetchItems(), fetchHistory()])
      adoptServerData({ items: itemsRes.items, history: historyRes.entries })
      sync()
      setBoot({ status: VIEW_STATE.success, error: null, fromCache: false })
    } catch (err) {
      // 打日志：真出问题时控制台里能看到是哪一步断的（网络 / 接口 / 解析）
      console.error('[boot] 启动加载失败', err)
      setBoot({
        status: VIEW_STATE.error,
        error: err?.message || '连不上服务器。',
        fromCache: false,
      })
    }
  }, [sync])

  useEffect(() => {
    loadFromServer()
  }, [loadFromServer])

  /* 启动失败时的第二条出路：不重试了，用上次成功加载留下的缓存继续。
     走这里 boot 直接变 success —— 页面当加载成功，数据是本地那份。
     顶部会挂一条提示说明"看的是缓存"，不假装是新的。 */
  const useCacheAndContinue = useCallback(() => {
    sync()
    setBoot({ status: VIEW_STATE.success, error: null, fromCache: true })
  }, [sync])

  useEffect(() => {
    const onChange = () => setHash(readHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  /* 页面变了 → 把"刚才那一页"记下来，给页头的「返回」按钮用 */
  useEffect(() => {
    if (lastHashRef.current !== hash) {
      prevHashRef.current = lastHashRef.current
      lastHashRef.current = hash
    }
  }, [hash])

  useEffect(() => {
    sync()
    if (getStorageStatus().notify) setStorageIssue(true)
  }, [sync])

  /* 当前候选 = 全部条目过一遍辣度上限与忌口标签。
     ⚠️ 注意：首页那两行「类别 / 平台」筛选**不在这里** —— 它们是浏览用的展示筛选，
        不进抽签池。所以改它们不会影响抽签结果，PRD §5.2 的洗牌袋一个字不用改。 */
  const candidates = useMemo(() => applyFilter(items, filter), [items, filter])

  /* 抽一个结果。顺序严格按 PRD §5.2：算候选 → 装袋/取袋 → 写历史。

     ⚠️ Day 11 改成了**异步**。为什么：取数这件事将来要跨网络，而"跨网络"
        必然带来两件现在没有的事 —— ① 有等待期（loading）② 会失败（error）。
        现在数据在本地，这两态都不会真发生，但状态机必须先建起来。
        取数的实现在 lib/drawService.js，那里有两个人工开关能把这两态调出来看。 */
  const draw = useCallback(async (opts) => {
    /* viaUser = 这次是**用户点出来的**（不是页面自动抽的）。
       界面靠它决定要不要说「切换成功」——
       首次自动抽取也是 ok，但那时用户没做任何操作，弹提示会莫名其妙。 */
    const viaUser = opts?.viaUser === true

    // 正在取数时又点了一次 → 忽略（按钮同时会被禁用，这里是第二道保险）
    if (drawingRef.current) return

    const all = loadItems()
    const pool = applyFilter(all, getFilter())

    // 候选为 0 → 不抽取，只给提示；绝不回退到被过滤掉的条目（H3）
    if (pool.length === 0) {
      bagRef.current = null
      setRec({ status: 'empty', item: null, candidateCount: 0, itemCount: all.length, error: null })
      return
    }

    // 「上一次结果」= 历史记录里最新的一条（含刷新前产生的），靠 itemId 传递
    const lastResultId = getHistory()[0]?.itemId ?? null

    // 取消上一轮还没结束的取数（连点场景），然后进入「加载中」
    drawAbortRef.current?.abort()
    const controller = new AbortController()
    drawAbortRef.current = controller

    drawingRef.current = true
    /* 注意：这里**保留当前 item**，只把状态切成 loading。
       结果卡片因此不会消失、布局不会跳 —— 对应的要求是「保持现有卡片布局」。 */
    setRec((r) => ({ ...r, status: 'loading', error: null }))

    try {
      const { id, bag } = await fetchNextResult({
        bag: bagRef.current,
        pool,
        lastResultId,
        signal: controller.signal,
      })
      // 被取消的这一轮：什么都不做（不算失败，也不动界面）
      if (controller.signal.aborted) return

      bagRef.current = bag
      const item = pool.find((c) => c.id === id)
      if (!item) throw new Error('取到的结果不在候选里')

      appendHistory(item) // 取出的结果写入历史记录
      setRec({
        status: 'ok',
        item,
        candidateCount: pool.length,
        itemCount: all.length,
        error: null,
        viaUser,
      })
      sync()
    } catch (err) {
      // 主动取消 / 被新一轮顶掉 → 不算失败，界面上什么都不该变
      if (controller.signal.aborted || err?.name === 'AbortError') return
      setRec((r) => ({ ...r, status: 'error', error: describeError(err) }))
    } finally {
      drawingRef.current = false
    }
  }, [sync])

  /* 每次「进入首页」都重新抽一次。
     为什么不是"只在刷新时抽一次"：
       在清单页删掉一个条目再回首页，如果沿用旧结果，显示的可能是已经被删掉的东西 ——
       而 I2 / C2 那两条验收标准要求「删掉的那条不再出现」。重抽一次就对齐了。
     闸门 drawnForRef 记住「这次进入首页已经抽过了」：
       · 离开首页时清空 → 下次回来会重抽
       · 同一个 hash 内不重复抽 → 顺便挡住 React StrictMode 把 effect 跑两遍 */
  useEffect(() => {
    if (hash !== '#/') {
      drawnForRef.current = null
      return
    }
    /* ⚠️ 数据没到位就不抽（Day 17 加的门）。
       候选池这时还是空的、或者是上一次留下的旧数据 —— 抽出来的结果没有意义。
       等 boot 变成 success，这个 effect 会自己再跑一次。 */
    if (boot.status !== VIEW_STATE.success) return
    if (drawnForRef.current === hash) return
    drawnForRef.current = hash
    draw()
  }, [hash, draw, boot.status])

  // ── 四个操作。改完数据立刻 sync，界面马上跟着变（C3 要求删除后数量立即更新）──

  /* 删除一条（**Day 22 改过**：从"只删本地"变成"先删云端、成了再删本地"）。

     ⚠️ 为什么顺序不能反 —— 这是今天最容易写错的地方：
        改成先删本地再删云端的话，万一云端那步失败（断网、超时），
        本地那条已经没了：用户看到"删掉了"，**刷新页面它又回来了**
        （因为刷新会从云端重新灌一份数据下来）。
        "删了又复活"比当场报个错难查得多 —— 报错至少用户知道没删成。

     ⚠️ `NOT_FOUND` 当成功处理：云端说"没这条" —— 而"让这条不存在"
        正是用户要的结果，已经达成了。这时把本地那条也清掉，
        不该拿一个 404 拦着用户（他再点一次还是 404）。

     ⚠️ 返回值是给界面看的：`{ ok:false, message }` 时页面要显示这条消息。
        以前这个函数不返回东西（本地删除必成功），现在会失败 —— 必须让上层知道。 */
  const handleRemove = useCallback(
    async (id) => {
      try {
        await deleteItem(id)
        removeItem(id)
        sync()
        return { ok: true }
      } catch (err) {
        if (err?.code === 'NOT_FOUND') {
          // 云端已经没有这条了 —— 目标达成，本地顺带清掉
          removeItem(id)
          sync()
          return { ok: true, alreadyGone: true }
        }
        // 打日志：真出问题时控制台能看到是哪一步断的（网络 / 接口 / 权限）
        console.error('[remove] 删云端失败', err)
        return { ok: false, message: err?.message || '没能连上服务器，这条没删掉' }
      }
    },
    [sync],
  )

  /* 清单页的「恢复默认库」：只补条目，**不抽** —— 在这一页抽会平白多写一条历史 */
  const handleRestore = useCallback(() => {
    restoreBuiltin()
    sync()
  }, [sync])

  /* 首页空状态里的「恢复默认库」：补完要立刻给一个结果，不然还是空页面 */
  const handleRestoreHome = useCallback(() => {
    restoreBuiltin()
    sync()
    draw()
  }, [sync, draw])

  const handleFilterChange = useCallback(
    (patch) => {
      setFilter(patch)
      sync()
    },
    [sync],
  )

  /* 「添加」页提交 → **写到云端**（Day 18 接上接口）。

     分两步，各有各的道理：
       ① 本地校验格式：空名称 / 超长 / 没选类型 —— 不用等网络就能拦掉，反馈最快；
       ② 交给后端写库：`id` 和 `created_at` 由**数据库**生成，本地不自己造。

     ⚠️ **重名不在这里判** —— 交给后端（本地那份清单可能不是最新的，
        比如别处刚加过同名；数据库的唯一约束才是权威）。

     失败时把服务端写好的**中文提示**原样带回去（`err.message`），界面直接显示。 */
  const handleAdd = useCallback(
    async (input) => {
      const v = validateNewItem(input)
      if (!v.ok) return { ok: false, reason: v.reason }

      try {
        const { item } = await createItem(v.fields)
        // 服务端返回的那条写进本地存储 —— 存储是唯一真相，界面从存储读
        appendItem(item)
        sync()
        return { ok: true, item }
      } catch (err) {
        // 打日志：真出问题时控制台能看到是哪一步断的
        console.error('[add] 写云端失败', err)
        return { ok: false, reason: 'server', message: err?.message || '没能连上服务器' }
      }
    },
    [sync],
  )

  /* 「添加」页的标签选项 = 预设 ∪ 清单里已出现的标签。
     这样用户上次自己输的标签，下次添加时就在手边了。 */
  const addTagOptions = useMemo(
    () => [...new Set([...TAG_PRESETS, ...collectTags(items)])],
    [items],
  )

  /* 覆盖页面上算出来的四种状态。优先级从高到低：
       ① ?demo= 人工指定（验收时想单独看某一种状态，仍然用它）
       ② 启动阶段的**真实状态**：正在取数 → loading；取不到 → error
       ③ 都没有 → null，交回给各页面按自己的数据算（success / empty）

     ⚠️ ② 是 Day 17 新增的。在此之前这里只有 ①，
        因为那时数据在本地同步读，loading / error 不可能自然发生。 */
  const stateOverride =
    demoState ??
    (boot.status === VIEW_STATE.success ? null : boot.status)

  /* 换演示状态：改 React 状态（界面立刻变）+ 同步地址栏（刷新后保持同一个状态）。
     用 replaceState 而不是改 location.search —— 后者会**刷新页面**，一闪一闪的不好看。 */
  const handleDemoChange = useCallback((value) => {
    setDemoState(value)
    const url = new URL(window.location.href)
    url.searchParams.set('demo', value)
    window.history.replaceState({}, '', url)
  }, [])

  /* 退出演示：把 ?demo= 从地址里删掉，下拉也跟着收起来 */
  const handleDemoExit = useCallback(() => {
    setDemoState(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('demo')
    window.history.replaceState({}, '', url)
  }, [])

  /* 「返回上一页」：有记录就回上一页，没有（比如直接输地址进来的）就回首页 */
  const handleBack = useCallback(() => {
    window.location.hash = prevHashRef.current ?? '#/'
  }, [])

  const page = PAGES.find((p) => p.hash === hash) ?? PAGES[0]

  /* 启动失败时，错误页上给两条出路。三页共用同一份 ——
     "取不到数据"是全局的事，不是某一页自己的毛病。 */
  const bootErrorActions =
    boot.status === VIEW_STATE.error ? (
      <>
        <button className="btn" type="button" onClick={loadFromServer}>
          重试
        </button>
        <button className="btn ghost" type="button" onClick={useCacheAndContinue}>
          先用缓存看
        </button>
      </>
    ) : null

  /* 失败原因也要传下去 —— 默认那句「等会儿再试一次」太笼统，
     分不清是"断网"、"接口挂了"还是"超时"，而这三件事该做的事不一样。
     具体的话在 api.js 里生成（连不上服务器 / 请求超时 / 服务器返回了预期之外的内容）。 */
  const bootErrorText = boot.status === VIEW_STATE.error ? boot.error : undefined

  let content
  if (page.hash === '#/') {
    /* 首页什么时候渲染：
       · 启动中 / 启动失败 → **要渲染**，让 ViewState 把骨架屏或错误页显示出来
       · 启动成功但 rec 还是 idle → 不渲染（抽取在 effect 里跑，差一帧）——
         这一帧一闪而过，渲染它反而会闪一下空状态 */
    const homeReady = boot.status !== VIEW_STATE.success || rec.status !== 'idle'
    content = homeReady ? (
      <Home
        rec={rec}
        stateOverride={stateOverride}
        errorActions={bootErrorActions}
        errorText={bootErrorText}
        onRetry={loadFromServer}
        candidates={candidates}
        filter={filter}
        updatedAt={updatedAt}
        onDraw={draw}
        onRestore={handleRestoreHome}
        onFilterChange={handleFilterChange}
      />
    ) : null
  } else if (page.hash === '#/list') {
    content = (
      <List
        items={items}
        filter={filter}
        stateOverride={stateOverride}
        errorActions={bootErrorActions}
        errorText={bootErrorText}
        onRetry={loadFromServer}
        onRemove={handleRemove}
        onRestore={handleRestore}
        onFilterChange={handleFilterChange}
      />
    )
  } else if (page.hash === '#/add') {
    content = <Add tagOptions={addTagOptions} onAdd={handleAdd} />
  } else if (page.hash === '#/check') {
    /* 检查台自己去调接口，不依赖 App 的启动流程 */
    content = <Check />
  } else {
    content = (
      <History
        entries={history}
        stateOverride={stateOverride}
        errorActions={bootErrorActions}
        errorText={bootErrorText}
        onRetry={loadFromServer}
      />
    )
  }

  return (
    <>
      <NebulaCanvas />
      {/* 星系层叠在星云之上、内容之下（z-index 都是 0，靠 DOM 顺序分层）。
          到点才挂载 → 那 100KB 的 three.js 才会开始下载。

          props 是爸爸 2026-10-14 定的（治「太亮太糊」）：
            · glowIntensity 0.3 → 光晕只留三成，不糊
            · starSize      1.5 → 星星小，密处不糊团
            · saturation   0.67 → 颜色降一档饱和，不艳
            · mouseRepulsion    → 鼠标把附近星星轻轻推开
            · clickWarp         → 点一下，一圈冲击波扩散 */}
      {showGalaxy && (
        <Suspense fallback={null}>
          <Galaxy
            density={1}
            glowIntensity={0.3}
            flareIntensity={1}
            starSpeed={0.5}
            mouseRepulsion
            clickWarp
            saturation={0.67}
            starSize={1.5}
          />
        </Suspense>
      )}
      <div className="app">
      <header className="topbar">
        <span className="brand">想吃啥</span>
        <span className="brand-sub">中午不知道吃啥，问我</span>
        <nav className="nav">
          {PAGES.filter((p) => !p.hidden).map((p) => (
            <a
              key={p.hash}
              href={p.hash}
              className={p.hash === page.hash ? 'nav-item active' : 'nav-item'}
              /* aria-current="page" —— 让读屏软件也知道"你现在在哪一页"。
                 只有它，光靠一个 active 类名，屏幕阅读器是读不出来的。 */
              aria-current={p.hash === page.hash ? 'page' : undefined}
            >
              {p.title}
            </a>
          ))}
        </nav>
      </header>

      {storageIssue && (
        <div className="banner">
          数据将无法保存（浏览器的本地存储不可用）。这次打开期间功能照常用，只是关掉页面后不会保留。
        </div>
      )}

      {/* 用户选了「先用缓存看」之后挂一条提示 ——
          不假装数据是新的，也不把人拦在门外。 */}
      {boot.fromCache && (
        <div className="banner">
          没能连上服务器，当前显示的是上次加载留下的缓存。改动暂时只存在这台设备上。
        </div>
      )}

      <main className="main">
        {/* 首页要摆卡片网格，撑满容器才排得下多栏；其余三页保持 760px 的好读宽度 */}
        <section className={page.hash === '#/' ? 'panel panel-wide' : 'panel panel-wide asymmetric'}>
          {page.hash !== '#/' && (
            <>
              {/* 返回上一页。首页是入口，不需要这个按钮，所以只在其余三页出现。 */}
              <button className="back-btn" type="button" onClick={handleBack}>
                ← 返回
              </button>
              {/* 打破对称布局的页面自己管理标题，App 不再重复渲染 */}
              {page.hash !== '#/list' && page.hash !== '#/add' && page.hash !== '#/history' && (
                <>
                  <h1>{page.title}</h1>
                  {page.hint && <p className="hint">{page.hint}</p>}
                </>
              )}
            </>
          )}
          {content}
        </section>

        <footer className="footer">
          {/* 数据说明：原来挂在首页网格下面，Day 13 挪到页脚 ——
              它讲的是整个产品（数据从哪来、不涉及什么），放页脚所有页面都看得到。
              顺便顶掉了原来页脚那行「当前页面地址」，那是开发时看的，不该给用户看到。 */}
          <p className="data-note">{DATA_NOTE}</p>

          {/* 「状态演示」开关：**只有地址里带了 ?demo= 才出现** ——
              客户打开产品时页面上一个字都不会多出来。 */}
          {demoState && (
            <p className="demo-bar">
              <span className="demo-label">状态演示</span>
              <select
                className="select demo-select"
                value={demoState}
                onChange={(e) => handleDemoChange(e.target.value)}
                aria-label="切换演示状态"
              >
                {DEMO_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button className="demo-exit" type="button" onClick={handleDemoExit}>
                退出演示
              </button>
            </p>
          )}
        </footer>
      </main>
    </div>
    </>
  )
}
