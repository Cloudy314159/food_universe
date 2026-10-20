/* 数据层 · 全项目唯一读写浏览器本地存储的地方
 * 对应 TECH_DESIGN.md §5（项目结构）、§7.1（数据层接口）、§9（错误处理）
 *
 * 为什么整个项目只有这一个文件碰 localStorage：
 *   PRD 的 E3 要求「本地存储不可用时降级为内存态 + 提示一次」。
 *   如果到处直接调 localStorage，这个分支要写十几遍；集中在这里只写一遍。
 *   将来换成云端，也只改这一个文件，页面代码一行不动。
 */

import menu from '../data/menu.json'
import {
  HISTORY_LIMIT,
  NAME_MAX,
  PLATFORM_FILTER_ALL,
  PLATFORM_FILTER_OPTIONS,
  PLATFORMS,
  SCHEMA_VERSION,
  SPICY_ANY,
  SPICY_LEVELS,
  STORAGE_KEYS,
  TYPE_FILTER_ALL,
  TYPE_FILTER_OPTIONS,
} from './constants.js'

/* ── 内部状态 ─────────────────────────────────────────────────────── */

let persistent = null // true / false；null = 还没探测过
let memory = null // 降级用的内存态容器
let noticeGiven = false // 「数据将无法保存」每次会话只提示一次

function emptyState() {
  return {
    items: [],
    filter: { spicyMax: SPICY_ANY, excludeTags: [] },
    history: [],
    meta: { schemaVersion: SCHEMA_VERSION, seededBuiltin: false, updatedAt: null },
  }
}

function builtinItems() {
  // 每次都返回副本，避免调用方改到 menu.json 的原始对象
  return menu.map((item) => ({ ...item, tags: [...item.tags] }))
}

/* ── 可用性探测与降级 ─────────────────────────────────────────────── */

function available() {
  if (persistent !== null) return persistent
  try {
    const probe = '__chisha_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    persistent = true
  } catch {
    // 无痕窗口、被禁用、配额满 —— 都走这里（PRD §5.3 / E3）
    switchToMemory()
  }
  return persistent
}

function switchToMemory() {
  if (persistent === false && memory) return
  const snapshot = emptyState()
  try {
    // 能读多少读多少，读不到就用默认值
    for (const name of Object.keys(STORAGE_KEYS)) {
      const raw = window.localStorage.getItem(STORAGE_KEYS[name])
      if (raw != null) snapshot[name] = JSON.parse(raw)
    }
  } catch {
    /* 忽略：降级本来就意味着拿不到历史数据 */
  }
  memory = snapshot
  persistent = false
}

/* ── 底层读写：所有存储访问都必须经过这两个函数 ───────────────────── */

function readRaw(name) {
  if (!available()) return memory ? memory[name] : undefined
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS[name])
    return raw == null ? undefined : JSON.parse(raw)
  } catch {
    // 数据损坏（解析失败）：把这一项重置掉，不要白屏、不要报红（错误处理表第 2 行）
    try {
      window.localStorage.removeItem(STORAGE_KEYS[name])
    } catch {
      /* 忽略 */
    }
    return undefined
  }
}

function writeRaw(name, value) {
  if (!available()) {
    memory[name] = value
    return
  }
  try {
    window.localStorage.setItem(STORAGE_KEYS[name], JSON.stringify(value))
  } catch {
    // 写入失败：转为内存态，本次会话功能照常可用（PRD §5.3）
    switchToMemory()
    memory[name] = value
  }
}

/* ── 首次运行：播种内置库 ─────────────────────────────────────────── */

/* 数据迁移：SCHEMA_VERSION 对不上时，重播一次内置库。

   为什么非做不可：Day 7 已经在浏览器里播过 v1 的内置库，而那一版 15 家"店"里有
   12 家是搜不到的虚构名字（「校门口的麻辣烫」「一楼食堂」…）。不做迁移的话，
   刷新后看到的还是旧数据，新的 50 条永远进不来 —— 而且「恢复默认库」也救不了，
   因为它是"补缺"，会把新旧两套名字一起塞进清单。

   只替换 source === 'builtin' 的条目，**用户自己加的条目一条都不动**。
   迁移完把版本号写成当前值，所以它只跑一次 ——
   之后把清单删空再刷新，仍然不会自动补回来（PRD 的 F1 / H3 要靠这个状态）。 */
function migrateIfNeeded(meta) {
  if (meta?.schemaVersion === SCHEMA_VERSION) return false
  const items = readRaw('items')
  const list = Array.isArray(items) ? items : []
  const kept = list.filter((it) => it?.source !== 'builtin')
  writeRaw('items', [...kept, ...builtinItems()])
  return true
}

/* 只在「从未初始化过」时播种一次。
   用户把清单删空后刷新，不会自动补回来 —— 因为 PRD 的 F1 和 H3
   都需要「候选为空」这个状态能够被构造出来。想恢复，用「恢复默认库」。 */
function ensureReady() {
  available()
  const meta = readRaw('meta')
  if (meta && meta.seededBuiltin === true) {
    // 播过种了 —— 但版本对不上（比如今天从 v1 升到 v2）就先迁移
    if (migrateIfNeeded(meta)) {
      writeRaw('meta', {
        schemaVersion: SCHEMA_VERSION,
        seededBuiltin: true,
        updatedAt: Date.now(),
      })
    }
    return
  }

  const items = readRaw('items')
  if (!Array.isArray(items) || items.length === 0) {
    writeRaw('items', builtinItems())
  }
  writeRaw('filter', {
    spicyMax: SPICY_ANY,
    excludeTags: [],
    platformFilter: PLATFORM_FILTER_ALL,
    typeFilter: TYPE_FILTER_ALL,
  })
  writeRaw('history', [])
  writeRaw('meta', {
    schemaVersion: SCHEMA_VERSION,
    seededBuiltin: true,
    updatedAt: Date.now(),
  })
}

/* ── 小工具 ───────────────────────────────────────────────────────── */

/* 去首尾空格，包含全角空格 U+3000（PRD §5.1） */
export function normalizeName(name) {
  return String(name ?? '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
}

/* 按「字符数」计数，不是 JS 的 .length（UTF-16 码元数）。
   原因：emoji 在 JS 里占 2 个码元。用 .length 会把
   「19 个字符里含 1 个 emoji」误判成超长，直接违反 PRD 的 D5。
   对应 TECH_DESIGN.md 附一第 4 条。 */
export function charLength(text) {
  return [...String(text ?? '')].length
}

function makeId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/* ── 清单 ─────────────────────────────────────────────────────────── */

export function loadItems() {
  ensureReady()
  const items = readRaw('items')
  return Array.isArray(items) ? items : []
}

/* 只做「格式校验 + 字段规范化」，**不写盘、不查重**。

   为什么单独拆成一个函数：页面 3「添加」现在走接口了 ——
   它需要在**发请求之前**先拦掉明显的错误（空名称、超长、没选类型），
   这些不用等网络就有答案；而**重名交给后端判**
   （本地那份清单可能不是最新的，比如别处刚加过同名）。

   返回：不合格 `{ ok:false, reason }`；合格 `{ ok:true, fields:{...} }` */
export function validateNewItem(input = {}) {
  const name = normalizeName(input.name)
  if (!name) return { ok: false, reason: 'empty' } // D1：空 / 全空格
  if (charLength(name) > NAME_MAX) return { ok: false, reason: 'too-long' } // D2

  const { type } = input
  if (type !== 'dish' && type !== 'shop') return { ok: false, reason: 'no-type' } // D1

  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).trim()).filter(Boolean)
    : []

  return {
    ok: true,
    fields: {
      name,
      type,
      /* 不填就是「不限」→ 这类条目永远不会被过滤掉（PRD §5.1）。
         平台同理：用户没说他在哪个平台点，就不该因为平台筛选被排除。 */
      platform: PLATFORMS.includes(input.platform) ? input.platform : 'any',
      spicy: SPICY_LEVELS.includes(input.spicy) ? input.spicy : SPICY_ANY,
      tags,
    },
  }
}

/* 本地新增一条 —— **没接后端时的老路径**，也是全项目唯一会自己造 id 的地方。
   接上接口之后，页面 3 走的是 validateNewItem + appendItem。
   这个函数留着给离线 / 测试用。
   返回 { ok, reason?, item? }，让界面自己决定怎么提示 */
export function addItem(input = {}) {
  ensureReady()

  const v = validateNewItem(input)
  if (!v.ok) return v

  const items = loadItems()
  if (items.some((it) => normalizeName(it.name) === v.fields.name)) {
    return { ok: false, reason: 'duplicate' } // D3：去空格后同名
  }

  const item = { id: makeId('u'), ...v.fields, source: 'user' }
  writeRaw('items', [...items, item])
  touchUpdatedAt()
  return { ok: true, item }
}

/* 把**服务端返回的那一条**原样收进本地清单（页面 3 接接口之后走这里）。

   为什么不复用 addItem：addItem 会**自己造 id**（`makeId('u')`）。
   可接了接口之后，id / created_at 是**数据库生成的** —— 本地再造一个就和云端对不上了，
   以后按 id 删除 / 更新会全错。所以这里只做一件事：**服务端给什么就收什么**。

   返回 true = 真写进去了；false = 没写（不是对象 / 没 id / 本地已经有这条了）。 */
export function appendItem(item) {
  ensureReady()
  if (!item || typeof item !== 'object' || !item.id) return false

  const items = loadItems()
  // 防重：万一这条已经在本地了（比如失败后重试过），不要塞两遍
  if (items.some((it) => it.id === item.id)) return false

  writeRaw('items', [...items, item])
  touchUpdatedAt()
  return true
}

/* 删条目。注意：不碰历史记录 —— 历史是「发生过的事」（PRD J4） */
export function removeItem(id) {
  ensureReady()
  const items = loadItems()
  const next = items.filter((it) => it.id !== id)
  if (next.length === items.length) return false
  writeRaw('items', next)
  touchUpdatedAt()
  return true
}

/* 把内置库补进清单：已有的（去空格后同名）不重复添加，也不删用户自己的条目 */
export function restoreBuiltin() {
  ensureReady()
  const items = loadItems()
  const existing = new Set(items.map((it) => normalizeName(it.name)))
  const additions = builtinItems().filter((b) => !existing.has(normalizeName(b.name)))
  if (additions.length) {
    writeRaw('items', [...items, ...additions])
    touchUpdatedAt()
  }
  return additions.length
}

/* ── 过滤条件 ─────────────────────────────────────────────────────── */

/* 过滤条件现在有四个字段，分成**两组平级的维度**：
   · 辣度上限 + 忌口标签  → 老的那组（PRD §5 页面 2）
   · 平台筛选 + 类别筛选  → Day 8 新增。爸爸拍板：**类别与平台平级**，
     所以这两个字段的形态、默认值、校验方式完全对称。

   两个新字段的默认值都是 'all'（全部 = 这一维不筛），
   这样"全新状态"下四个维度全部不生效，守住 PRD 的 H1 和 A1。 */
function defaultFilter() {
  return {
    spicyMax: SPICY_ANY,
    excludeTags: [],
    platformFilter: PLATFORM_FILTER_ALL,
    typeFilter: TYPE_FILTER_ALL,
  }
}

export function getFilter() {
  ensureReady()
  const f = readRaw('filter')
  if (!f || typeof f !== 'object') return defaultFilter()
  return {
    spicyMax: SPICY_LEVELS.includes(f.spicyMax) ? f.spicyMax : SPICY_ANY,
    excludeTags: Array.isArray(f.excludeTags) ? f.excludeTags : [],
    platformFilter: PLATFORM_FILTER_OPTIONS.includes(f.platformFilter)
      ? f.platformFilter
      : PLATFORM_FILTER_ALL,
    typeFilter: TYPE_FILTER_OPTIONS.includes(f.typeFilter) ? f.typeFilter : TYPE_FILTER_ALL,
  }
}

export function setFilter(patch) {
  ensureReady()
  const merged = { ...getFilter(), ...patch }
  writeRaw('filter', merged)
  return merged
}

/* ── 历史记录 ─────────────────────────────────────────────────────── */

/* 每条历史存两样：
   · name   —— 名称快照。**显示只读它**，所以条目被删掉之后历史照样显示得出来（PRD J4）。
   · itemId —— 只给洗牌袋的「边界衔接」用：PRD §5.2 要求判断"新袋首项是不是上一次结果"，
               而"上一次结果"被定义为"历史记录里最新的一条（含刷新前产生的）"，
               所以要能被持久化下来，光有名称不够。
               条目被删后这个 id 会悬空，但那正好 —— 它比对不上任何袋内条目，行为也是对的。
   存储顺序 = 新的放最前面，所以读出来直接就是倒序（PRD J2）。 */

export function appendHistory(item) {
  ensureReady()
  const entry = {
    id: makeId('h'),
    itemId: item?.id ?? null,
    name: String(item?.name ?? ''),
    at: Date.now(),
  }
  const next = [entry, ...getHistory()].slice(0, HISTORY_LIMIT) // J2：最多 20 条
  writeRaw('history', next)
  return entry
}

export function getHistory() {
  ensureReady()
  const list = readRaw('history')
  return Array.isArray(list) ? list : []
}

/* ── 接收服务端数据（Day 17 新增）─────────────────────────────────── */

/**
 * 把从接口拉回来的数据灌进本地存储。启动时调一次。
 *
 * ── 为什么是"灌进本地存储"，而不是"页面直接用接口数据" ──────────────
 * 因为全项目读数据都走 loadItems() / getHistory()（抽签、筛选、恢复默认库
 * 全都依赖它们）。灌进存储 = **页面代码一行都不用改** ——
 * 数据从哪来这件事，被挡在了数据层里面。
 *
 * ── 合并规则：服务端当基线，但不吞掉本地的 ──────────────────────────
 * · items  —— 服务端全量 + 本地用户自己加的（`source === 'user'`）。
 *             为什么保留本地的：写入接口要到 Day 18 才有，用户这几天
 *             自己加的条目还上不了云；不保留的话，一刷新就人间蒸发。
 * · history —— 两边合并、按时间倒序、同名同时刻去重、只留最近 20 条。
 *             ⚠️ `item_id` 可能是 null（那条记录对应的条目被删过）——
 *             历史上显示的是 `name` 快照，所以照样显示得出来（PRD J4）。
 *
 * @param {{items?: Array, history?: Array}} payload 已转成本地形状的数据
 * @returns {{items: number, history: number}} 灌完之后各有多少条
 */
export function adoptServerData({ items, history } = {}) {
  ensureReady()

  // ── items ──
  /* ⚠️ 2026-10-20 修（v1.0 上发现的真 bug）：**以服务端为准，不再合并本地条目**。
     ─────────────────────────────────────────────────────────────────────
     原来这里会把 localStorage 里 `source === 'user'` 的条目留下来，
     那是 Day 18 之前的临时兜底 —— 那时添加页还只写本地、上不了云，
     不保留的话一刷新新加的条目就没了。

     Day 18 之后添加流程变成「先 POST 成功、再把服务端返回的那条写进本地」
     （见 App.jsx 的 handleAdd），本地**不会**再出现"还没上云"的条目。
     这个兜底于是只剩副作用：
       **在云端删掉的条目，刷新后会从本地这份被加回来** —— 用户看到"删了又复活"。
     2026-10-20 现场复现过：服务端查不到「Day22待删香锅10733」，
     页面上却还在，因为它活在 localStorage 里。

     所以现在直接拿服务端数据覆盖本地。真要有"离线新增"的需求，
     得单独做一个待同步队列，而不是靠这种合并。 */
  const incoming = Array.isArray(items) ? items : []
  const mergedItems = incoming
    .filter((it) => it && it.id != null)
    .map((it) => ({ ...it, tags: Array.isArray(it.tags) ? it.tags : [] }))
  writeRaw('items', mergedItems)

  // ── history ──
  const seen = new Set()
  const merged = []
  for (const e of [...getHistory(), ...(Array.isArray(history) ? history : [])]) {
    if (!e || typeof e.name !== 'string') continue
    const key = `${e.itemId ?? ''}|${e.name}|${e.at}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(e)
  }
  merged.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  const trimmed = merged.slice(0, HISTORY_LIMIT)
  writeRaw('history', trimmed)

  return { items: mergedItems.length, history: trimmed.length }
}

/* ── 元信息 · 更新时间 ────────────────────────────────────────────── */

/* 「更新时间」= **清单最后一次被改动的时刻**。
   算的只有三件事：加条目、删条目、恢复默认库。
   改过滤条件**不算** —— 过滤条件不是清单内容，页面上的文案写的是「清单更新于」。

   为什么要有它：Day 8 要求首页顶部显示一行"更新于 …"，
   而 PRD 与 Day 5 的数据模型里原本都没有这个字段。 */
export function getMeta() {
  ensureReady()
  const m = readRaw('meta')
  return {
    schemaVersion: m?.schemaVersion ?? SCHEMA_VERSION,
    seededBuiltin: m?.seededBuiltin === true,
    updatedAt: typeof m?.updatedAt === 'number' ? m.updatedAt : null,
  }
}

export function getUpdatedAt() {
  return getMeta().updatedAt
}

/* 任何改动了清单内容的操作，做完都要调它。
   （不写进 ensureReady 里，免得每次读都刷新时间——那这个值就没意义了。） */
function touchUpdatedAt() {
  writeRaw('meta', { ...getMeta(), updatedAt: Date.now() })
}

/* ── 存储状态与统计 ───────────────────────────────────────────────── */

/* 返回存储是否可用，以及「这次会话该不该提示」。
   标志位只能放内存 —— 存储不可用时本来也写不进去（TECH_DESIGN.md 附一第 3 条）。 */
export function getStorageStatus() {
  const ok = available()
  let notify = false
  if (!ok && !noticeGiven) {
    noticeGiven = true
    notify = true
  }
  return { persistent: ok, notify }
}

/* 给页面上的「数据层自检」卡片用，也用于验收标准核对 */
export function getStats() {
  const items = loadItems()
  const userCount = items.filter((it) => it.source === 'user').length
  const history = getHistory()
  return {
    total: items.length,
    userCount,
    builtinCount: items.length - userCount,
    historyCount: history.length,
    historyLimit: HISTORY_LIMIT,
    persistent: available(),
    keys: Object.keys(STORAGE_KEYS).filter((name) => readRaw(name) != null),
  }
}

/* 清空本产品的全部数据。供验收标准里「全新状态」这个测试前提使用。 */
export function resetAll() {
  try {
    if (available()) {
      for (const key of Object.values(STORAGE_KEYS)) {
        window.localStorage.removeItem(key)
      }
    }
  } catch {
    /* 忽略 */
  }
  persistent = null
  memory = null
  noticeGiven = false
  available()
  ensureReady()
}
