/* 接口层 · 前端与云端之间**唯一**的通道（Day 17 新增）
 *
 * 为什么单独一个文件：跟 storage.js 是同一个道理 ——
 *   调用接口要处理超时、要解析统一外壳、要把错误翻成人话。
 *   散在页面里写，每页都要重写一遍；集中在这里只写一次。
 *
 * ── 它负责三件事 ───────────────────────────────────────────────────
 *   ① 拼地址、发请求、设超时（网络这层的事）
 *   ② 拆 `{ ok, data, error }` 外壳（契约规定的统一格式）
 *   ③ **把服务端的字段形状翻译成本地的**（见下面的说明）
 *
 * ── ③ 为什么必须做 ─────────────────────────────────────────────────
 * 服务端给的是数据库列名（snake_case），本地存储用的是自己的命名：
 *     history 表     →  本地存储
 *     item_id        →  itemId   （可能为 null：那条记录对应的条目被删过）
 *     item_name      →  name
 *     drawn_at(ISO)  →  at       （毫秒时间戳，本地一律存数字）
 * 这层翻译放在这里，**页面和存储层就完全不用知道云端长什么样** ——
 * 以后接口改名、换实现，只有这个文件要动。
 *
 * 依据：仓库根目录 api-contract.md（第四节接口定义、第二节字段说明）
 */

/* 接口根地址。
   默认值写死是为了"clone 下来就能跑"—— 用 Vite 的 VITE_API_BASE
   可以在不同环境覆盖它（比如本地起一个后端调试）。 */
const BASE = (
  import.meta.env?.VITE_API_BASE ||
  'https://model-d5gisaem106ad6a18-1500042790.ap-shanghai.app.tcloudbase.com'
).replace(/\/+$/, '')

export const API_BASE = BASE

/* 取数超时。定 8 秒：比"用户会觉得卡死"短，比冷启动长
   （云函数冷启动实测约 1.2 秒，留足余量）。 */
const TIMEOUT_MS = 8000

/**
 * 发一个请求并拆掉统一外壳（GET / POST 共用）。
 * @param {string} path 接口路径，如 '/api/items'
 * @param {object} opts `{ method, body, signal, timeoutMs }`
 *   · `body` 传了就自动 JSON 序列化 + 带上 Content-Type；
 *     **不传就一个头都不多加** —— GET 带 Content-Type 反而可能触发跨域预检（OPTIONS）
 * @returns 成功时返回 `data` 里的内容；失败时 **抛出 Error**（带 `.code`）
 *
 * 为什么失败要抛而不是返回 {ok:false}：
 *   调用方几乎都是 `try { ... } catch` 的写法（首页抽取本来就是异步的），
 *   抛出去能直接落进已有的 catch —— 不用为接口这层再写一套分支。
 */
async function requestJson(path, { method = 'GET', body, signal, timeoutMs = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  let timedOut = false

  // 调用方给的取消信号（离开页面、连点顶掉）要能穿透进来
  const forwardAbort = () => ctrl.abort()
  signal?.addEventListener('abort', forwardAbort, { once: true })

  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)

  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await fetch(BASE + path, {
      method,
      signal: ctrl.signal,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    // 调用方主动取消 → 原样抛出，让上层认出来（它不该被当成"失败"）
    if (signal?.aborted) throw err
    if (timedOut) {
      const e = new Error(`请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒没回应）`)
      e.code = 'TIMEOUT'
      throw e
    }
    const e = new Error('连不上服务器，检查一下网络。')
    e.code = 'NETWORK'
    throw e
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }

  /* ⚠️ 这里叫 resBody 而不是 body —— `body` 已经被上面的**参数**占用了（请求体），
     重名会编译不过（Day 18 实测：rolldown 直接报 "can not be redeclared"）。 */
  const text = await res.text()
  let resBody = null
  try {
    resBody = JSON.parse(text)
  } catch {
    /* 不是 JSON —— 保持 resBody 为 null，下面统一报错 */
  }

  if (!resBody || typeof resBody.ok !== 'boolean') {
    /* ⚠️ Day 23：这句 message 会**直接显示在界面上**，所以只说人话。
       改之前是 `服务器返回了预期之外的内容（HTTP ${res.status}）` ——
       用户看不懂"HTTP 502"是什么意思，看了也不知道该干嘛。
       技术细节挪进 `code` / `httpStatus`：排查时控制台能看到，界面上不出现。 */
    const e = new Error('服务器返回了看不懂的内容，稍后再试一次')
    e.code = 'BAD_RESPONSE'
    e.httpStatus = res.status
    throw e
  }

  if (resBody.ok !== true) {
    // 服务端自己报的错：它给的消息比我编的准，直接用（契约要求服务端一律给中文人话）
    const e = new Error(resBody.error?.message || '操作没成功，稍后再试一次')
    e.code = resBody.error?.code || `HTTP_${res.status}`
    e.httpStatus = res.status
    throw e
  }

  return resBody.data
}

/* ── 接口 ①：读候选条目 ───────────────────────────────────────────── */ 

/**
 * 读全部候选条目（首页候选池 + 清单页共用）。
 * @returns `{ items: [...], total: number }`
 *
 * items 的字段和本地**完全一致**（表就是照本地建的），不用翻译：
 *   { id, name, type, platform, spicy, tags, source, created_at }
 */
export async function fetchItems({ signal } = {}) {
  const data = await requestJson('/api/items', { signal })
  const items = Array.isArray(data?.items) ? data.items : []

  // tags 兜底成数组：接口理论上一定给数组，但真为 null 时页面会崩
  return {
    items: items.map((it) => ({ ...it, tags: Array.isArray(it.tags) ? it.tags : [] })),
    total: typeof data?.total === 'number' ? data.total : items.length,
  }
}

/* ── 接口 ②：读历史记录 ───────────────────────────────────────────── */

/**
 * 读最近的历史记录（服务端已按时间倒序）。
 * @returns `{ entries: [...], total: number }`
 *
 * ⚠️ 这里做了字段翻译（服务端列名 → 本地命名）。
 *    `itemId` 可能是 **null** —— 那条记录对应的条目后来被删了。
 *    显示历史**只读 `name`**（名称快照），所以照样显示得出来（PRD J4）。
 */
export async function fetchHistory({ signal } = {}) {
  const data = await requestJson('/api/history', { signal })
  const rows = Array.isArray(data?.entries) ? data.entries : []

  const entries = rows.map((row) => {
    const at = Date.parse(row?.drawn_at)
    return {
      id: String(row?.id ?? ''),
      itemId: row?.item_id ?? null,
      name: String(row?.item_name ?? ''),
      // 时间戳解析不出来就退到 0：宁可排序差一点，也不要 NaN 让页面上出现「NaN 分钟前」
      at: Number.isFinite(at) ? at : 0,
    }
  })

  return { entries, total: typeof data?.total === 'number' ? data.total : entries.length }
}

/* ── 接口 ③：新增一个条目（Day 18 接上，页面 3「添加」用）────────────── */

/**
 * 把用户新加的一条写到云端。
 * @param {{name:string,type:string,platform:string,spicy?:string,tags?:string[]}} payload
 * @returns `{ item }` —— **服务端返回的那一条**（`id` / `created_at` 是数据库生成的）
 *
 * ⚠️ 调用方必须把返回的 `item` **原样写进本地存储**，不要自己再造一个 id ——
 *    否则本地 id 和云端对不上，以后按 id 删除 / 更新就全错了。
 *
 * ⚠️ 失败时抛 Error，`err.code` 直接用服务端给的码：
 *    `DUPLICATE_NAME`（重名）/ `INVALID_NAME` / `INVALID_TYPE` / `INVALID_PLATFORM` …
 *    而 `err.message` **就是服务端写好的中文提示**，界面拿去直接显示即可，不用自己编。
 */
export async function createItem(payload) {
  const data = await requestJson('/api/items', { method: 'POST', body: payload })
  const item = data?.item
  if (!item || typeof item !== 'object' || !item.id) {
    const e = new Error('服务器没有返回新建的条目')
    e.code = 'BAD_RESPONSE'
    throw e
  }
  // tags 兜底成数组 —— 跟 fetchItems 同一个理由：真为 null 时页面会崩
  return { item: { ...item, tags: Array.isArray(item.tags) ? item.tags : [] } }
}

/* ── 接口 ④：健康检查（Day 20 · 检查台用）───────────────────────────── */

/**
 * 问一句「后端活着吗」。
 * **不查库** —— 这是它最轻的地方，也是它有用的地方：
 * 它挂了 = 连服务都没连上；它通了但 `fetchItems` 挂了 = 服务活着、数据库有问题。
 * 两者分开看，排查时少猜一半。
 *
 * @returns `{ service: string, ms: number }` —— ms 是往返耗时（含解析）
 */
export async function fetchHealth() {
  const t0 = Date.now()
  const data = await requestJson('/api/health')
  return { service: data?.service ?? '未知', ms: Date.now() - t0 }
}

/* ── 接口 ⑤：删除一个条目（Day 22 接上，页面 2「我的清单」用）────────── */

/**
 * 把某一条从云端删掉。
 * @param {string} id 要删的条目 id
 * @returns `{ deleted: string }` —— 契约规定只回被删的 id，不回整行
 *
 * ⚠️ 失败时抛 Error，`err.code` 是服务端给的码。调用方要分清两类：
 *
 *   · **`NOT_FOUND`** —— 这条**已经不在云端了**（别处删过、或者 id 传错了）。
 *     ⚠️ 这个要**当成功处理**：用户的目标是"让这条不存在"，而它已经不存在了 ——
 *     目标达成了。当成失败拦着用户没有任何意义（他点第二遍还是 404）。
 *
 *   · 其余（`NETWORK` / `TIMEOUT` / `INTERNAL_ERROR` …）—— **真失败**。
 *     这时本地那条**绝对不能删** —— 本地删了、云端还在，刷新页面它就复活了。
 *
 * 依据：api-contract.md 第四节「4. DELETE /api/items/:id」。
 */
export async function deleteItem(id) {
  /* id 是数据库来的（UUID 或者 b01 这种稳定 id），拼进路径理论上没风险；
     还是 encodeURIComponent 一下 —— 万一将来 id 格式变了（带空格、中文），
     也不会拼出一个坏 URL 去查库。 */
  const data = await requestJson(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return { deleted: data?.deleted ?? id }
}
