#!/usr/bin/env bash
# 把 standalone/ 下的独立插件同步到 Yunzai plugins/ 目录（服务器上执行）。
# 用法：在 shiloh-plugin 仓库根目录运行 bash scripts/deploy-standalone.sh [yunzai根目录]
# 默认 Yunzai 根：/opt/trss-yunzai
set -euo pipefail
YUNZAI_ROOT="${1:-/opt/trss-yunzai}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# standalone wrappers 引用共享 shiloh-plugin；共享编译产物必须存在且匹配 manifest。
node --input-type=module - "$REPO_ROOT" <<'NODE'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const root = process.argv[2]
const { verifyBackend } = await import(pathToFileURL(path.join(root, 'scripts/lib/build-support.mjs')))
await verifyBackend(path.join(root, 'dist/backend'))
NODE
for dir in "$REPO_ROOT"/standalone/*/; do
  name="$(basename "$dir")"
  target="$YUNZAI_ROOT/plugins/$name"
  mkdir -p "$target"
  rsync -a --delete "$dir" "$target"
  echo "deployed $name -> $target"
done
