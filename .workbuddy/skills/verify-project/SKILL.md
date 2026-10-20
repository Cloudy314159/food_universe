---
name: verify-project
description: 「想吃啥」发布前检查。部署前后跑一遍，逐项输出 PASS/FAIL + 证据，任一项 FAIL 就不该发布。检查公网首屏与库内数据是否一致、三个 GET 接口、增改删闭环、代码与 Git 历史里的硬编码密钥、.env 忽略规则、核心表可读。当用户说「发布前检查」「跑一下 verify」「上线前自检」时使用。
agent_created: true
---

# verify-project · 发布前检查

## 为什么有这个东西

这个项目踩过的坑，没有一个是"代码写错了"，全是**部署/配置/数据层的静默失败**：

| 坑 | 长什么样 | 后果 |
|---|---|---|
| CDN 缓存 | 部署成功，页面还是旧版 | 以为发了，其实没发 |
| 默认域名拦截页 | `curl` 返回 200，但内容是「风险提醒」 | **检查脚本以为自己通过了** |
| 网关 `PathTransmission` 关掉 | 所有接口 404 | 前端全白 |
| 删除只删了本地 | 刷新那条又回来 | 用户以为删了 |
| 搜密钥没排除 deploy 配置 | 真 Key 被打进终端/对话 | 必须立刻轮换 |
| `.env.*` 规则 | `.env.example` 被静默挡掉，提交不上去 | 别人 clone 后不知道配什么 |
| 表名写错 | 只回 500，用户看到"服务器开小差" | 不知道是表没了 |

**所以这个 Skill 的立场是：没有证据 = 不算通过。**
拿不到浏览器就判 FAIL，不写"看起来正常"。

## 六项检查

| # | 检查项 | 执行命令 | 怎么算通过 |
|---|---|---|---|
| ① | 公网首页可访问且**展示真实数据** | `curl -w "%{http_code}" $SITE/` + 真浏览器读 `/共 (\d+) 个候选/` | HTTP 200 **且**页面候选数 == 接口 `total` |
| ② | GET 接口正常 | `curl $API/api/health`、`/api/items?limit=1`、`/api/history?limit=1` | 三个都 `ok:true` |
| ③ | 读写各一次且结果正确 | POST 建 → GET 读到 → PATCH 改 → DELETE → GET 确认消失 | 每一步都是预期值；**删完 GET 必须读不到** |
| ④ | 代码与 Git 历史无硬编码密钥 | 对 `git ls-files` 的文本文件 grep 密钥形态；`git log -G` 扫历史 | 当前 0 命中 + 历史 0 命中 |
| ⑤ | `.env` 被忽略、`.env.example` 存在 | `git check-ignore -v .env`；`ls .env.example`；`git ls-files \| grep '^\.env'` | 有忽略规则 + 示例文件里**没有真值** + 仓库里只有 `.env.example` |
| ⑥ | 数据库可连接、核心表存在 | `GET /api/items` 与 `GET /api/history` 能读出真实行 | 两个都 `ok:true` 且条数可读 |

### 几个刻意的设计

- **① 必须用真浏览器**：`cloudbaserc` 的默认域名有「风险提醒」拦截页，`curl` 拿到的是拦截页 HTML 却仍是 200。**只看状态码的检查脚本在这里会骗自己**。没有 `agent-browser` 时，这一项判 FAIL 并说明原因。
- **④ 只扫被 git 跟踪的文件**：`cloudbaserc.deploy.json` 里有真 Key，全文 grep 会把它打进终端 —— 2026-10-16 就是这么翻车的。用 `git ls-files` 天然排除它。
- **⑥ 不直连数据库**：验证"表存在"不需要读 `TCB_API_KEY`。发布检查不该接触凭据，走接口就够了。

## 输出

```
[1/6] 公网首页可访问且展示数据库真实数据
  [PASS] 首页 HTTP 200
         https://...
  [PASS] 接口侧条目总数 = 67（>0，说明库里有真实数据）
  [PASS] 首屏显示「共 67 个候选」，与接口 total 一致
         卡片实际渲染 68 个
```

每一项都是 `[PASS]` / `[FAIL]` + **具体数值**，没有"基本正常""应该没问题"。

结尾汇总：
```
结果：6 PASS / 0 FAIL  →  可以发布        （退出码 0）
结果：5 PASS / 1 FAIL  →  ❌ 不能发布      （退出码 1）
  未通过：
    · .env 没被忽略
```

## 文件结构

```
.workbuddy/skills/verify-project/
├── SKILL.md              本文件：检查项、判定标准、调用方法
└── scripts/
    └── verify.sh         唯一入口，六项检查全在里面
```

依赖：`curl`、`git`、Python（解析 JSON）、`agent-browser`（第 ① 项；缺了会 FAIL 而不是跳过）。

## 怎么用

**方式一 · 直接跑（推荐，输出最完整）**

```bash
bash .workbuddy/skills/verify-project/scripts/verify.sh
```

**方式二 · 对话里调用**

说「**跑一下发布前检查**」或「**verify-project**」，我会执行上面的脚本，把逐项结果贴出来。

**退出码**：`0` 全过 / `1` 有 FAIL / `2` 环境不对（不在仓库里）。

## 它自己也要被验证（不许虚报）

判断这个 Skill 好不好用，唯一方法是**故意弄坏一项，看它有没有报 FAIL**：

```bash
# 弄坏 ⑤：临时把 .env 从忽略规则里放出来
sed -i 's/^\.env$/# .env/' .gitignore
bash .workbuddy/skills/verify-project/scripts/verify.sh   # 应该 FAIL：.env 没被忽略
git checkout -- .gitignore                                 # 恢复
bash .workbuddy/skills/verify-project/scripts/verify.sh   # 应该回到全 PASS
```

同理可以验证其它项：

| 故意弄坏 | 应该 FAIL 的项 |
|---|---|
| 注释掉 `.gitignore` 里 `.env` | ⑤ |
| 删掉 `.env.example` | ⑤ |
| 往任意 `.js` 里塞一个 `eyJ...` 长串 | ④ |
| 把 `itemsRepository.js` 的 `TABLE` 改成 `items_typo` 并部署 | ⑥（`/api/items` 回 500） |

**如果弄坏了它还报 PASS，这个 Skill 就是坏的** —— 先修它，再用它。
