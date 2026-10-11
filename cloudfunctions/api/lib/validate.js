'use strict'

/* 校验层 · 新增条目的字段校验
 * ═══════════════════════════════════════════════════════════════════
 * 纯逻辑，**不碰数据库、不碰 HTTP** —— 输入一个 payload，输出
 * 「合格的字段」或「哪个字段不合格、该回什么」。
 *
 * ── 为什么要在应用层再校验一遍（数据库明明已经有 CHECK / UNIQUE）──
 * 因为**数据库报的错是英文 SQLSTATE**（如 `23505 duplicate key value ...`），
 * 直接透给用户看到的是一串看不懂的东西。契约要求提示是**中文**。
 * 所以应用层先把能判的都判掉、给出人话；数据库那层退化成最后一道保险。
 *
 * ⚠️ **重名不在这一层判** —— 那要查库，是 repository 的活。
 * ═══════════════════════════════════════════════════════════════════
 */

/* 三个枚举字段的合法取值 —— 与 db/schema.sql 的 CHECK 约束一一对应。
   在这里再列一遍，只为了能把错误翻成中文。 */
const VALID_TYPES = ['dish', 'shop']
const VALID_PLATFORMS = ['mt', 'tb', 'any']
const VALID_SPICY = ['none', 'mild', 'medium', 'hot', 'any']

/* 名称长度（契约、数据库 char_length BETWEEN 1 AND 20，三处保持一致） */
const NAME_MIN = 1
const NAME_MAX = 20

/** 按**字符**算长度：中文一个字算一个。
    用 `[...s]` 而不是 `s.length` —— 后者算的是 UTF-16 码元，
    对 emoji 之类会算成 2，跟数据库的 char_length 对不上。 */
function charLength(s) {
  return [...s].length
}

function fail(status, code, message) {
  return { ok: false, status, code, message }
}

/**
 * 校验并规范化「新增条目」的请求体。
 *
 * @param {*} payload 解析后的 JSON
 * @returns `{ ok:true, fields }` 或 `{ ok:false, status, code, message }`
 *
 * ⚠️ 不合格时**直接把该回给前端的东西一并给出**（状态码 + 错误码 + 中文消息）——
 *    handler 拿到就能 `sendErr`，不用再写一遍 if/else。
 *    `status` / `code` / `message` 与契约第四节 POST 的错误表逐条一致。
 */
function validateNewItem(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail(400, 'INVALID_BODY', '请求体必须是一个 JSON 对象')
  }

  /* ① name —— 必填；去空白后 1–20 字；**不允许首尾带空白** */
  if (payload.name === undefined || payload.name === null) {
    return fail(400, 'INVALID_NAME', '缺少必填字段：name（名称）')
  }
  if (typeof payload.name !== 'string') {
    return fail(400, 'INVALID_NAME', '名称必须是文字')
  }
  // JS 正则里的 \s 已包含全角空格 U+3000，所以 trim() 就够
  const name = payload.name.trim()
  if (name === '') {
    return fail(400, 'INVALID_NAME', '名称不能为空')
  }
  if (name !== payload.name) {
    return fail(400, 'INVALID_NAME', '名称首尾不能有空白，去掉后再试一次')
  }
  const len = charLength(name)
  if (len < NAME_MIN || len > NAME_MAX) {
    return fail(400, 'INVALID_NAME', `名称长度需要在 1–20 字之间（现在 ${len} 字）`)
  }

  /* ② type —— 必填，只能是菜或店 */
  if (payload.type === undefined || payload.type === null) {
    return fail(400, 'INVALID_TYPE', '缺少必填字段：type（类别）')
  }
  const type = String(payload.type).trim()
  if (!VALID_TYPES.includes(type)) {
    return fail(400, 'INVALID_TYPE', '类别只能是「菜」(dish) 或「店」(shop)')
  }

  /* ③ platform —— 必填，只能是三个平台之一 */
  if (payload.platform === undefined || payload.platform === null) {
    return fail(400, 'INVALID_PLATFORM', '缺少必填字段：platform（平台）')
  }
  const platform = String(payload.platform).trim()
  if (!VALID_PLATFORMS.includes(platform)) {
    return fail(400, 'INVALID_PLATFORM', '平台只能是 mt（美团）/ tb（淘宝闪购）/ any（不限）')
  }

  /* ④ spicy —— 可选，不传即 any */
  const spicyRaw = payload.spicy
  const spicy =
    spicyRaw === undefined || spicyRaw === null || spicyRaw === ''
      ? 'any'
      : String(spicyRaw).trim()
  if (!VALID_SPICY.includes(spicy)) {
    return fail(400, 'INVALID_SPICY', '辣度只能是 none / mild / medium / hot / any')
  }

  /* ⑤ tags —— 可选，不传即空数组 */
  let tags = []
  if (payload.tags !== undefined && payload.tags !== null) {
    if (!Array.isArray(payload.tags)) {
      return fail(400, 'INVALID_TAGS', '忌口标签必须是一个数组')
    }
    tags = payload.tags.map((t) => String(t).trim()).filter((t) => t !== '')
  }

  /* ⑥ source 由**服务端**定死为 user —— 前端不用传也不能传，
        否则有人能提交 source:'builtin' 冒充内置条目，
        混进"永远不会被筛掉"的那一类。 */
  return {
    ok: true,
    fields: { name, type, platform, spicy, tags, source: 'user' },
  }
}

module.exports = { validateNewItem, charLength, NAME_MAX }
