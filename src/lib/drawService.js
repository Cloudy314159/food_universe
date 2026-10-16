/* 取下一个结果 —— 数据层与界面之间的那一层。

   ⚠️ 这个函数的签名是照着"将来要接真实 API"设计的：**异步、可取消、可失败**。
      而现在它的内部只是本地计算（微秒级），所以真实运行时「加载中」短到看不见。

      这是**故意的**，不是偷懒 —— PRD 的 B1 要求点「换一个」≤1 秒，
      如果为了"让加载中看得见"而人为加延迟，等于自己违反自己的验收标准。

   那「加载中」和「切换失败」怎么验收？留了两个人工开关
   （地址栏查询参数，跟页面级的 `?demo=` 是同一套写法）
   —— ⚠️ 这两个管的是**操作级**状态（「换一个」那一下）；
      页面级的整页骨架屏 / 错误页由 `?demo=` + 页脚的「状态演示」开关管，两层别混：

     ?slow=1   延迟 900ms 再返回   → 能看见「加载中」
     ?fail=1   直接抛错            → 能看见「切换失败」

   这两个开关的意义：现在数据在本地，**真实的失败路径不存在**
   （PRD §7.2 明确本期不接平台数据）。但 UI 和状态机必须先存在、必须被验过，
   否则第 3 周接上 API 那天，才发现那两个状态的样式和行为全是错的。

   第 3 周要改的只有这一个文件里的一行：
   把下面的本地取数换成真实请求。状态机、界面、测试步骤全都不用动。 */

import { drawNext } from './bag.js'

/* 人工开关下的延迟时长。默认路径是 0 —— 真实运行时几乎立刻完成。 */
export const SLOW_DELAY_MS = 900

function readFlag(name) {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get(name) === '1'
}

/* 可取消的等待：如果中途被 abort，立刻 reject。
   这样连点多次时，被取消的那几次不会继续往下走。

   ⚠️ 两条容易漏的路径（Day 11 的机械测试揪出来的）：
   ① 进来时 signal 就已经被取消了 → 要立刻拒绝
   ② 不需要等待（ms=0）时，也要让出一次微任务、再检查一次取消状态
   两条都是为了跟真实 fetch 的行为对齐 —— 真实的 fetch 一旦被 abort 就立刻 reject，
   如果本地版本在被取消时还会返回结果，那第 3 周换成真请求时行为就变了。 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消', 'AbortError'))
      return
    }
    if (!ms || ms <= 0) {
      queueMicrotask(() => {
        if (signal?.aborted) reject(new DOMException('已取消', 'AbortError'))
        else resolve()
      })
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('已取消', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 取下一个结果。
 *
 * @param {object}      p
 * @param {object}      p.bag           上一轮留下的洗牌袋（首次为 null）
 * @param {Array}       p.pool          当前候选
 * @param {string|null} p.lastResultId  上一次结果的 id，用于"跨轮不重复"的边界衔接
 * @param {AbortSignal} [p.signal]      用于取消（连点时取消掉前一次）
 * @returns {Promise<{ id: string, bag: object }>}
 * @throws {Error} 取数失败时抛出（人工开关 ?fail=1 可触发）
 */
export async function fetchNextResult({ bag, pool, lastResultId, signal }) {
  await delay(readFlag('slow') ? SLOW_DELAY_MS : 0, signal)

  if (readFlag('fail')) {
    /* 人工开关 `?fail=1` 模拟出来的失败。
       ⚠️ Day 23：给它带上 `code = 'NETWORK'` —— 让下面 describeError 能按码识别，
          而不是靠"消息里有没有'网络'两个字"。 */
    const e = new Error('连不上服务器，检查一下网络。')
    e.code = 'NETWORK'
    throw e
  }

  return drawNext(bag, pool, lastResultId)
}

/* 界面上要显示的失败原因 —— **"哪种错给哪句话"的唯一出口**。
   ─────────────────────────────────────────────────────────────────────
   ⚠️ Day 23 改过判断依据：以前是**看消息里有没有"网络"两个字**
      （`msg.includes('网络')`）—— 那是"靠文案判类型"：
      哪天文案改一个字，这个分支就**静默失效**，用户拿到的是不相关的话。
      而且那时它只认识"网络"一种错，其余全糊成"切换失败"。

   现在按 `err.code` 判 —— code 是前后端约定的**契约**（写在 api-contract.md 里），
   比文案稳定得多。三类错各给各的话：

     · 输入错（INVALID_* / DUPLICATE_NAME / NOT_FOUND）
       → 服务端已经写了中文人话（"名称长度需要在 1–20 字之间"这种），直接用它的
     · 网络错（NETWORK / TIMEOUT）
       → 明确告诉用户"这是网络的事，不是你的操作问题"，且要能重试
     · 服务端错（INTERNAL_ERROR / BAD_RESPONSE）
       → 说人话兜底，**不暴露任何技术细节**（服务端那边也不会再透技术细节过来）

   兜底用 `msg`：契约规定服务端的 message 一律是中文人话，
   所以"不认识的 code + 有消息"时，它给的话仍然比我们编的准。

   ⚠️ 以后后端加新错误码，**优先在这里加一条映射**，别让它掉进兜底。 */
export function describeError(err) {
  if (!err) return '切换失败，请再试一次。'

  const code = String(err.code || '')
  const msg = String(err.message || '')

  // ① 网络错：再分"完全没连上"和"连上了但太久没回应" —— 用户能做的事不一样
  if (code === 'NETWORK') return '连不上服务器，检查一下网络再试。'
  if (code === 'TIMEOUT') return '服务器响应有点慢，等会儿再试一次。'

  // ② 服务端错：说人话，不带技术细节
  if (code === 'INTERNAL_ERROR' || code === 'BAD_RESPONSE') {
    return '服务器开小差了，稍后再试一次。'
  }

  // ③ 输入错：服务端给的就是中文人话，直接用它
  if (code.startsWith('INVALID_') || code === 'DUPLICATE_NAME' || code === 'NOT_FOUND') {
    return msg || '这次操作没成功，换个方式再试。'
  }

  // 兜底（含"不认识的 code"和"联调时后端直接抛的错"）
  return msg || '切换失败，请再试一次。'
}
