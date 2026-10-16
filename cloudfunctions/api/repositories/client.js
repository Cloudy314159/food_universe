'use strict'

/* 数据访问层 · 底层客户端
 * ═══════════════════════════════════════════════════════════════════
 * 这一层**只干一件事**：把"要查/要写哪张表"翻译成 PostgREST 的 HTTP 请求，
 * 再把响应变回 JS 对象（或者抛一个带 `pgCode` 的错误）。
 *
 * 它**不懂业务**：不知道什么是"条目"、不知道"重名该不该拒"。
 * 那是上面的 repositories/itemsRepository.js 和 index.js 的事。
 *
 * ── 为什么不用 PostgreSQL 直连（Day 17 定的）──────────────────────
 * 新版控制台**不展示数据库连接串**，云函数也不会自动注入连接信息 ——
 * 直连那条路在控制台拿不到入口。改用控制台签发的**服务端 API Key** 调 HTTP API。
 * 好处：不用数据库密码、**零依赖**（Node 20 内置 fetch）、Key 可撤销。
 *
 * 凭据：环境变量 **TCB_API_KEY**（配在云函数环境变量里，不进代码、不进仓库）。
 * ═══════════════════════════════════════════════════════════════════
 */

/* 环境 ID：不是秘密（只是个标识），给个默认值方便本地调试 */
const ENV_ID = process.env.TCB_ENV_ID || 'model-d5gisaem106ad6a18'

/* PostgREST 风格的根地址：/v1/rdb/rest/<表名> */
const REST_BASE = `https://${ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest`

/** 把 CloudBase 网关包装过的 SQLSTATE 还原成裸值。
 *
 *  ⚠️ Day 18 实测踩到的坑：报唯一约束冲突时，**原生 PostgREST** 给的是
 *  `{"code":"23505"}`，而 **CloudBase 网关会包一层** → `{"code":"DATABASE_23505"}`。
 *  只判裸值会让"重名"漏判，最后变成 500 而不是 409。
 *
 *  这是"跟数据库打交道"的知识，所以放在这一层统一剥掉 ——
 *  上层拿到的 `err.pgCode` 永远是裸的 `23505`，不用各自记得去剥。 */
function normalizePgCode(raw) {
  return String(raw || '').replace(/^DATABASE_/, '')
}

function parseJsonQuietly(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function requireApiKey() {
  const apiKey = process.env.TCB_API_KEY
  if (!apiKey) {
    const err = new Error('没有配置 TCB_API_KEY（云函数环境变量里缺这个）')
    err.code = 'NO_API_KEY'
    throw err
  }
  return apiKey
}

/**
 * 查一张表。
 * @param {string} table  表名（**只允许代码里写死的字面量**，绝不能用用户输入）
 * @param {object} params PostgREST 查询参数，如 { select, order, limit, name }
 * @returns {Promise<Array>} 行数组
 *
 * ⚠️ 关于"参数化"：参数用 **URLSearchParams** 拼，它自动做 URL 编码 ——
 *    用户传进来的值（比如 ?limit=）不可能变成 SQL 片段。
 *    表名和列名都是代码里写死的字面量。所以不存在注入风险。
 */
async function queryTable(table, params) {
  const url = new URL(`${REST_BASE}/${table}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value)
    }
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      Accept: 'application/json',
    },
  })

  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`查 ${table} 失败：HTTP ${res.status} ${text.slice(0, 300)}`)
    err.code = 'DB_QUERY_FAILED'
    err.pgCode = normalizePgCode(parseJsonQuietly(text)?.code)
    throw err
  }

  const rows = parseJsonQuietly(text)
  if (rows === null) {
    throw new Error(`查 ${table} 返回的不是 JSON：${text.slice(0, 200)}`)
  }
  return rows
}

/**
 * 往一张表插一行（PostgREST 的 POST）。
 * @param {string} table  表名（**只允许代码里写死的字面量**）
 * @param {object} row    要插入的行，键 = 数据库列名
 * @param {string} [readbackSelect] 兜底回读时取哪些列（不传就不回读）
 * @param {string} [readbackKey]    兜底回读按哪个字段等值匹配（默认 name）
 * @returns {Promise<object>} 插入后的那一行
 *
 * ── 为什么必须带 `Prefer: return=representation` ──────────────────
 * 默认 PostgREST 插入成功只回一个 201 空体。加上这个头，数据库会把**刚插进去的
 * 那一行**一起回给我们 —— 前端就能立刻拿到 `id` / `created_at`（都是数据库生成的，
 * 只有拿到才知道）。
 *
 * ── 兜底 ──────────────────────────────────────────────────────────
 * 万一平台不支持这个头（响应体是空的）→ 按**唯一字段**回读一次。
 * 传了 `readbackSelect` 才回读；没传就认为调用方不关心返回值。
 *
 * ⚠️ 这里**不做**"什么算冲突"的业务判断 —— 只把 SQLSTATE 原样带出去
 *    （已经剥过网关前缀），由调用方决定翻成哪个状态码。
 */
async function insertRow(table, row, readbackSelect, readbackKey = 'name') {
  const res = await fetch(`${REST_BASE}/${table}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  })

  const text = await res.text()

  if (!res.ok) {
    // 错误体是 JSON：{ code, message, requestId }；code 是 SQLSTATE（可能带 DATABASE_ 前缀）
    const err = new Error(`写 ${table} 失败：HTTP ${res.status} ${text.slice(0, 300)}`)
    err.code = 'DB_WRITE_FAILED'
    err.httpStatus = res.status
    err.pgCode = normalizePgCode(parseJsonQuietly(text)?.code)
    throw err
  }

  // 正常：PostgREST 回一个数组，里面是插入的行
  const rows = parseJsonQuietly(text)
  if (Array.isArray(rows) && rows.length > 0) return rows[0]

  // 兜底：没拿到插入结果 → 按唯一字段回读（比如 name 有唯一约束，只会命中一行）
  if (readbackSelect) {
    const keyValue = row[readbackKey]
    if (keyValue !== undefined && keyValue !== null) {
      const found = await queryTable(table, {
        select: readbackSelect,
        [readbackKey]: `eq.${keyValue}`,
        limit: '1',
      })
      if (Array.isArray(found) && found.length > 0) return found[0]
    }
  }

  const err = new Error(`写 ${table} 之后没能读回那一行`)
  err.code = 'DB_WRITE_READBACK_FAILED'
  throw err
}

/**
 * 改一行（PostgREST 的 PATCH）。Day 22 新增。
 *
 * @param {string} table  表名（**只允许代码里写死的字面量**）
 * @param {string} id     改哪一行（按主键 `id` 等值匹配）
 * @param {object} patch  要改的字段，键 = 数据库列名。**只放要改的列** ——
 *                        没放的列数据库里原地不动，这就是"部分更新"。
 * @param {string} [readbackSelect] 兜底回读时取哪些列
 * @returns {Promise<object|null>} 改完之后的那一行；**`null` = 这个 id 不存在**
 *
 * ── ⚠️ 这个函数最容易踩的坑：改一个不存在的 id，数据库**不报错** ──────
 * PostgREST 更新 0 行时返回的是 `200` + **空数组**，不是 404。
 * 所以"到底改没改到"**只能靠"有没有回读到行"来判断，不能看 HTTP 状态码**。
 *
 * 空返回有两种可能，必须分开：
 *   ① 这个 id 真的不存在            → 该报 404
 *   ② id 存在，但平台没回 representation（`Prefer` 头没被支持）→ 其实改成功了
 * 分不清就会把"改成功"错报成 404，或者反过来把"没这条"当成成功。
 * 办法：空的时候**回读一次** —— 读得到就是 ②，读不到就是 ①。
 * （Day 18 实测平台是支持 `Prefer: return=representation` 的，
 *   所以正常路径走不到兜底那一步；留着它是为了防止平台行为变化。）
 *
 * ⚠️ 唯一约束冲突（改名字撞上别人）照旧抛 `err.pgCode === '23505'`，
 *    由调用方决定翻成 409 还是别的 —— 这一层不做业务判断。
 */
async function updateRow(table, id, patch, readbackSelect) {
  const url = new URL(`${REST_BASE}/${table}`)
  // PostgREST 的过滤语法：`?id=eq.<值>`。用 URLSearchParams 拼，值会被自动编码
  url.searchParams.set('id', `eq.${id}`)

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // 同 insertRow：不加这个头就只回一个空体，拿不到改完的那一行
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  })

  const text = await res.text()

  if (!res.ok) {
    const err = new Error(`改 ${table} 失败：HTTP ${res.status} ${text.slice(0, 300)}`)
    err.code = 'DB_WRITE_FAILED'
    err.httpStatus = res.status
    err.pgCode = normalizePgCode(parseJsonQuietly(text)?.code)
    throw err
  }

  // 正常：回一个数组，里面是改完的那一行
  const rows = parseJsonQuietly(text)
  if (Array.isArray(rows) && rows.length > 0) return rows[0]

  // 空 → 回读确认到底是"不存在"还是"平台没回 representation"（见上面的说明）
  if (readbackSelect) {
    const found = await queryTable(table, {
      select: readbackSelect,
      id: `eq.${id}`,
      limit: '1',
    })
    if (Array.isArray(found) && found.length > 0) return found[0]
  }

  return null
}

/**
 * 删一行（PostgREST 的 DELETE）。Day 22 新增。
 *
 * @param {string} table  表名（**只允许代码里写死的字面量**）
 * @param {string} id     删哪一行（按主键 `id` 等值匹配）
 * @param {string} [readbackSelect] 只用于"拿不到被删行"时的存在性回查（传了才会查）
 * @returns {Promise<object|null>} 被删掉的那一行；**`null` = 这个 id 本来就不存在**
 *
 * ── ⚠️ 这里跟 updateRow 的兜底**方向相反**，别照着抄 ────────────────
 * 更新是"改完再读一次" —— 读得到就是改成功了，逻辑是顺的。
 * 删除不行：**删完之后本来就查不到了**，"查不到"既可能是删成功、
 * 也可能是本来就没有，靠回读**分不出这两种**。
 *
 * 所以判断删没删到，只能靠 `Prefer: return=representation` 让数据库
 * **把删掉的那一行回给我们**（这就是它在这个函数里唯一的作用）：
 *   · 回了一个数组且有行  → 真删掉了，把那行带回去
 *   · 回了一个空数组      → PostgREST 说"影响 0 行" = 没这条 id
 *   · 回的**不是数组**（平台没支持那个头，回了 204 空体）→ 情况不明
 *
 * 最后那种情况只能**再查一次**来兜：
 *   · 还查得到 → 删除根本没生效 → 抛错（不能假装成功）
 *   · 查不到   → 确实没了；但拿不到原行内容，就回一个只有 `id` 的对象
 *                （调用方只需要知道"删掉了"，契约的响应本来也只回 id）
 */
async function deleteRow(table, id, readbackSelect) {
  const url = new URL(`${REST_BASE}/${table}`)
  url.searchParams.set('id', `eq.${id}`)

  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      Accept: 'application/json',
      Prefer: 'return=representation',
    },
  })

  const text = await res.text()

  if (!res.ok) {
    const err = new Error(`删 ${table} 失败：HTTP ${res.status} ${text.slice(0, 300)}`)
    err.code = 'DB_WRITE_FAILED'
    err.httpStatus = res.status
    err.pgCode = normalizePgCode(parseJsonQuietly(text)?.code)
    throw err
  }

  const rows = parseJsonQuietly(text)

  // 正常：回了数组 —— 有行 = 删掉了；空数组 = 没这条
  if (Array.isArray(rows)) return rows.length > 0 ? rows[0] : null

  // 非数组（平台没回 representation）→ 只能回查一次来分辨（见函数头说明）
  if (readbackSelect) {
    const still = await queryTable(table, { select: readbackSelect, id: `eq.${id}`, limit: '1' })
    if (Array.isArray(still) && still.length > 0) {
      const err = new Error(`删 ${table} 没生效：id=${id} 仍然查得到`)
      err.code = 'DB_DELETE_NOT_APPLIED'
      throw err
    }
    return { id }
  }

  const err = new Error(`删 ${table} 之后无法确认结果（平台没回被删的行）`)
  err.code = 'DB_DELETE_UNCERTAIN'
  throw err
}

module.exports = { queryTable, insertRow, updateRow, deleteRow }
