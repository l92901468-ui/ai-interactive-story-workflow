#!/usr/bin/env bash
# 一键串起 CI 与 CD。
#
# CI 的产物写在 ci/reports/last_build.json，CD 从那里取镜像，
# 两边不是各跑各的。
#
# 用法：
#   bash pipeline.sh               # CI，然后只到 staging
#   bash pipeline.sh --env=prod    # CI，然后进 prod

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

TARGET="staging"
for arg in "$@"; do
  case "$arg" in
    --env=*) TARGET="${arg#*=}" ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

echo "================ CI ================"
bash ci/ci.sh

IMAGE="$(node -e 'const d=require("./ci/reports/last_build.json");process.stdout.write(d.image)')"
echo
echo "CI 产出镜像: $IMAGE"

echo "================ CD ================"
if [ "$TARGET" = "prod" ]; then
  bash cd/deploy.sh --image="$IMAGE" --env=prod --times=2 --interval=500
else
  bash cd/deploy.sh --image="$IMAGE" --env=staging --times=2 --interval=500
fi
