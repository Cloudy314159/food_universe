'use strict'

/* 数据访问层 · history 表（推荐历史：抽过什么、什么时候抽的）
 * ═══════════════════════════════════════════════════════════════════
 * 依据：api-contract.md 第二节「表 2：history」。
 *
 * ⚠️ `item_id` **可能是 null** —— 那条对应的条目后来被删了
 *    （外键是 `ON DELETE SET NULL`，删条目时置空而不是连历史一起删）。
 *    所以前端显示历史必须用 `item_name` 名称快照，**不能靠 item_id 回查名称**。
 *    这是 Day 16 定表结构时就设计好的行为，不是异常。
 * ═══════════════════════════════════════════════════════════════════
 */

const { queryTable } = require('./client.js')

const TABLE = 'history'

const COLUMNS = 'id,item_id,item_name,drawn_at'

/**
 * 列出历史记录，**按时间倒序**（最新的在最上面，PRD J4）。
 * @param {number} limit 最多取几条
 * @returns {Promise<{rows: Array, total: number}>} 行数组 + **历史总条数**
 *
 * ⚠️ Day 24 修正（和 items 同一个问题）：`limit` 只限制"取几条"，
 *    `total` 要的是"一共几条"。以前接口层用 `rows.length` 顶替，
 *    默认只取 20 条时 `total` 永远是 20 —— 即使实际有 87 条历史。
 */
async function listHistory(limit) {
  return queryTable(
    TABLE,
    {
      select: COLUMNS,
      order: 'drawn_at.desc',
      limit: String(limit),
    },
    { withCount: true },
  )
}

module.exports = { listHistory }
