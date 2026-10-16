'use strict'

/* 数据访问层 · items 表（候选条目：一道菜，或一家店）
 * ═══════════════════════════════════════════════════════════════════
 * 「这张表长什么样」**只应该在这个文件里出现**：列名、排序规则、过滤条件。
 *
 * 上层（index.js 的 handler）只说"我要全部条目"、"给我加一条"，
 * 不需要知道背后是 `select id,name,… order by id`。
 * 以后表结构变了（加列、改排序、换表名），**只改这里**。
 *
 * 依据：仓库根目录 api-contract.md 第二节「表 1：items」。
 * ═══════════════════════════════════════════════════════════════════
 */

const { queryTable, insertRow, updateRow, deleteRow } = require('./client.js')

const TABLE = 'items'

/* 对外暴露的列。**读**和**写完回读**都走它 ——
   抽成常量是为了让两处的形状永远一致（契约里 items 的字段就是这 8 个）。 */
const COLUMNS = 'id,name,type,platform,spicy,tags,source,created_at'

/**
 * 列出候选条目（首页候选池、清单页都用它）。
 * @param {number} limit 最多取几条
 * @returns {Promise<Array>} 行数组
 */
async function listItems(limit) {
  return queryTable(TABLE, {
    select: COLUMNS,
    order: 'id',
    limit: String(limit),
  })
}

/**
 * 新增一条。
 * @param {{name:string,type:string,platform:string,spicy:string,tags:string[],source:string}} fields
 *        已经校验、规范化过的字段（由 lib/validate.js 产出）
 * @returns {Promise<object>} 插入后的那一行（`id` / `created_at` 由数据库生成）
 *
 * ⚠️ 重名会抛错，`err.pgCode === '23505'` —— **由调用方决定翻成 409 还是别的**。
 *    这里不判"该不该拒"，因为那是业务规则，不是数据访问的事。
 */
async function createItem(fields) {
  return insertRow(TABLE, fields, COLUMNS, 'name')
}

/**
 * 改一条（Day 22 新增）。
 * @param {string} id          改哪一条（主键）
 * @param {object} fields      要改的字段，**只放这次真要改的那几个** ——
 *                             没放的列在数据库里原地不动（部分更新）。
 *                             由 `lib/validate.js` 的 `validateItemPatch` 产出。
 * @returns {Promise<object|null>} 改完之后的那一行；**`null` = 这个 id 不存在**
 *
 * ⚠️ `null` 和"抛错"是两回事，调用方要分开处理：
 *    · `null`   → id 不存在      → 接口层该回 **404**
 *    · 抛 `23505` → 改的名字撞了别人 → 接口层该回 **409**
 *    （为什么"不存在"不是抛错：它是**正常的**查询结果，不是异常。）
 */
async function updateItem(id, fields) {
  return updateRow(TABLE, id, fields, COLUMNS)
}

/**
 * 删一条（Day 22 新增）。
 * @param {string} id 删哪一条（主键）
 * @returns {Promise<object|null>} 被删掉的那一行；**`null` = 这个 id 本来就不存在**
 *
 * ⚠️ 跟 `updateItem` 一样，`null` 是**正常结果**不是异常 ——
 *    "要删的东西不在"由接口层翻成 **404**，别在这一层抛错。
 *
 * ⚠️ 删条目会**连带影响 history 表**（外键 `ON DELETE SET NULL`）：
 *    那些历史记录的 `item_id` 会变成 `NULL`，但 `item_name` 快照原样保留 ——
 *    所以历史页照样显示得出"那天抽的是啥"（PRD J4，这是设计好的行为，不是数据坏了）。
 */
async function removeItem(id) {
  return deleteRow(TABLE, id, COLUMNS)
}

module.exports = { listItems, createItem, updateItem, removeItem }
