#!/usr/bin/env bash
# CD：image -> staging 门禁 -> prod 门禁 -> 失败回滚
#
# 这是一个 CLI/库项目，没有常驻服务，所以「部署」的语义是：
#   镜像打上环境 tag，并在该镜像里真跑一次生成 + 健康检查。
# 「回滚」就是把 tag 重新指向上一个 good 版本，再复检一次。
#
# 用法：
#   bash cd/deploy.sh --image=story-workflow:20260917235900            # 默认只到 staging
#   bash cd/deploy.sh --image=story-workflow:xxx --env=prod

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IMAGE=""
ENV="staging"
SIMULATE_PROD_FAILURE="false"
PROJECT="examples/input/synthetic-story.json"
TIMES=3
INTERVAL=1000

for arg in "$@"; do
  case "$arg" in
    --image=*) IMAGE="${arg#*=}" ;;
    --env=*) ENV="${arg#*=}" ;;
    --project=*) PROJECT="${arg#*=}" ;;
    --times=*) TIMES="${arg#*=}" ;;
    --interval=*) INTERVAL="${arg#*=}" ;;
    --simulate-prod-failure) SIMULATE_PROD_FAILURE="true" ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

if docker info > /dev/null 2>&1; then DOCKER="docker"; else DOCKER="sudo -n docker"; fi

VERSIONS="cd/versions.json"
STABLE_TAG="story-workflow:stable"

say() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { say "[PASS] $*"; }
fail() { say "[FAIL] $*"; exit 1; }

current_good() { node -e 'const d=require("./cd/versions.json");process.stdout.write(d.good||"")'; }
record() {
  node -e '
const fs=require("fs");
const [status,image]=process.argv.slice(1);
const d=JSON.parse(fs.readFileSync("cd/versions.json","utf8"));
if(status==="good"){d.good=image;} else {d.bad=image;}
d.history=(d.history||[]).concat([{status,image,at:new Date().toISOString()}]).slice(-20);
fs.writeFileSync("cd/versions.json",JSON.stringify(d,null,2)+"\n");
' "$1" "$2"
}

say "CD 启动 | 镜像=$IMAGE | 目标环境=$ENV"

# ---------- 0. 前置检查 ----------
if [ -z "$IMAGE" ]; then fail "必须指定 --image"; fi
if ! $DOCKER image inspect "$IMAGE" > /dev/null 2>&1; then fail "镜像不存在: $IMAGE"; fi
pass "镜像存在 $IMAGE"

PREV="$(current_good)"

# ---------- 1. staging 门禁 ----------
say "========== staging 门禁 开始 =========="
if node cd/health_gate.js --image="$IMAGE" --project="$PROJECT" --env=staging --times="$TIMES" --interval="$INTERVAL"; then
  pass "staging 门禁通过"
else
  fail "staging 门禁未通过 —— 到此为止，绝不进 prod"
fi

if [ "$ENV" != "prod" ]; then
  say "默认只到 staging。要进 prod 请显式加 --env=prod"
  say "========== CD 结束（staging） =========="
  exit 0
fi

# ---------- 2. prod：打 stable tag ----------
say "========== prod 发布开始 =========="
say "上一个 good 版本: ${PREV:-（无）}"
if $DOCKER tag "$IMAGE" "$STABLE_TAG"; then
  pass "已把 $IMAGE 标记为 $STABLE_TAG"
else
  fail "标记 stable 失败"
fi

# ---------- 3. prod 门禁 ----------
if [ "$SIMULATE_PROD_FAILURE" = "true" ]; then
  say "[DRILL] 演练开关已打开：跳过真实门禁，直接判定 prod 不健康"
  PROD_GATE_RC=1
else
  node cd/health_gate.js --image="$STABLE_TAG" --project="$PROJECT" --env=prod --times="$TIMES" --interval="$INTERVAL"
  PROD_GATE_RC=$?
fi

if [ "$PROD_GATE_RC" -eq 0 ]; then
  pass "prod 门禁通过"
else
  say "[WARN] prod 门禁未通过，准备回滚"
  if [ -n "$PREV" ] && $DOCKER image inspect "$PREV" > /dev/null 2>&1; then
    $DOCKER tag "$PREV" "$STABLE_TAG"
    say "已将 stable 指回上一个 good 版本: $PREV"
    record "bad" "$IMAGE"
    # 回滚后必须按基线复检，而不是拿刚才抬高过的阈值糊弄过去
    if node cd/health_gate.js --image="$STABLE_TAG" --project="$PROJECT" --env=prod-rollback-check --times="$TIMES" --interval="$INTERVAL"; then
      pass "回滚后复检通过"
      say "========== CD 结束（已回滚） =========="
      exit 1
    else
      fail "回滚后复检仍然不通过，需要人工介入"
    fi
  else
    fail "没有可用的上一版本，无法回滚，需要人工介入"
  fi
fi

record "good" "$IMAGE"
pass "已记录为 good 版本"
say "========== CD 结束（SUCCESS） =========="
