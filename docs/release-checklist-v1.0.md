# 发布清单 ·「想吃啥」v1.0

> 发布日期：2026-10-20　｜　版本 tag：`v1.0`（提交 `dc6a1a3`）
> 线上地址：https://model-d5gisaem106ad6a18-1500042790.tcloudbaseapp.com/
> 接口地址：https://model-d5gisaem106ad6a18-1500042790.ap-shanghai.app.tcloudbase.com

---

## 一、这个版本发布什么

| 项 | 内容 |
|---|---|
| 版本号 | **v1.0**（`package.json` 与页脚 `.app-version` 同步显示） |
| 数据库 | 68 条：**56 道菜 + 12 家店** |
| 图片 | 55 张菜品专属图（`public/food/dish/`）+ 15 张通用兜底图 |
| 接口 | GET health / items / history，POST / PATCH / DELETE items |
| 配套 | 发布前检查 Skill（`verify-project`）、安全自查清单、本清单与回滚手册 |

**怎么确认线上是哪一版**：页面滚到底，页脚有一行小字 `v1.0`。
回退后这一行会消失 —— 演练就靠它判断。

---

## 二、发布前验证项（必须全过）

跑一条命令，六项检查一起做：

```bash
bash .workbuddy/skills/verify-project/scripts/verify.sh
```

| # | 检查项 | 通过标准 | 本次结果 |
|---|---|---|---|
| 1 | 公网首页展示真实数据 | 页面「共 N 个候选」== 接口 `total` | ✅ 68 == 68 |
| 2 | 三个 GET 接口 | 全部 `ok:true` | ✅ |
| 3 | 增改删闭环 | 写入→读到→改→删→**再读不到** | ✅ |
| 4 | 无硬编码密钥 | 当前代码 + Git 历史 0 命中 | ✅ |
| 5 | `.env` 忽略规则 | 被忽略 + 示例文件无真值 | ✅ |
| 6 | 数据库可连接 | items / history 都能读出真实行 | ✅ 68 / 8 |

**退出码必须是 0。** 不是 0 就不要发。

---

## 三、发布步骤

### 1. 构建（约 7 秒）

```bash
cd 桌面/工作区
./node_modules/.bin/vite build --outDir "C:/Users/CLOUDY/Desktop/发布存档/v1.0"
```

> ⚠️ **不要用 `npm run build`**：它会先删 `dist/`，在某些沙盒环境里会被拦下来，
> 而且产物落在仓库内、容易误提交。直接指定仓库外的存档目录，一步做完"构建 + 归档"。

### 2. 部署（约 25 秒）

```bash
npx -y -p @cloudbase/cli@latest tcb hosting deploy \
  "C:/Users/CLOUDY/Desktop/发布存档/v1.0" -e model-d5gisaem106ad6a18
```

### 3. 打版本标记

```bash
git tag -a v1.0 -m "v1.0：55 道菜一菜一图 + 发布前检查 Skill"
git push origin main
git push origin v1.0
```

### 4. 记录版本信息

把「版本号 / 提交 SHA / 构建时间 / 部署耗时」记进本文档的发布记录（见文末）。

---

## 四、发布后验证

### 1. 线上产物是不是新的（约 2 秒生效）

```bash
SITE="https://model-d5gisaem106ad6a18-1500042790.tcloudbaseapp.com"
curl -s -H "Cache-Control: no-cache" "$SITE/" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

**通过标准**：文件名 == 本地 `发布存档/v1.0/assets/` 里那个 `index-*.js`。
（Vite 构建带内容哈希，文件变了名字就变 —— 这是判断"线上跑的是哪一版"最硬的证据。）

### 2. 页面真的显示新版

真浏览器打开，滚到页脚，看到 `v1.0`。

> ⚠️ **必须用真浏览器**：默认域名有「风险提醒」拦截页，`curl` 拿到的不是网站，**但状态码照样 200**。

### 3. 再跑一遍完整检查

```bash
bash .workbuddy/skills/verify-project/scripts/verify.sh
```

**通过标准**：19 PASS / 0 FAIL，退出码 0。

---

## 五、代码与数据备份

### 代码

| 方式 | 命令 / 位置 | 说明 |
|---|---|---|
| Git tag | `v1.0` → `github.com/XingHo-VibeCoding/model` | 精确回到这一版：`git checkout v1.0` |
| 构建产物 | `C:/Users/CLOUDY/Desktop/发布存档/v1.0/`（**仓库外**） | 回退时直接重新部署它，不用重新构建 |
| 上一版产物 | `C:/Users/CLOUDY/Desktop/发布存档/v0.9/` | 本次演练用的回退目标 |

**为什么产物要存仓库外**：一次构建 27MB（含图片），放仓库里每发一版就多 27MB，
`.git` 会迅速膨胀；而且产物是**可以重建的东西**，不需要版本控制。

**存档命名规则**：`发布存档/<版本号>/`，一个版本一个目录，不覆盖。

### 数据

数据库在云上（CloudBase PostgreSQL），**本地没有任何副本**。发布前导出一次：

```bash
API="https://model-d5gisaem106ad6a18-1500042790.ap-shanghai.app.tcloudbase.com"
curl -s "$API/api/items?limit=1000"   > "C:/Users/CLOUDY/Desktop/发布存档/v1.0-data-items.json"
curl -s "$API/api/history?limit=20"   > "C:/Users/CLOUDY/Desktop/发布存档/v1.0-data-history.json"
```

> ⚠️ 这是**应用层快照**（接口返回的 JSON），不是数据库物理备份。
> 它能恢复"数据内容"，恢复不了表结构、索引、约束 —— 那些在 `db/schema.sql` 里。
> 真要整库备份得用控制台的导出功能，本版没做（见回滚手册"已知限制"）。

---

## 六、发布记录

| 项 | 值 |
|---|---|
| 版本 | v1.0 |
| 提交 | `dc6a1a3` |
| tag | `v1.0` |
| 构建耗时 | 7 秒 |
| 部署耗时 | 24 秒 |
| 发布后检查 | 19 PASS / 0 FAIL（退出码 0） |
| 线上产物哈希 | `index-CHT_IKVF.js` |
| 发布人 | git（代执行） |
| 发布时间 | 2026-10-20 20:47–20:50 |

---

## 七、下次发布要注意

1. **改版本号**：`package.json` 和页脚 `.app-version` 两处都要改，别只改一处。
2. **先存档再部署**：产物先进 `发布存档/<版本>/`，再部署那个目录 —— 顺序反了就没有可回退的基线。
3. **检查脚本退出码不是 0 就别发**。它报 FAIL 说明有真问题，不是误报（这个脚本被"故意弄坏"验过）。
4. **发完等 2 秒再验**：本次实测线上 2 秒内就切到新产物，但如果 CDN 抽风，最多等 1–2 分钟。
