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
 *   GET   /api/health       后端活着吗（不查库）
 *   GET   /api/items        读全部候选条目        ← 首页候选池、清单页都用它
 *   POST  /api/items        新增一个条目           ← 添加页提交
 *   PATCH /api/items/:id    改一个条目（部分更新）  ← Day 22 新增（前端暂无入口）
 *   DELETE /api/items/:id   删一个条目             ← 清单页删除按钮（Day 22）
 *   GET   /api/history      读最近的历史记录（倒序） ← 历史记录页
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

const { sendOk, sendErr, parseLimit, readJsonBody } = require('./lib/http.js')
const { validateNewItem, validateItemPatch } = require('./lib/validate.js')
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

/** GET /api/items —— 读候选条目
 *  ⚠️ `limit` 只限制"取几条"，`total` 是**表里的总条数**（Day 24 修正）。
 *     以前写 `total: rows.length`，等于把"本页几条"当成"一共几条"：
 *     `?limit=3` 就回 `total: 3`（实际 18），这个字段等于白给。 */
async function handleItems(res, url) {
  const limit = parseLimit(url.searchParams.get('limit'), DEFAULT_ITEMS_LIMIT, MAX_ITEMS_LIMIT)
  const { rows, total } = await itemsRepository.listItems(limit)
  sendOk(res, { items: rows, total })
}

/** GET /api/history —— 读历史记录，按时间倒序（`total` 同样是总条数） */
async function handleHistory(res, url) {
  const limit = parseLimit(url.searchParams.get('limit'), DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT)
  const { rows, total } = await historyRepository.listHistory(limit)
  sendOk(res, { entries: rows, total })
}

/* POST /api/items —— 新增一个条目
 *
 * 依据：api-contract.md 第四节「2. POST /api/items」。
 * 这个 handler 就是一条直线：**读 body → 校验 → 写库 → 翻错误码 → 返响应**。
 * 每一步的细节都在下层（readBody / validateNewItem / itemsRepository.createItem）。
 */
async function handleCreateItem(req, res) {
  /* ① 读请求体、解析 JSON（细节在 lib/http.js 的 readJsonBody） */
  const rb = await readJsonBody(req)
  if (!rb.ok) return sendErr(res, rb.status, rb.code, rb.message)

  /* ② 校验 —— 规则在 lib/validate.js，这里只管"不合格就照它说的回" */
  const checked = validateNewItem(rb.payload)
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

/* PATCH /api/items/:id —— 改一个条目（**部分更新**：只改传了的字段）
 *
 * 依据：api-contract.md 第四节「3. PATCH /api/items/:id」。
 * 和 POST 一样是一条直线：**读 body → 校验 → 改库 → 翻错误码 → 返响应**。
 *
 * ⚠️ 这个 handler 有**三种失败**，别混：
 *    · 校验不过   → 400（validate 层给的，中文消息直接用）
 *    · id 查不到  → 404 NOT_FOUND（"改了 0 行"就是没这条）
 *    · 新名字撞人 → 409 DUPLICATE_NAME（数据库 23505）
 */
async function handleUpdateItem(req, res, id) {
  const rb = await readJsonBody(req)
  if (!rb.ok) return sendErr(res, rb.status, rb.code, rb.message)

  const checked = validateItemPatch(rb.payload)
  if (!checked.ok) {
    return sendErr(res, checked.status, checked.code, checked.message)
  }

  try {
    const item = await itemsRepository.updateItem(id, checked.fields)

    /* ⚠️ 改一个不存在的 id，数据库**不报错** —— 它只"影响了 0 行"。
       repository 已经把这种情况收敛成 `null`，这里翻成 404。
       用 `== null` 而不是 `!item`：将来返回值形状变了也不会漏判。 */
    if (item == null) {
      console.log('[api] PATCH /api/items 未命中', JSON.stringify({ id }))
      return sendErr(res, 404, 'NOT_FOUND', `没有找到 id 为「${id}」的条目，它可能已经被删了`)
    }

    console.log(
      '[api] PATCH /api/items 成功',
      JSON.stringify({ id, fields: Object.keys(checked.fields) })
    )
    return sendOk(res, { item })
  } catch (err) {
    /* 数据库错误码已由 repositories/client.js 剥过网关前缀，
       这里的 `err.pgCode` 就是裸的 SQLSTATE。 */
    if (err.pgCode === '23505') {
      // 唯一约束冲突 = 改完的名字撞上别人 → 契约要求 409，不能变成 500
      const newName = checked.fields.name ?? id
      console.log('[api] PATCH /api/items 被拒（重名）', JSON.stringify({ id, name: newName }))
      return sendErr(res, 409, 'DUPLICATE_NAME', `已经有叫「${newName}」的条目了，换个名字吧`)
    }
    if (err.pgCode === '23514') {
      // CHECK 约束 —— 应用层理论上已挡住，兜底也给中文
      console.log(
        '[api] PATCH /api/items 被拒（字段不合法）',
        JSON.stringify({ id, detail: err.message })
      )
      return sendErr(res, 400, 'INVALID_FIELD', '有字段的取值不合法，检查一下类别/平台/辣度')
    }
    console.log('[api] PATCH /api/items 失败', JSON.stringify({ id, detail: err.message }))
    throw err // 交给最外层统一报 500
  }
}

/* DELETE /api/items/:id —— 删一个条目
 *
 * 依据：api-contract.md 第四节「4. DELETE /api/items/:id」。
 *
 * ⚠️ 这个 handler **没有请求体** —— 要删谁全在路径里，所以不用 readJsonBody。
 *
 * ⚠️ 和 PATCH 一个关键区别：**"不存在"要报 404，不能当成功**。
 *    理由见契约：把 id 传错了（多打一个空格）却显示"删除成功"，
 *    用户以为删了、其实没删 —— 那条数据下次还会冒出来。
 *    报 404 顺带告诉前端"你手里这条已经不在库里了"，它可以据此刷新列表。
 */
async function handleDeleteItem(req, res, id) {
  try {
    const deleted = await itemsRepository.removeItem(id)

    /* `null` = 数据库说"影响 0 行" = 没这条 id（不是异常，是正常结果） */
    if (deleted == null) {
      console.log('[api] DELETE /api/items 未命中', JSON.stringify({ id }))
      return sendErr(res, 404, 'NOT_FOUND', `没有找到 id 为「${id}」的条目，它可能已经被删了`)
    }

    /* 响应按契约：只回被删的 id，不回整行。
       （删掉的东西没必要再给前端一份 —— 它要做的是把本地那条也划掉。） */
    console.log('[api] DELETE /api/items 成功', JSON.stringify({ id }))
    return sendOk(res, { deleted: id })
  } catch (err) {
    console.log('[api] DELETE /api/items 失败', JSON.stringify({ id, detail: err.message }))
    throw err // 交给最外层统一报 500
  }
}

/* ── 路由 ─────────────────────────────────────────────────────────── */

/** 把「路径模式」和真实路径比对。
 *
 *  模式里的 `:xxx` 是**参数占位**（如 `/api/items/:id`），命中时把值取出来。
 *
 *  为什么不直接用字符串相等：Day 22 加的 PATCH/DELETE 把 id 放在**路径里**
 *  （`/api/items/b01`），而 id 是变长的 —— 没法枚举成一堆常量字符串。
 *  做法很朴素：按 `/` 切成段，**段数必须一样**，然后逐段比；
 *  占位段捕获值，其余段必须字面相等。
 *
 *  ⚠️ 段数校验不能省：少了它，`/api/items` 会被 `/api/items/:id` 匹配上，
 *     把一个空字符串当成 id 传下去（然后拿着空 id 去查库）。
 *  ⚠️ 捕获的值要 decodeURIComponent：id 里万一带了需要转义的字符（中文、空格），
 *     不解码就会带着 %XX 去查，永远查不到。
 *
 *  @returns 命中时返回参数对象（如 `{ id: 'b01' }`），不中返回 `null` */
function matchRoute(pattern, pathname) {
  const pSeg = pattern.split('/')
  const aSeg = pathname.split('/')
  if (pSeg.length !== aSeg.length) return null

  const params = {}
  for (let i = 0; i < pSeg.length; i++) {
    if (pSeg[i].startsWith(':')) {
      if (!aSeg[i]) return null // 占位段是空的（如 `/api/items/`）→ 不算命中
      params[pSeg[i].slice(1)] = decodeURIComponent(aSeg[i])
    } else if (pSeg[i] !== aSeg[i]) {
      return null
    }
  }
  return params
}

/* 每条路径都认"带 /api 前缀"和"不带"两种写法 —— 网关是否把前缀透传给函数
   各环境配置不同，两个都认就不用担心这个问题。 */
const ROUTES = [
  { paths: ['/', '/api/health'],             method: 'GET',   fn: (res) => handleHealth(res) },
  { paths: ['/api/items', '/items'],         method: 'GET',   fn: (res, url) => handleItems(res, url) },
  // 同一个路径、不同方法：读是 GET，写是 POST。⚠️ 路由按 method 匹配，两条不打架。
  { paths: ['/api/items', '/items'],         method: 'POST',  fn: (res, url, req) => handleCreateItem(req, res) },
  /* Day 22：id 在路径里。matchRoute 把 `:id` 取出来，作为第 4 个参数交给 handler。
     ⚠️ 这条和上面的 POST 是**不同方法**，路由不会串。 */
  { paths: ['/api/items/:id', '/items/:id'], method: 'PATCH',  fn: (res, url, req, params) => handleUpdateItem(req, res, params.id) },
  { paths: ['/api/items/:id', '/items/:id'], method: 'DELETE', fn: (res, url, req, params) => handleDeleteItem(req, res, params.id) },
  { paths: ['/api/history', '/history'],     method: 'GET',   fn: (res, url) => handleHistory(res, url) },
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
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    })
    return res.end()
  }

  try {
    /* 找路由：同一路径可能挂多个方法，所以 method 也要对上。
       命中时顺便把路径参数（`:id` 这类）一起捞出来。 */
    let hit = null
    let params = {}
    for (const r of ROUTES) {
      if (r.method !== req.method) continue
      for (const p of r.paths) {
        const m = matchRoute(p, url.pathname)
        if (m) {
          hit = r
          params = m
          break
        }
      }
      if (hit) break
    }

    if (!hit) {
      return sendErr(res, 404, 'NOT_FOUND', `没有这个接口：${req.method} ${url.pathname}`)
    }
    await hit.fn(res, url, req, params)
  } catch (err) {
    /* ⚠️ Day 23 改的：这里**不再把 err.message 透给用户**。
       改之前是 `服务端出错：${err.message}`，而那条 message 长这样：
         `查 items 失败：HTTP 500 {"code":"DATABASE_28P01","message":"..."}`
       —— HTTP 状态码 + 英文 + 数据库原始响应体，全印在用户界面上。
       那是给我们自己排错看的，不是给用户看的。

       现在分两路走：
         · **用户**拿到一句人话，不带任何技术细节
         · **完整信息**（含 err.detail / pgCode）写进服务端日志 —— 控制台「日志」页能查
       前端仍然能拿到 code（INTERNAL_ERROR），需要的话可以据此做分支。 */
    console.error(
      '[api] 处理失败',
      JSON.stringify({
        code: err?.code || 'UNKNOWN',
        httpStatus: err?.httpStatus,
        pgCode: err?.pgCode,
        detail: err?.detail || err?.message || '未知错误',
      })
    )
    if (err?.stack) console.error(err.stack)
    return sendErr(res, 500, 'INTERNAL_ERROR', '服务器开小差了，稍后再试一次')
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[api] listening on http://${HOST}:${PORT}`)
})
