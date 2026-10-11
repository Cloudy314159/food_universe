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

const { queryTable, insertRow } = require('./client.js')

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

module.exports = { listItems, createItem }
