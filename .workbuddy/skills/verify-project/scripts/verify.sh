#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  「想吃啥」发布前检查 · verify.sh
# ─────────────────────────────────────────────────────────────────────
#  每个检查项都来自这个项目**真实踩过的坑**，不是通用模板：
#    ① 公网首页   —— 部署了但页面还是旧的（CDN）/ 默认域名拦截页骗过 curl
#    ② GET 接口   —— 网关 PathTransmission 关掉就只剩 404
#    ③ 读写闭环   —— 删了没真删，刷新又复活（Day 22 真 bug）
#    ④ 密钥        —— 搜密钥时忘排除 deploy 配置，把真 Key 打进对话（Day 23 真事故）
#    ⑤ 忽略规则   —— .env.* 会把 .env.example 一起挡掉，静默提交不上去（Day 23）
#    ⑥ 数据库     —— 表名写错只报 500，看不出来（Day 24 验证过）
#
#  用法：bash .workbuddy/skills/verify-project/scripts/verify.sh
#  退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 环境不满足（不是仓库/缺工具）
# ═══════════════════════════════════════════════════════════════════════
set -u

API="https://model-d5gisaem106ad6a18-1500042790.ap-shanghai.app.tcloudbase.com"
SITE="https://model-d5gisaem106ad6a18-1500042790.tcloudbaseapp.com"
export PATH="/c/Users/CLOUDY/.workbuddy/binaries/node/versions/22.22.2:$PATH"
PY="C:/Users/CLOUDY/.workbuddy/binaries/python/envs/default/Scripts/python.exe"

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "✗ 当前目录不是 git 仓库"; exit 2; }
cd "$ROOT" || exit 2

PASS=0; FAIL=0; FAILED=()
pass() { echo "  [PASS] $1"; [ -n "${2:-}" ] && echo "         $2"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $1"; [ -n "${2:-}" ] && echo "         $2"; FAIL=$((FAIL+1)); FAILED+=("$1"); }

jq_py() { "$PY" -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }

echo "═══════════════════════════════════════════════════════════════"
echo "  发布前检查 · verify-project"
echo "  仓库：$ROOT"
echo "  时间：$(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════════════════════"

# ───────────────────────────────────────────────────────────────────────
# ① 公网首页可访问，且首屏数字与数据库一致
#    ⚠️ 默认域名有「风险提醒」拦截页 —— curl 拿到的不是真页面，
#       所以必须用真浏览器读 DOM。拿不到浏览器就**判 FAIL**，不能猜。
# ───────────────────────────────────────────────────────────────────────
echo ""
echo "[1/6] 公网首页可访问且展示数据库真实数据"

CODE=$(curl -s -o /tmp/vp_home.html -w "%{http_code}" --max-time 20 "$SITE/" 2>/dev/null)
if [ "$CODE" = "200" ]; then pass "首页 HTTP 200" "$SITE/"; else fail "首页打不开" "HTTP ${CODE:-无响应}"; fi

# ⚠️ grep -c 在"0 匹配"时退出码是 1，写 `|| echo 0` 会得到 "0\n0"，
#    后面 `[ "$x" -eq 0 ]` 直接报 "integer expected"。只吞退出码，不追加输出。
IS_GATE=$(grep -c "风险提醒\|确定访问" /tmp/vp_home.html 2>/dev/null || true)
IS_GATE=${IS_GATE:-0}
if [ "$IS_GATE" -gt 0 ]; then
  echo "         ↑ curl 拿到的是「风险提醒」拦截页，改用真浏览器验证首屏"
fi

API_TOTAL=$(curl -s --max-time 20 "$API/api/items?limit=1000" | jq_py "print(d['data']['total'])" 2>/dev/null)
if [ -n "${API_TOTAL:-}" ] && [ "$API_TOTAL" -gt 0 ] 2>/dev/null; then
  pass "接口侧条目总数 = $API_TOTAL（>0，说明库里有真实数据）"
else
  fail "接口取不到条目数" "返回：$(curl -s --max-time 20 "$API/api/items?limit=1" | head -c 120)"
fi

if command -v agent-browser >/dev/null 2>&1; then
  agent-browser close --all >/dev/null 2>&1
  agent-browser open "$SITE/" >/dev/null 2>&1
  sleep 6
  T=$(agent-browser eval "document.title" 2>/dev/null | tr -d '"')
  if [ "$T" = "风险提醒" ]; then agent-browser click "button" >/dev/null 2>&1; sleep 8; fi

  PAGE=$(agent-browser eval "(function(){var m=document.body.innerText.match(/共\s*([0-9]+)\s*个候选/);return m?m[1]:'0'})()" 2>/dev/null | tr -d '"')
  CARDS=$(agent-browser eval "document.querySelectorAll('.food-card').length" 2>/dev/null | tr -d '"')

  if [ "${PAGE:-0}" -gt 0 ] 2>/dev/null && [ "${PAGE}" = "$API_TOTAL" ]; then
    pass "首屏显示「共 $PAGE 个候选」，与接口 total 一致" "卡片实际渲染 ${CARDS:-?} 个"
  else
    fail "首屏数字与接口不一致" "页面=$PAGE / 接口=$API_TOTAL（页面可能被 CDN 缓存成旧版）"
  fi
  agent-browser close >/dev/null 2>&1
else
  fail "无法验证首屏真实数据" "缺 agent-browser；只有 curl 拿不到真页面（拦截页），不能判 PASS"
fi

# ───────────────────────────────────────────────────────────────────────
# ② GET 接口
# ───────────────────────────────────────────────────────────────────────
echo ""
echo "[2/6] GET 接口正常"

for ep in "/api/health" "/api/items?limit=1" "/api/history?limit=1"; do
  BODY=$(curl -s --max-time 20 "$API$ep" 2>/dev/null)
  OK=$(echo "$BODY" | jq_py "print(d.get('ok'))")
  if [ "$OK" = "True" ]; then
    pass "GET $ep → ok:true" "$(echo "$BODY" | head -c 90)"
  else
    fail "GET $ep 失败" "$(echo "$BODY" | head -c 140)"
  fi
done

# ───────────────────────────────────────────────────────────────────────
# ③ 读写闭环：POST → GET 确认 → PATCH → GET 确认 → DELETE → GET 确认消失
#    这是 Day 22 那个「删了刷新又复活」的回归检查。
# ───────────────────────────────────────────────────────────────────────
echo ""
echo "[3/6] 读写接口闭环"

NAME="发布检查$(date +%s)"
CREATE=$(curl -s --max-time 25 -X POST "$API/api/items" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$NAME\",\"type\":\"dish\",\"platform\":\"mt\",\"spicy\":\"mild\",\"tags\":[]}" 2>/dev/null)
NEW_ID=$(echo "$CREATE" | jq_py "print(d['data']['item']['id'])")
if [ -n "${NEW_ID:-}" ]; then
  pass "POST 写入成功" "id=$NEW_ID  name=$NAME"
else
  fail "POST 写入失败" "$(echo "$CREATE" | head -c 140)"
fi

if [ -n "${NEW_ID:-}" ]; then
  AFTER=$(curl -s --max-time 20 "$API/api/items?limit=1000" | jq_py "print(any(x['id']=='$NEW_ID' for x in d['data']['items']))")
  [ "$AFTER" = "True" ] && pass "GET 能读到刚写的那条" || fail "GET 读不到刚写的那条" "数据没落库"

  PATCH=$(curl -s --max-time 25 -X PATCH "$API/api/items/$NEW_ID" -H "Content-Type: application/json" -d '{"spicy":"hot"}' 2>/dev/null)
  NEW_SPICY=$(echo "$PATCH" | jq_py "print(d['data']['item']['spicy'])")
  [ "$NEW_SPICY" = "hot" ] && pass "PATCH 改成 hot 成功" || fail "PATCH 失败" "$(echo "$PATCH" | head -c 140)"

  DEL=$(curl -s --max-time 25 -X DELETE "$API/api/items/$NEW_ID" 2>/dev/null)
  DEL_OK=$(echo "$DEL" | jq_py "print(d.get('ok'))")
  [ "$DEL_OK" = "True" ] && pass "DELETE 返回 ok:true" || fail "DELETE 失败" "$(echo "$DEL" | head -c 140)"

  GONE=$(curl -s --max-time 20 "$API/api/items?limit=1000" | jq_py "print(any(x['id']=='$NEW_ID' for x in d['data']['items']))")
  [ "$GONE" = "False" ] && pass "删除后 GET 里确实没有了（不是假删）" || fail "删除后 GET 仍能读到" "假删：刷新会复活"
fi

# ───────────────────────────────────────────────────────────────────────
# ④ 代码与 Git 历史里没有硬编码密钥
#    ⚠️ 扫描范围 = 被 git 跟踪的文件 —— 天然排除 cloudbaserc.deploy.json
#       （它含真 Key，全文 grep 会把 Key 打进终端，Day 23 就是这么翻的车）
# ───────────────────────────────────────────────────────────────────────
echo ""
echo "[4/6] 代码与 Git 历史里没有硬编码密钥"

FILES=$(git ls-files | grep -E '\.(js|jsx|json|md|css|html|sh|example|yml|yaml)$' || true)
SCANNED=0
[ -n "$FILES" ] && SCANNED=$(echo "$FILES" | wc -l)

HIT=0
for pat in 'eyJ[A-Za-z0-9_-]{20,}' 'AKID[A-Za-z0-9]{20,}' 'sk-[A-Za-z0-9]{20,}' '-----BEGIN [A-Z ]*PRIVATE KEY-----' 'postgres(ql)?://[^"'"'"' ]{10,}'; do
  N=$(echo "$FILES" | xargs grep -lE "$pat" 2>/dev/null | wc -l)
  if [ "$N" -gt 0 ]; then
    fail "当前代码命中密钥形态「$pat」" "$(echo "$FILES" | xargs grep -lE "$pat" 2>/dev/null | tr '\n' ' ')"
    HIT=$((HIT+1))
  fi
done
[ "$HIT" -eq 0 ] && pass "当前代码 0 命中" "扫描 $SCANNED 个被跟踪的文本文件（不含 cloudbaserc.deploy.json）"

HIST=0
for pat in 'eyJ[A-Za-z0-9_-]{20,}' 'AKID[A-Za-z0-9]{20,}' 'postgres(ql)?://[^"'"'"' ]{10,}'; do
  C=$(git log --all --oneline -G "$pat" 2>/dev/null | wc -l)
  if [ "$C" -gt 0 ]; then
    fail "Git 历史命中密钥形态「$pat」" "$(git log --all --oneline -G "$pat" 2>/dev/null | head -3 | tr '\n' ' ')"
    HIST=$((HIST+1))
  fi
done
[ "$HIST" -eq 0 ] && pass "Git 全部历史 0 命中"

# ───────────────────────────────────────────────────────────────────────
# ⑤ .gitignore 覆盖 .env，仓库里有 .env.example
# ───────────────────────────────────────────────────────────────────────
echo ""
echo "[5/6] 忽略规则与 .env.example"

if git check-ignore -q .env 2>/dev/null; then
  pass ".env 被忽略" "$(git check-ignore -v .env 2>/dev/null)"
else
  fail ".env 没被忽略" "git check-ignore .env 无输出 —— 一旦有 .env 就会被提交"
fi

if [ -f .env.example ]; then
  pass "存在 .env.example"
  # 同上：grep -c 无匹配时输出 0 但退出码 1，不能 `|| echo 0`
  BAD=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=.+' .env.example 2>/dev/null || true)
  BAD=${BAD:-0}
  [ "$BAD" -eq 0 ] && pass ".env.example 里没有真实值（全是空字段）" || fail ".env.example 有 $BAD 行填了值" "示例文件里不该有真值"
else
  fail "缺 .env.example" "别人不知道要配哪些变量"
fi

TRACKED_ENV=$(git ls-files | grep -E '^\.env' | tr '\n' ' ')
if [ "$TRACKED_ENV" = ".env.example " ]; then
  pass "仓库里只有 .env.example，没有 .env" "实际：$TRACKED_ENV"
else
  fail "仓库里有不该入库的 .env 类文件" "实际：$TRACKED_ENV"
fi

# ───────────────────────────────────────────────────────────────────────
# ⑥ 数据库可连接、核心表存在
#    用接口间接验证：items / history 都能读出真实行，说明表在、库通。
#    不直连库是为了**不读 Key 文件** —— 发布检查不该接触凭据。
# ───────────────────────────────────────────────────────────────────────
echo ""
echo "[6/6] 数据库可连接，核心表存在"

for pair in "items:/api/items?limit=1000:d['data']['total']" "history:/api/history?limit=20:len(d['data']['entries'])"; do
  TBL="${pair%%:*}"; REST="${pair#*:}"; EP="${REST%%:*}"; EXPR="${REST#*:}"
  BODY=$(curl -s --max-time 20 "$API$EP" 2>/dev/null)
  OK=$(echo "$BODY" | jq_py "print(d.get('ok'))")
  CNT=$(echo "$BODY" | jq_py "print($EXPR)")
  if [ "$OK" = "True" ] && [ -n "${CNT:-}" ]; then
    pass "表 $TBL 可读（$CNT 行）" "GET $EP"
  else
    fail "表 $TBL 读不出来" "表可能不存在 / 库连不上：$(echo "$BODY" | head -c 120)"
  fi
done

# ───────────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  echo "  结果：$PASS PASS / 0 FAIL  →  可以发布"
  echo "═══════════════════════════════════════════════════════════════"
  exit 0
else
  echo "  结果：$PASS PASS / $FAIL FAIL  →  ❌ 不能发布"
  echo "  未通过："
  for f in "${FAILED[@]}"; do echo "    · $f"; done
  echo "═══════════════════════════════════════════════════════════════"
  exit 1
fi
