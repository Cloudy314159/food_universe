'use strict'

/* 校验层 · 条目的字段校验（新增 + 修改共用）
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
 *
 * ── Day 22 改过结构：单字段规则抽成 check*，两个入口共用 ─────────────
 * 之前只有「新增」一个入口，规则就直接写在 `validateNewItem` 里。
 * 加了 PATCH 之后就有两个入口了 —— 如果各写一份，「新增」和「修改」
 * 对同一个字段的要求迟早会漂移（比如 PATCH 那条忘了判长度，
 * 于是"把名字改成 25 个字"能过，而"新增一个 25 字的名字"过不去）。
 * 规则写一份、两边都调，就不可能出现这种偏差。
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

/* PATCH 允许改的字段（契约第四节「3. PATCH /api/items/:id」定的 5 个）。
   `id` / `source` / `created_at` **不在**这张表里 —— 它们不可改，传了就报错。 */
const PATCHABLE_FIELDS = ['name', 'type', 'platform', 'spicy', 'tags']

/* 明确不可改的字段。单独列出来是为了**报错时说的话更准**
   （"这个字段不允许修改" vs "不认识这个字段" —— 两种错因不一样）。 */
const READONLY_FIELDS = ['id', 'source', 'created_at']

/** 按**字符**算长度：中文一个字算一个。
    用 `[...s]` 而不是 `s.length` —— 后者算的是 UTF-16 码元，
    对 emoji 之类会算成 2，跟数据库的 char_length 对不上。 */
function charLength(s) {
  return [...s].length
}

function fail(status, code, message) {
  return { ok: false, status, code, message }
}

/** 对象上有没有这个键。用 `hasOwnProperty` 而不是 `payload[k] !== undefined` ——
    后者分不清「没传」和「传了 undefined」，也没法挡住原型链上的键。 */
function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/* ── 单字段校验：新增和修改共用同一份规则 ─────────────────────────────
   每个 check* 的返回值统一三种（调用方照这个形状判就行）：

     · `{ ok: true, has: false }`             没传这个字段
     · `{ ok: true, has: true, value }`       传了、合法、已规范化
     · `{ ok: false, status, code, message }` 传了但不合法（**自带该回什么**）

   ⚠️ 「没传」的判定沿用 POST 一直以来的语义：`undefined` 和 `null` **都算没传**
      （原先的代码就是这么写的，不动它）。PATCH 那条路想要更严格 ——
      显式传 `null` 要报错而不是静默跳过 —— 它在进 check 之前单独拦（见 validateItemPatch）。
   ───────────────────────────────────────────────────────────────── */

/** name：去首尾空白后 1–20 字，且**不允许带首尾空白** */
function checkName(raw, required) {
  if (raw === undefined || raw === null) {
    return required
      ? fail(400, 'INVALID_NAME', '缺少必填字段：name（名称）')
      : { ok: true, has: false }
  }
  if (typeof raw !== 'string') {
    return fail(400, 'INVALID_NAME', '名称必须是文字')
  }
  // JS 正则里的 \s 已包含全角空格 U+3000，所以 trim() 就够
  const name = raw.trim()
  if (name === '') {
    return fail(400, 'INVALID_NAME', '名称不能为空')
  }
  if (name !== raw) {
    return fail(400, 'INVALID_NAME', '名称首尾不能有空白，去掉后再试一次')
  }
  const len = charLength(name)
  if (len < NAME_MIN || len > NAME_MAX) {
    return fail(400, 'INVALID_NAME', `名称长度需要在 1–20 字之间（现在 ${len} 字）`)
  }
  return { ok: true, has: true, value: name }
}

/** type：只能是菜或店 */
function checkType(raw, required) {
  if (raw === undefined || raw === null) {
    return required
      ? fail(400, 'INVALID_TYPE', '缺少必填字段：type（类别）')
      : { ok: true, has: false }
  }
  const type = String(raw).trim()
  if (!VALID_TYPES.includes(type)) {
    return fail(400, 'INVALID_TYPE', '类别只能是「菜」(dish) 或「店」(shop)')
  }
  return { ok: true, has: true, value: type }
}

/** platform：只能是三个平台之一 */
function checkPlatform(raw, required) {
  if (raw === undefined || raw === null) {
    return required
      ? fail(400, 'INVALID_PLATFORM', '缺少必填字段：platform（平台）')
      : { ok: true, has: false }
  }
  const platform = String(raw).trim()
  if (!VALID_PLATFORMS.includes(platform)) {
    return fail(400, 'INVALID_PLATFORM', '平台只能是 mt（美团）/ tb（淘宝闪购）/ any（不限）')
  }
  return { ok: true, has: true, value: platform }
}

/** spicy：可选。空串也算"没传"（老代码就这么容错的，保持不动） */
function checkSpicy(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, has: false }
  const spicy = String(raw).trim()
  if (!VALID_SPICY.includes(spicy)) {
    return fail(400, 'INVALID_SPICY', '辣度只能是 none / mild / medium / hot / any')
  }
  return { ok: true, has: true, value: spicy }
}

/** tags：可选。必须是数组；元素去空白、去掉空串 */
function checkTags(raw) {
  if (raw === undefined || raw === null) return { ok: true, has: false }
  if (!Array.isArray(raw)) {
    return fail(400, 'INVALID_TAGS', '忌口标签必须是一个数组')
  }
  const tags = raw.map((t) => String(t).trim()).filter((t) => t !== '')
  return { ok: true, has: true, value: tags }
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

  /* 校验顺序 = 契约里列的字段顺序，多字段同时错时先报前面的那个。
     ⚠️ 顺序别乱动 —— 换了顺序，同一份错请求返回的 code 就变了。 */
  const rn = checkName(payload.name, true)
  if (!rn.ok) return rn

  const rt = checkType(payload.type, true)
  if (!rt.ok) return rt

  const rp = checkPlatform(payload.platform, true)
  if (!rp.ok) return rp

  const rs = checkSpicy(payload.spicy)
  if (!rs.ok) return rs

  const rg = checkTags(payload.tags)
  if (!rg.ok) return rg

  return {
    ok: true,
    fields: {
      name: rn.value,
      type: rt.value,
      platform: rp.value,
      spicy: rs.has ? rs.value : 'any',
      tags: rg.has ? rg.value : [],
      /* source 由**服务端**定死为 user —— 前端不用传也不能传，
         否则有人能提交 source:'builtin' 冒充内置条目，
         混进"永远不会被筛掉"的那一类。 */
      source: 'user',
    },
  }
}

/**
 * 校验并规范化「修改条目（PATCH）」的请求体 —— **部分更新**。
 *
 * @param {*} payload 解析后的 JSON，只带要改的字段
 * @returns `{ ok:true, fields }`（fields 里**只有这次真要改的字段**）
 *          或 `{ ok:false, status, code, message }`
 *
 * 依据：契约第四节「3. PATCH /api/items/:id」。
 *
 * 跟 `validateNewItem` 的三点不同，都是**故意的**：
 *   ① 部分更新：没传的字段不进 `fields`，调用方就不会把它写进 UPDATE，
 *      数据库里那些列**原地不动**（不是被清空成默认值）。
 *   ② 不可改字段（id/source/created_at）传了**报错**，不静默忽略 ——
 *      前端要是把字段名写错了（比如 source 写成 spicy），静默忽略会让它
 *      以为改成功了、用户也以为改成功了，而数据一个字没动。
 *      报错才能让这种错误当场暴露。
 *   ③ 显式传 `null` **报错**（契约里写了 null ≠ 没传）：不想改就不要传这个键。
 *      否则前端一个手滑 `null` 就能把字段改成默认值，而用户以为只是没改。
 */
function validateItemPatch(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail(400, 'INVALID_BODY', '请求体必须是一个 JSON 对象')
  }

  /* ① 不可改的字段 —— 报错，不静默忽略（理由见函数头 ②） */
  const readOnlyHit = READONLY_FIELDS.filter((k) => hasKey(payload, k))
  if (readOnlyHit.length > 0) {
    return fail(
      400,
      'NOT_UPDATABLE_FIELD',
      `字段「${readOnlyHit[0]}」不允许修改（能改的只有 ${PATCHABLE_FIELDS.join(' / ')}）`
    )
  }

  /* ② 不认识的字段（拼错的、或者加了新字段但没登记进契约）——
        同样报错，别让它变成"看起来改成功了"。 */
  const unknownKeys = Object.keys(payload).filter((k) => !PATCHABLE_FIELDS.includes(k))
  if (unknownKeys.length > 0) {
    return fail(
      400,
      'NOT_UPDATABLE_FIELD',
      `不认识字段「${unknownKeys[0]}」，能改的只有 ${PATCHABLE_FIELDS.join(' / ')}`
    )
  }

  /* ③ 显式传 null 一律拒绝（理由见函数头 ③） */
  for (const k of Object.keys(payload)) {
    if (payload[k] === null) {
      return fail(400, 'INVALID_PATCH', `字段「${k}」不能传 null —— 不想改它就别传这个字段`)
    }
  }

  /* ④ 逐字段校验，只收"这次真要改的" */
  const fields = {}

  if (hasKey(payload, 'name')) {
    const r = checkName(payload.name, true)
    if (!r.ok) return r
    fields.name = r.value
  }
  if (hasKey(payload, 'type')) {
    const r = checkType(payload.type, true)
    if (!r.ok) return r
    fields.type = r.value
  }
  if (hasKey(payload, 'platform')) {
    const r = checkPlatform(payload.platform, true)
    if (!r.ok) return r
    fields.platform = r.value
  }
  if (hasKey(payload, 'spicy')) {
    const r = checkSpicy(payload.spicy)
    if (!r.ok) return r
    // 传了空串 = 显式改回"不限"，跟新增时的语义保持一致
    fields.spicy = r.has ? r.value : 'any'
  }
  if (hasKey(payload, 'tags')) {
    const r = checkTags(payload.tags)
    if (!r.ok) return r
    // 传了 null 已在 ③ 拦掉；走到这里 has 一定是 true
    fields.tags = r.value
  }

  /* ⑤ 一个可改字段都没传 → 这次请求没有任何意义，直接拒 */
  if (Object.keys(fields).length === 0) {
    return fail(
      400,
      'INVALID_PATCH',
      `至少要传一个要改的字段：${PATCHABLE_FIELDS.join(' / ')}`
    )
  }

  return { ok: true, fields }
}

module.exports = {
  validateNewItem,
  validateItemPatch,
  charLength,
  NAME_MAX,
  PATCHABLE_FIELDS,
}
