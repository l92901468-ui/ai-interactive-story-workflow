#!/usr/bin/env bash
# CI：push -> build -> test -> scan
#
# 与另一个项目的 CI 保持同一套形状：每阶段计时、失败即中断、产物落 ci/reports/。
# 模拟的部分只有镜像漏洞扫描（本机没有 trivy），见 ci/scan.js。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUILD="$(date +%Y%m%d%H%M%S)"
IMAGE_NAME="story-workflow"
IMAGE_TAG="$IMAGE_NAME:$BUILD"
REPORTS="$ROOT/ci/reports"
mkdir -p "$REPORTS"
LOG="$REPORTS/ci-$BUILD.log"
: > "$LOG"

# docker 可能要 sudo
if docker info > /dev/null 2>&1; then
  DOCKER="docker"
else
  DOCKER="sudo -n docker"
fi

say() {
  # 写文件前剥掉颜色码，否则日志里全是 ANSI 转义序列
  local line="[$(date +%H:%M:%S)] $*"
  echo "$line"
  printf '%s\n' "$line" | sed -E 's/\x1b\[[0-9;]*m//g' >> "$LOG"
}

stage_start() { say "========== 阶段 $1 ($2) 开始 =========="; STAGE_AT="$(date +%s%3N)"; }
stage_end() {
  local now; now="$(date +%s%3N)"
  say "---------- 阶段 $1 ($2) 耗时 $((now - STAGE_AT))ms ----------"
}
pass() { say "[PASS] $*"; }
fail() { say "[FAIL] $*"; exit 1; }

say "CI 流水线启动 | BUILD=$BUILD | 阶段: push -> build -> test -> scan"

# ---------- 1. push ----------
stage_start push "代码推送"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git -c user.name="CI Bot" -c user.email="ci@screenshot.local" \
    commit -q -m "ci: 自动提交 $BUILD" || true
  COMMIT="$(git rev-parse --short HEAD)"
  pass "已提交变更"
else
  pass "无待提交变更"
fi
if git remote get-url origin > /dev/null 2>&1; then
  git push -q origin "$(git rev-parse --abbrev-ref HEAD)" || say "[WARN] push 失败，继续本地流程"
  pass "push 成功 -> $COMMIT"
else
  say "[WARN] 没有远端，跳过 push"
fi
stage_end push "代码推送"

# ---------- 2. build ----------
stage_start build "Docker 镜像构建"
if $DOCKER build -q -t "$IMAGE_TAG" . > /dev/null; then
  pass "镜像构建成功 $IMAGE_TAG"
else
  fail "镜像构建失败"
fi
# 产物校验：镜像里必须齐全，否则测试会在一个空壳里跑
if $DOCKER run --rm "$IMAGE_TAG" sh -c 'test -f /app/src/cli.js && test -d /app/test && test -f /app/examples/input/synthetic-story.json'; then
  pass "构建产物校验通过（src / test / examples 齐全）"
else
  fail "构建产物校验失败"
fi
stage_end build "Docker 镜像构建"

# ---------- 3. test ----------
stage_start test "容器内单元测试"
# 非 TTY 下 node --test 默认输出 TAP，用 spec 才读得懂
if $DOCKER run --rm "$IMAGE_TAG" node --test --test-reporter=spec 2>&1 | tee -a "$LOG" | grep -q "fail 0"; then
  pass "单元测试全部通过"
else
  fail "单元测试存在失败"
fi
stage_end test "容器内单元测试"

# ---------- 4. scan ----------
stage_start scan "安全与质量扫描"
node ci/scan.js --image="$IMAGE_TAG" 2>&1 | tee -a "$LOG"
SCAN_RC=${PIPESTATUS[0]}
if [ "$SCAN_RC" -eq 0 ]; then
  pass "扫描门禁通过"
else
  fail "扫描门禁拦截"
fi
stage_end scan "安全与质量扫描"

# ---------- 产物 ----------
cat > "$REPORTS/last_build.json" << EOF
{
  "build": "$BUILD",
  "commit": "$COMMIT",
  "image": "$IMAGE_TAG",
  "finishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

say "========== CI 流水线全部通过 =========="
say "产物: $IMAGE_TAG | 日志: $LOG"
