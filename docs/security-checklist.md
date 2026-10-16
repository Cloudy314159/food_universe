# 安全自查清单（Day 23 建立）

> **这份文件是给"不信任我的人"看的** —— 每一项都带**可执行的验证方法**，
> 照着跑一遍就知道是真是假，不用听我说。
>
> 命令都在**仓库根目录**执行（Windows 用 Git Bash）。
> ⚠️ 搜索类命令一律 `-l`（只列文件名）或 `-c`（只数条数）——
> **绝不用会把匹配内容打出来的写法**。原因见下面第 1 条。

---

## 一、密钥与凭据

### 1. 仓库里（前端 + 后端源码）没有真实密钥

```bash
# 白名单指定路径搜，别搜整个根目录
grep -rIl -E "tcb_api_key|api_?key|secret|password|bearer |akid|accesskey|private_?key" \
  --include="*.js" --include="*.md" --include="*.json" \
  src cloudfunctions *.md *.json 2>/dev/null | grep -v node_modules
```

**期望：0 命中。**

> 🔴 **为什么强调"白名单指定路径"**：仓库根目录里**确实躺着**一个含真 Key 的文件
> （`cloudbaserc.deploy.json`，被 .gitignore 挡着、只在本机存在）。
> 如果图省事对根目录做无差别搜索，**搜索这个动作本身就会把密钥打印到屏幕上** ——
> 2026-10-16 我就这么干过一次，把 Key 打进了对话记录，导致那把 Key 必须作废重建。
> **教训：黑名单（--exclude）漏一个就出事；白名单（只搜 src/ 等）不会。**

### 2. 敏感文件不在 git 里

```bash
git ls-files | grep -iE "\.env|deploy\.json|secret|credential|\.pem|\.key"
```

**期望：空。**（当前状态：空 ✓）

### 3. 敏感文件即使在本机，也不会被误提交

```bash
git check-ignore -v .env .env.development.local cloudbaserc.deploy.json
git status --short | grep -iE "\.env|deploy\.json"      # 期望：什么都搜不到
```

**期望**：前一条对三个文件都有输出（说明被规则命中）；后一条为空。

### 4. `.env.example` 能入库（否则新人 clone 下来不知道该配什么）

```bash
git status --short .env.example
```

**期望**：显示 `?? .env.example`。
⚠️ 如果**什么都不显示**，说明它被 `.gitignore` 里的 `.env.*` 规则误挡了 ——
去检查那一行下面有没有 `!.env.example`（取反放行）。

### 5. Git 历史里从没提交过真实密钥

```bash
git log --all --oneline -S "TCB_API_KEY"
git log --all --diff-filter=A --name-only --pretty=format: | grep -iE "\.env|deploy\.json" | sort -u
```

**期望**：第一条列出的提交都是"引用变量名"的代码变更（如
`const apiKey = process.env.TCB_API_KEY`），**不是值**；第二条为空。

⚠️ **别加 `-p`** —— 那会把历史 diff 内容整个打出来，可能带出密钥。

### 6. 凭据轮换记录

| 日期 | 哪一把 | 为什么换 | 处理 |
|---|---|---|---|
| 2026-10-16 | CloudBase 服务端 API Key（`TCB_API_KEY`） | 安全审计时**被误打印进对话记录** | ✅ **已作废重建**：旧 `pgn7cSU4…`（`chisha-server`）已删除，新 `YD7nkzbg…`（`chisha-server-20261016`）已上线并验证 |

**轮换流程（顺序不能反，否则线上接口会挂）**：

1. **新建**一把 API Key（新旧可并存）—— 控制台能建，但 **CLI 更快，见下**
2. 把新 Key 填进本地 `cloudbaserc.deploy.json`（**不要贴进任何对话/Issue/提交**）
3. `npx -y -p @cloudbase/cli@latest tcb fn deploy api --config-file cloudbaserc.deploy.json --force`
4. 验证：`curl <公网>/api/items` 能正常返回（读 + 写各验一次更稳）
5. **确认第 4 步通过后**，才删掉旧 Key

**CLI 版（2026-10-16 实测跑通，全程不碰控制台）**：

```bash
E=model-d5gisaem106ad6a18

# 列出现有的（返回的 Key 值本身是掩码，可以放心看）
npx -y -p @cloudbase/cli@latest tcb env apikey list -e $E
# 新建（🔴 输出里是**明文** Key，必须重定向！）
npx -y -p @cloudbase/cli@latest tcb env apikey create <名字> -e $E --json > /tmp/newkey.json
# 作废旧的
npx -y -p @cloudbase/cli@latest tcb env apikey delete --key-id <旧KeyId> -e $E --yes
```

> 🔴 **`create` 的输出是明文 Key** —— 直接跑，它就进了你的终端历史 / 对话记录 / 日志，
> 等于刚建好又泄露一次。**必须 `> 文件` 重定向**，然后交给脚本处理。
> 同理：读 `cloudbaserc.deploy.json` **不要用编辑器打开或 `cat`**，用下面的"遮蔽查看"方式。

**配套两个小脚本**（本次实际用的，放在仓库外，可复用）：

- `inspect_json.py <文件>` —— 打印 JSON 结构，但**任何超过 24 字符的字符串一律遮蔽**
  （只显示长度 + 前 4 个字符）。用来安全地确认"哪个字段是那个 Key"，而不是把它打出来。
- `rotate_key.py <新Key文件> <deploy配置>` —— 读新 Key → 替换 `functions[0].envVariables.TCB_API_KEY`
  → 写回 → **回读复核**，只输出**新旧 Key 的 sha256 指纹**（前 10 位），全程零明文。
  改前先备份，且备份**落在仓库外**（`.gitignore` 里那条 `cloudbaserc.deploy.json` 是**精确名**规则，
  加个 `.bak` 后缀就不匹配了 → 留在仓库里会被 `git status` 看见，有误提交风险）。

**用完立刻清理**：`create` 那个中间文件里有生效中的明文 Key，
处理完马上删（`os.remove`，Windows 上 `rm` 可能被拦）。

> **为什么"作废"不只是"从代码里删掉"**：Key 一旦离开过你的机器（贴进聊天、提交进仓库、
> 发给别人），它就已经算泄漏了。删代码不会让它失效 —— 拿到它的人照样能读写你的数据库。
> **唯一有效的动作是让它在服务端失效。**

---

## 二、忽略规则（.gitignore）

### 7. 每条规则都和现实一致

| 规则 | 挡什么 | 状态 |
|---|---|---|
| `.env` / `.env.*` | 真实的环境变量文件（可能含密码、Key） | ✓ |
| `!.env.example` | **放行**示例文件（里面一个真值都没有） | ✓ |
| `cloudbaserc.deploy.json` | 带 API Key 的部署配置 | ✓ |
| `node_modules/` | 依赖（体积大、能重装） | ✓ |
| `dist/` | 构建产物（能重建） | ✓ |
| `cloudfunctions/api/package-lock.json` | 早期 `pg` 直连时代的残留（现在云函数零依赖） | ✓ |
| ~~`package-lock.json`~~ | **故意不忽略** —— 它是"该装哪些版本"的唯一记录，必须入库 | 已修正 |

### 8. 规则本身有没有"顺手挡住该入库的文件"

```bash
# 新增一个文件后，看 git 认不认它
git status --short
```

**判断标准**：你**知道**自己新建了某个文件，而 `git status` 里**看不到**它 → 规则误伤，
去 `.gitignore` 里找是哪条匹配了它。

> 今天真踩了一次：`.env.*` 把 `.env.example` 一起挡了。这种错误是**静默**的 ——
> 文件不报错、命令不报错，只是永远提交不上去，等到别人 clone 下来发现"少了个文件"才暴露。

---

## 三、错误提示（三类统一中文）

| 类型 | 由谁产生 | 现在的样子 | 怎么验 |
|---|---|---|---|
| **输入错** | 后端 `lib/validate.js` | `400` + 中文人话，且说清"错在哪、怎么改" | 见下面命令 |
| **网络错** | 前端 `src/lib/api.js` | 中文 + 给下一步动作 | 断网试，或看源码里的文案常量 |
| **服务端错** | 后端 `index.js` 最外层兜底 | **一句话，零技术细节** | 本地起服务即可复现 |

### 9. 输入错的具体验证

```bash
API=https://model-d5gisaem106ad6a18-1500042790.ap-shanghai.app.tcloudbase.com

# 名称为空 → 应该看到「名称不能为空」
curl -s -X POST "$API/api/items" -H "Content-Type: application/json" \
  -d '{"name":"","type":"dish","platform":"mt"}'

# 辣度非法 → 应该看到「辣度只能是 none / mild / medium / hot / any」
curl -s -X PATCH "$API/api/items/b01" -H "Content-Type: application/json" -d '{"spicy":"veryhot"}'

# 删不存在的 id → 应该看到「没有找到 id 为「…」的条目，它可能已经被删了」
curl -s -X DELETE "$API/api/items/__nope__"
```

**判断标准**：`message` 字段是**中文**，且**用户照着能改**（不是"参数错误"这种没信息量的话）。

### 10. 服务端错：技术细节只进日志，不进响应

```bash
# 本地起服务（本地没配 TCB_API_KEY，正好触发 500 兜底）
node cloudfunctions/api/index.js
# 另开一个窗口
curl -s http://127.0.0.1:9000/api/items
```

**期望**：
- **响应**：`{"ok":false,"data":null,"error":{"code":"INTERNAL_ERROR","message":"服务器开小差了，稍后再试一次"}}`
- **服务端日志**：`[api] 处理失败 {"code":"NO_API_KEY","detail":"没有配置 TCB_API_KEY（…）"}` + 完整堆栈

**判断标准**：响应里**看不到**表名、HTTP 状态码、英文、数据库原始响应体；
这些只出现在日志里。

```bash
# 代码层再确认一眼（这两条期望相反）
grep -n "服务端出错" cloudfunctions/api/index.js      # 期望：搜不到（那是旧写法）
grep -n "服务器开小差了" cloudfunctions/api/index.js   # 期望：搜得到（现在的写法）
```

### 11. 「未注册路径」的 404 是网关给的，不归我们管

```bash
curl -s "$API/api/nothing"
```

**现状**：返回网关的英文提示
（`{"code":"INVALID_PATH","message":"Invalid path. For more information, please refer to …"}`）。

**判断：不影响用户。** 前端只会请求已注册的路径（`/api/items`、`/api/items/:id`、`/api/history`），
用户界面上永远不会出现这条英文。记在这里，是为了以后有人做审计时**别把它当成我们的裸报错**
（我们的函数 404 是中文的，见第 9 条）。

---

## 四、还没做的（诚实标注）

- **余力加练：请求日志**（时间 / 路径 / 结果）—— 未做
- ~~凭据轮换的收尾（部署新 Key + 删旧 Key）~~ —— ✅ **2026-10-16 完成**
  （新 Key 上线、旧 Key 作废、读写接口双向回归通过、中间文件已清理）

---

*建立于 2026-10-16（Day 23）。以后每次动到密钥、.env、错误处理，回来跑一遍上面的命令。*
