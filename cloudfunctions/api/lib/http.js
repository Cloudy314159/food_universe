'use strict'

/* HTTP 工具层
 * ═══════════════════════════════════════════════════════════════════
 * 跟业务无关的两件事：
 *   ① **统一响应外壳** —— 所有接口都是 `{ ok, data, error }`（契约规定）
 *   ② 读请求体、解析 `?limit=`
 *
 * 它不知道什么叫"条目"、什么叫"重名"，只知道"响应该长什么样"。
 * ═══════════════════════════════════════════════════════════════════
 */

/** 成功：{ ok: true, data, error: null } */
function sendOk(res, data, status = 200) {
  send(res, status, { ok: true, data, error: null })
}

/** 失败：{ ok: false, data: null, error: { code, message } } */
function sendErr(res, status, code, message) {
  send(res, status, { ok: false, data: null, error: { code, message } })
}

/* ── 跨域（CORS）────────────────────────────────────────────────────
   ⚠️⚠️ 这件事**由网关负责，函数里千万不要自己加 Access-Control-Allow-Origin**。

   Day 17 实测踩到的坑：函数里写了一行 `Access-Control-Allow-Origin: *`，
   而网关自己也会加一个（回显请求的 Origin）。两边一拼，浏览器收到的是：

       access-control-allow-origin: https://xxx.tcloudbaseapp.com,*

   规范里这个头**只允许一个值或 `*`**，逗号列表会被判为无效 ——
   结果是"明明两个地方都配了跨域，反而跨不过去"，而且报错指不到真正的原因。

   所以：网关加，函数不加。
   （index.js 里那个 OPTIONS 分支保留着 —— 本地直接 `node index.js` 调试时用得到。）
   ───────────────────────────────────────────────────────────────── */
function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/** 把 `?limit=` 解析成一个安全的整数 */
function parseLimit(raw, fallback, max) {
  if (raw === null || raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max) // 卡上限：防止有人传 999999
}

/**
 * 把请求体读完。
 * ⚠️ HTTP 云函数里 `req` 是**流**，不是现成的对象 —— 得一截一截收再拼成字符串。
 *    没有 `req.body`（那是 Express 才有的）。
 */
function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      // 我们最大的请求也就几百字节；给个天花板，防止有人灌垃圾把内存占满
      if (size > maxBytes) {
        req.destroy()
        reject(Object.assign(new Error('请求体超过 64KB'), { code: 'BODY_TOO_LARGE' }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 读请求体 + 解析成 JSON —— **写接口共用**（POST / PATCH）。
 *
 * 抽出来的理由：这两步（收流、解析）在 POST 和 PATCH 里一模一样，
 * 连报错的中文文案都得一致（契约要求）。各写一份迟早会漂移 ——
 * 比如 PATCH 那条把消息写成"请求体格式错误"，前端就得为同一件事认两种话。
 *
 * @returns `{ ok:true, payload }` 或 `{ ok:false, status, code, message }`
 *   ⚠️ 失败时的形状和 lib/validate.js 的 `fail()` **故意一模一样** ——
 *      handler 拿到只需要 `if (!r.ok) return sendErr(res, r.status, r.code, r.message)`，
 *      不用分辨这个错是"读 body 阶段"还是"校验阶段"的。
 */
async function readJsonBody(req) {
  let raw = ''
  try {
    raw = await readBody(req)
  } catch {
    return { ok: false, status: 400, code: 'INVALID_BODY', message: '请求体读取失败，请重试' }
  }

  try {
    return { ok: true, payload: JSON.parse(raw) }
  } catch {
    return { ok: false, status: 400, code: 'INVALID_BODY', message: '请求体必须是 JSON 格式' }
  }
}

module.exports = { sendOk, sendErr, send, parseLimit, readBody, readJsonBody }
