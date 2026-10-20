# 发布前检查（Day 25 · verify-project）

> **这份文档说明的是一个能自动跑的检查，不是一份靠人眼看的清单。**
> 人工清单的问题在于：人会把"看起来正常"当成正常。
> 这里的每一项都要求**给出具体数值**，拿不到数值就判 FAIL。
>
> 命令都在**仓库根目录**执行（Windows 用 Git Bash）。
> 脚本本身在 `.workbuddy/skills/verify-project/`，共 228 行。

先定义两个地址，下文命令直接用变量：

```bash
API="https://model-d5gisaem106ad6a18-1500042790.ap-shanghai.app.tcloudbase.com"
SITE="https://model-d5gisaem106ad6a18-1500042790.tcloudbaseapp.com"
```

---

## 一、为什么要有它

这个项目上线后出的问题，**没有一个是因为代码写错了**。全部是部署、配置、数据层的静默失败：

| 出过的事 | 表面看起来 | 实际 |
|---|---|---|
| CDN 缓存 | 部署命令成功 | 用户打开还是旧版 |
| 默认域名的「风险提醒」拦截页 | `curl` 返回 **200** | 拿到的根本不是网站，是拦截页 |
| 网关 `PathTransmission` 关掉 | 前端不报错 | 所有接口 404 |
| 删除只删了 localStorage | 界面立刻消失 | 刷新那条又回来了 |
| 搜密钥没排除部署配置 | 想在"自查" | **把真 Key 打进了对话，那把 Key 只能作废重建** |
| `.gitignore` 里的 `.env.*` | 提交成功 | `.env.example` 被静默挡住，别人 clone 后不知道配什么 |
| 表名写错（`items` → `items_typo`） | 用户看到"服务器开小差了" | 真实原因是表不存在，没人知道 |

共同点：**都没有报错**。

所以这个 Skill 的立场只有一条：**没有证据 = 不算通过。**

---

## 二、六项检查

脚本每一项都输出 `[PASS]` / `[FAIL]` + 证据行。下面是判定标准和**失败了该去哪查**。

### ① 公网首页可访问，且展示的是数据库真实数据

```bash
curl -s -o /tmp/vp_home.html -w "%{http_code}" --max-time 20 "$SITE/"
```

**怎么算通过**：两个条件同时成立

1. HTTP `200`
2. 真浏览器读到的「共 N 个候选」**等于** `GET /api/items` 的 `data.total`

**为什么必须用浏览器**：默认域名有「风险提醒」拦截页，`curl` 拿到的是拦截页 HTML，**状态码照样是 200**。只看状态码的检查脚本会在这里骗自己。

没有 `agent-browser` 时，这一项**判 FAIL**，不降级为"跳过"。

**FAIL 了先看**：是不是刚部署完 CDN 还没刷新（Ctrl+F5 试试）；再确认页面数字和接口数字差多少 —— 差一截通常是缓存了旧版前端。

---

### ② 三个 GET 接口

```bash
curl -s "$API/api/health"
curl -s "$API/api/items?limit=1"
curl -s "$API/api/history?limit=1"
```

**怎么算通过**：三个响应的 `ok` 都是 `true`。

**FAIL 了先看**：网关路由（`PathTransmission` 必须为 1）、云函数是否部署成功、环境变量 `TCB_API_KEY` 在不在。

---

### ③ 增改删闭环

```
POST 建一条 → GET 读到 → PATCH 改 → GET 确认改了 → DELETE → GET 必须读不到
```

**怎么算通过**：每一步都是预期值，**最后一步必须是"读不到"**。

**为什么单独查这一项**：这个项目真出过"删了刷新又复活"的 bug —— 前端只删本地、云端没删。接口返回 `200` 不代表数据真的没了，只有**再查一遍**能证明。

脚本用的是一条名字带时间戳的临时数据（`发布检查<秒级时间戳>`），跑完即删，不留脏数据。

**FAIL 了先看**：删除接口是不是只删了本地；`items` 表的唯一约束是否挡住写入；名称是否重复（409）。

---

### ④ 代码与 Git 历史里没有硬编码密钥

**扫描范围 = `git ls-files` 列出来的文本文件**，不是整个目录。

```bash
FILES=$(git ls-files | grep -E '\.(js|jsx|json|md|css|html|sh|example|yml|yaml)$')
echo "$FILES" | xargs grep -lE 'eyJ[A-Za-z0-9_-]{20,}'          # JWT
echo "$FILES" | xargs grep -lE 'AKID[A-Za-z0-9]{20,}'           # 腾讯云 SecretId
echo "$FILES" | xargs grep -lE 'sk-[A-Za-z0-9]{20,}'            # OpenAI 风格
echo "$FILES" | xargs grep -lE 'BEGIN [A-Z ]*PRIVATE KEY'       # 私钥
git log --all --oneline -G 'eyJ[A-Za-z0-9_-]{20,}'              # 历史
```

**怎么算通过**：当前 0 命中 **且** 历史 0 命中。

> 🔴 **为什么不扫整个目录**：仓库根目录里躺着 `cloudbaserc.deploy.json`，里面有真 Key。
> 对它做无差别 grep，**搜索这个动作本身就会把 Key 打印到屏幕上** —— 2026-10-16 发生过一次，
> 直接导致那把 Key 作废重建。
> 用 `git ls-files` 的好处是：它天然只包含被跟踪的文件，那个配置永远不在里面。

**命中了怎么办**：不是"删掉那行代码"就完事。**先到平台作废这把 Key、重新生成**，再清理代码 —— 只清理代码等于钥匙丢了但没换锁。

---

### ⑤ `.env` 被忽略，且仓库里有 `.env.example`

```bash
git check-ignore -v .env                    # 期望：有输出（命中某条规则）
ls .env.example                             # 期望：存在
git ls-files | grep -E '^\.env'             # 期望：只有 .env.example
grep -cE '^[A-Za-z_][A-Za-z0-9_]*=.+' .env.example   # 期望：0（示例里没有真值）
```

**怎么算通过**：四条全部符合。

> ⚠️ **一个静默坑**：`.gitignore` 里的 `.env.*` 会把 `.env.example` **一起挡掉**，
> 而且不报错 —— 只是永远提交不上去。所以必须有 `!.env.example` 这条取反规则。

**FAIL 了先看**：`.gitignore` 里有没有 `.env` 规则；有没有 `!.env.example`；示例文件里是不是被填了真值。

---

### ⑥ 数据库可连接，核心表存在

```bash
curl -s "$API/api/items?limit=1000"    # 要能读出真实行
curl -s "$API/api/history?limit=20"
```

**怎么算通过**：两个接口都 `ok:true`，且能读出条数。

**为什么走接口而不是直连库**：验证"表存在"不需要 `TCB_API_KEY`。**发布检查不该接触凭据** —— 少一个环节就少一处泄露可能。

**FAIL 了先看**：表名是不是被改错了（`items` → `items_typo`）、库有没有欠费停机、Key 是否被轮换过。

---

## 三、输出长什么样

```
═══════════════════════════════════════════════════════════════
  发布前检查 · verify-project
  仓库：C:/Users/CLOUDY/Desktop/工作区
  时间：2026-10-20 20:11:09
═══════════════════════════════════════════════════════════════

[1/6] 公网首页可访问且展示数据库真实数据
  [PASS] 首页 HTTP 200
  [PASS] 接口侧条目总数 = 68（>0，说明库里有真实数据）
  [PASS] 首屏显示「共 68 个候选」，与接口 total 一致
         卡片实际渲染 68 个
...
[5/6] 忽略规则与 .env.example
  [FAIL] .env 没被忽略
         git check-ignore .env 无输出 —— 一旦有 .env 就会被提交
...
═══════════════════════════════════════════════════════════════
  结果：18 PASS / 1 FAIL  →  ❌ 不能发布
  未通过：
    · .env 没被忽略
═══════════════════════════════════════════════════════════════
```

**退出码**：`0` 全过 / `1` 有 FAIL / `2` 环境不对（不在仓库里）。

可以直接接进流水线 —— 不看输出，只看退出码也能判断。

---

## 四、怎么跑

```bash
# 仓库根目录
bash .workbuddy/skills/verify-project/scripts/verify.sh
```

在对话里说「**跑一下发布前检查**」或「**verify-project**」也可以。

依赖：`curl`、`git`、Python（解析 JSON）、`agent-browser`（第 ① 项）。
缺 `agent-browser` 时第 ① 项会 FAIL，而不是假装通过。

---

## 五、它自己是怎么被验证的

**一个不会失败的检查，等于没有检查。** 所以它必须被"故意弄坏"验一次。

**做法**：注释掉 `.gitignore` 里的 `.env` 规则。

```bash
sed -i 's/^\.env$/# .env/' .gitignore
git check-ignore -v .env          # 无输出 —— 确实不再被忽略了
bash .workbuddy/skills/verify-project/scripts/verify.sh
git checkout -- .gitignore        # 恢复
bash .workbuddy/skills/verify-project/scripts/verify.sh
```

**实测结果（2026-10-20）**：

| 状态 | 输出 | 退出码 |
|---|---|---|
| 弄坏后 | `[FAIL] .env 没被忽略` · **18 PASS / 1 FAIL** · ❌ 不能发布 | **1** |
| 恢复后 | **19 PASS / 0 FAIL** · 可以发布 | **0** |

证据：`2026-09-18-16-54-01/_day25/verify-evidence.png`（三步过程在一张图里）。

### 还可以这样验其它项

| 故意弄坏 | 应该 FAIL 的项 |
|---|---|
| 注释掉 `.gitignore` 里的 `.env` | ⑤ |
| 删掉 `.env.example` | ⑤ |
| 往任意 `.js` 里塞一个 `eyJ...` 长串 | ④ |
| `itemsRepository.js` 的 `TABLE` 改成 `items_typo` 并部署 | ⑥ |

**弄坏了它还报 PASS，说明这个 Skill 本身是坏的** —— 先修它，再用它。

---

## 六、已知局限（诚实标注）

1. **只验证"数据能通"，不验证"界面好不好看"**。样式错位、字体、间距这类问题它查不出来，那是人的事。
2. **第 ① 项依赖 `agent-browser`**。在没有浏览器的机器上（比如纯 CI）这一项会一直 FAIL —— 这是有意的：宁可报错，不要假装通过。
3. **密钥扫描是"形态匹配"**，不认识所有格式。如果密钥长得不像 `eyJ`/`AKID`/`sk-`/`BEGIN PRIVATE KEY`，可能漏掉。
4. **不检查性能**。首屏多大、几秒能开，不在这六项里。
5. **没做成自动化流水线**（Day 25 明确不做）。目前是手动触发。

---

## 七、想加一项检查时

1. 先在 `verify.sh` 里加一段，**必须有明确的数值判断**（不许写"看起来正常"）；
2. 给它编号（现在的顺序是 ①–⑥，加新项记得改 `[n/6]` 的分母）；
3. 用"故意弄坏"验它一次 —— **报不出 FAIL 的检查不要留着**；
4. 同步更新本文件和 `SKILL.md` 里的检查表。

---

_建立于 2026-10-20（Day 25）。脚本 228 行，六项检查，19 条断言。_
