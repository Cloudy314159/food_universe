'use strict'

/* 云函数：api（**HTTP 云函数**）—— 只做「接口层」
 * ═══════════════════════════════════════════════════════════════════
 * 这个文件只干三件事：
 *   ① 起一个 HTTP 服务（监听 9000，平台硬性要求）
 *   ② 把请求路由到对应的 handler
 *   ③ handler 里：**接请求 → 调下层 → 返响应**
 *
 * ── 它不管什么（Day 19 拆出去的）─────────────────────────────────────
 *   · **不查数据库**：表名、列名、排序、SQL 参数，这里一个字都不出现
 *     → `repositories/itemsRepository.js`、`repositories/historyRepository.js`
 *   · **不拼 HTTP 细节**：响应外壳、读请求体、解析 limit
 *     → `lib/http.js`
 *   · **不写校验规则**：什么算合法名称 / 类别 / 平台
 *     → `lib/validate.js`
 *
 *   为什么要这么分：以后改数据库（加列、换表）不用动接口代码；
 *   改响应格式不用动数据库代码。每一层只知道自己那点事。
 *
 * ── 它提供什么 ─────────────────────────────────────────────────────
 *   GET  /api/health    后端活着吗（不查库）
 *   GET  /api/items     读全部候选条目           ← 首页候选池、清单页都用它
 *   POST /api/items     新增一个条目              ← 添加页提交
 *   GET  /api/history   读最近的历史记录（倒序）   ← 历史记录页
 *
 * 依据：仓库根目录 api-contract.md 第四节。
 *
 * ── 统一响应外壳（契约规定，所有接口一致）──────────────────────────
 *   成功：{ "ok": true,  "data": { ... }, "error": null }
 *   失败：{ "ok": false, "data": null, "error": { "code": "...", "message": "..." } }
 *   （外壳本身在 lib/http.js 里；这里只管用）
 * ═══════════════════════════════════════════════════════════════════
 */

const http = require('http')

const { sendOk, sendErr, parseLimit, readBody } = require('./lib/http.js')
const { validateNewItem } = require('./lib/validate.js')
const itemsRepository = require('./repositories/itemsRepository.js')
const historyRepository = require('./repositories/historyRepository.js')

const PORT = 9000 // ⚠️ 平台硬性要求，改了跑不起来
const HOST = '0.0.0.0'

/* 各接口默认返回条数 —— 这是"接口策略"，不是"数据知识"，所以留在这一层 */
const DEFAULT_ITEMS_LIMIT = 500
const MAX_ITEMS_LIMIT = 1000
const DEFAULT_HISTORY_LIMIT = 20
const MAX_HISTORY_LIMIT = 200

/* ── 各接口的实现 ─────────────────────────────────────────────────── */

/** GET /api/health —— 不查库，只回答"活着" */
function handleHealth(res) {
  sendOk(res, { service: 'model' })
}

/** GET /api/items —— 读全部候选条目 */
async function handleItems(res, url) {
  const limit = parseLimit(url.searchParams.get('limit'), DEFAULT_ITEMS_LIMIT, MAX_ITEMS_LIMIT)
  const rows = await itemsRepository.listItems(limit)
  sendOk(res, { items: rows, total: rows.length })
}

/** GET /api/history —— 读历史记录，按时间倒序 */
async function handleHistory(res, url) {
  const limit = parseLimit(url.searchParams.get('limit'), DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT)
  const rows = await historyRepository.listHistory(limit)
  sendOk(res, { entries: rows, total: rows.length })
}

/* POST /api/items —— 新增一个条目
 *
 * 依据：api-contract.md 第四节「2. POST /api/items」。
 * 这个 handler 就是一条直线：**读 body → 校验 → 写库 → 翻错误码 → 返响应**。
 * 每一步的细节都在下层（readBody / validateNewItem / itemsRepository.createItem）。
 */
async function handleCreateItem(req, res) {
  /* ① 读请求体、解析 JSON */
  let raw = ''
  try {
    raw = await readBody(req)
  } catch {
    return sendErr(res, 400, 'INVALID_BODY', '请求体读取失败，请重试')
  }

  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return sendErr(res, 400, 'INVALID_BODY', '请求体必须是 JSON 格式')
  }

  /* ② 校验 —— 规则在 lib/validate.js，这里只管"不合格就照它说的回" */
  const checked = validateNewItem(payload)
  if (!checked.ok) {
    return sendErr(res, checked.status, checked.code, checked.message)
  }

  /* ③ 写库（表名、列名都在 repository 里，这边不关心） */
  const { name, type, platform } = checked.fields
  try {
    const item = await itemsRepository.createItem(checked.fields)
    // 成功留一条日志 —— 以后查"这条是什么时候谁加进去的"有据可循
    console.log('[api] POST /api/items 成功', JSON.stringify({ id: item?.id, name, type, platform }))
    return sendOk(res, { item }, 201)
  } catch (err) {
    /* 数据库的错误码已经由 repositories/client.js **剥过网关前缀**，
       这里拿到的 `err.pgCode` 就是裸的 SQLSTATE，直接判即可。 */
    if (err.pgCode === '23505') {
      // 唯一约束冲突 = 重名 → 契约要求翻成 409，**不能让它变成 500**
      console.log('[api] POST /api/items 被拒（重名）', JSON.stringify({ name }))
      return sendErr(res, 409, 'DUPLICATE_NAME', `已经有叫「${name}」的条目了，换个名字吧`)
    }
    if (err.pgCode === '23514') {
      // CHECK 约束 —— 应用层理论上已挡住，兜底也给中文
      console.log(
        '[api] POST /api/items 被拒（字段不合法）',
        JSON.stringify({ name, detail: err.message })
      )
      return sendErr(res, 400, 'INVALID_FIELD', '有字段的取值不合法，检查一下类别/平台/辣度')
    }
    console.log('[api] POST /api/items 失败', JSON.stringify({ name, detail: err.message }))
    throw err // 交给最外层统一报 500
  }
}

/* ── 路由 ─────────────────────────────────────────────────────────── */

/* 每条路径都认"带 /api 前缀"和"不带"两种写法 —— 网关是否把前缀透传给函数
   各环境配置不同，两个都认就不用担心这个问题。 */
const ROUTES = [
  { path: ['/', '/api/health'],         method: 'GET',  fn: (res) => handleHealth(res) },
  { path: ['/api/items', '/items'],     method: 'GET',  fn: (res, url) => handleItems(res, url) },
  // 同一个路径、不同方法：读是 GET，写是 POST。⚠️ 路由按 method 匹配，两条不打架。
  { path: ['/api/items', '/items'],     method: 'POST', fn: (res, url, req) => handleCreateItem(req, res) },
  { path: ['/api/history', '/history'], method: 'GET',  fn: (res, url) => handleHistory(res, url) },
]

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')

  // 日志：控制台「日志」里能看到，排查时是第一现场
  console.log('[api]', req.method, url.pathname, url.search || '')

  /* 浏览器跨域预检：不查库、不问业务，直接回「允许」。
     线上这一步网关会先拦下来，所以这个分支实际是给"本地直接 node index.js"
     这种调法兜底的。
     ⚠️ 跨域头**只在这个分支里写**，不要搬到 lib/http.js 的 send() 里去。 */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    })
    return res.end()
  }

  try {
    const hit = ROUTES.find((r) => r.method === req.method && r.path.includes(url.pathname))
    if (!hit) {
      return sendErr(res, 404, 'NOT_FOUND', `没有这个接口：${req.method} ${url.pathname}`)
    }
    await hit.fn(res, url, req)
  } catch (err) {
    console.error('[api] 处理失败', err)
    const detail = err && err.message ? err.message : '未知错误'
    return sendErr(res, 500, 'INTERNAL_ERROR', `服务端出错：${detail}`)
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[api] listening on http://${HOST}:${PORT}`)
})
