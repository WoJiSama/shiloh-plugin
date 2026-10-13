#!/usr/bin/env bash
# bl-chat-plugin → 服务器 shiloh-plugin 一键部署
# 流程: 阶段验收 → 干净 commit 产物 → 暂存校验 → 停服务安装 → 健康检查 → 失败回滚
#
# 用法:
#   ./scripts/deploy.sh                  # 完整流程
#   不支持跳过测试；生产只执行已编译的 JS。
#
# 环境变量:
#   DEPLOY_TARGET   默认 root@124.223.95.142
#   SSHPASS         SSH 密码(密码登录时需要;配好 key 后不用)
#
# 健康检查全部通过才算成功:服务 active / 零载入错误 / 消息管线启动 / 命令页 200 / 控制台 active / 控制台页 200。
# 历史教训(2026-10-07):两次"本地测试全过、服务器加载失败",所以部署必须自动验证,
# 失败自动回滚到部署前快照(保留最近 5 份,在服务器 /opt/trss-yunzai-backups/deploy-snapshots/)。
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

TARGET="${DEPLOY_TARGET:-root@124.223.95.142}"
REMOTE_DIR="/opt/trss-yunzai/plugins/shiloh-plugin"
SNAP_ROOT="/opt/trss-yunzai-backups/deploy-snapshots"
STAMP="$(date +%Y%m%d-%H%M%S)"
KEEP=5

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
if [ -n "${SSHPASS:-}" ]; then
  SSH() { sshpass -e ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }
  RSYNC=(rsync -az --no-o --no-g -e "sshpass -e ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15")
else
  SSH() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }
  RSYNC=(rsync -az --no-o --no-g -e "ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15")
fi

EXCLUDES=(--exclude .git --exclude node_modules --exclude config --exclude data
  --exclude database --exclude logs --exclude backups --exclude .zcode
  "--exclude=.remote-edit-backup*")

log() { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1. 必须从干净 commit 构建；禁止跳过阶段验收 ----------
[ "${1:-}" != "--skip-tests" ] || fail "TS 发布不支持 --skip-tests，请先完成 verify:phase"
log "类型、边界、前后端全量验证…"
npm run verify:phase > /tmp/deploy-tests.log 2>&1 || { tail -40 /tmp/deploy-tests.log; fail "验收失败，未触碰服务器"; }
npm run release:pack
RELEASE_COMMIT="$(git rev-parse HEAD)"
ARTIFACT=".release/$RELEASE_COMMIT"
REMOTE_STAGE="/opt/trss-yunzai-backups/staged-$RELEASE_COMMIT-$STAMP"
BACKUP="$SNAP_ROOT/$STAMP"

# ---------- 2. 先上传完整包并校验，服务继续运行 ----------
SSH "mkdir -p '$REMOTE_STAGE' '$SNAP_ROOT'"
"${RSYNC[@]}" "$ARTIFACT/" "$TARGET:$REMOTE_STAGE/" >/dev/null
SSH "node '$REMOTE_STAGE/scripts/release.mjs' verify '$REMOTE_STAGE'"
# 依赖必须与锁文件一致；安装在暂存区，不修改在线 node_modules。
SSH "cd '$REMOTE_STAGE' && npm ci --omit=dev --no-audit --no-fund"

# ---------- 3. 停服务后安装；配置/data 不参与覆盖或回滚 ----------
log "停止入口并安装已验证产物…"
SSH "systemctl stop bl-console trss-yunzai"
if ! SSH "node '$REMOTE_STAGE/scripts/release.mjs' install '$REMOTE_STAGE' '$REMOTE_DIR' '$BACKUP'"; then
  SSH "systemctl start trss-yunzai bl-console"
  fail "运行文件安装失败，安装器已恢复原文件"
fi
# 整体切换同机安装的依赖，并保留旧依赖用于失败回滚。
if ! SSH "mv '$REMOTE_DIR/node_modules' '$BACKUP/node_modules' && mv '$REMOTE_STAGE/node_modules' '$REMOTE_DIR/node_modules'"; then
  SSH "node '$REMOTE_STAGE/scripts/release.mjs' rollback '$REMOTE_DIR' '$BACKUP'; if [ -d '$BACKUP/node_modules' ]; then mv '$BACKUP/node_modules' '$REMOTE_DIR/node_modules'; fi; systemctl start trss-yunzai bl-console"
  fail "依赖切换失败，已尝试恢复"
fi

# ---------- 4. 重启 + 健康检查 ----------
log "重启 Yunzai + 控制台…"
HEALTH=$(SSH 'bash -s' <<'REMOTE_CHECK'
systemctl restart trss-yunzai
systemctl restart bl-console
sleep 18
ACTIVE=$(systemctl is-active trss-yunzai || true)
ERRORS=$(journalctl -u trss-yunzai --since "-45 seconds" --no-pager 2>/dev/null | grep -caE "载入插件错误|ReferenceError|SyntaxError|is not defined|unhandled" || true)
PIPE=$(journalctl -u trss-yunzai --since "-45 seconds" --no-pager 2>/dev/null | grep -ca "MessagePipeline.*已启动" || true)
PAGE=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://127.0.0.1:2536/bl-chat/commands 2>/dev/null || echo 000)
CONSOLE=$(systemctl is-active bl-console || true)
CONSOLE_PAGE=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://127.0.0.1:8787/ 2>/dev/null || echo 000)
echo "$ACTIVE $ERRORS $PIPE $PAGE $CONSOLE $CONSOLE_PAGE"
REMOTE_CHECK
) || HEALTH="failed 1 0 000 failed 000"
read -r ACTIVE ERRORS PIPE PAGE CONSOLE CONSOLE_PAGE <<<"$HEALTH"
log "健康检查: service=$ACTIVE load_errors=$ERRORS pipeline=$PIPE commands_page=$PAGE console=$CONSOLE/$CONSOLE_PAGE"

if [ "$ACTIVE" = "active" ] && [ "${ERRORS:-1}" = "0" ] && [ "${PIPE:-0}" -ge 1 ] && [ "$PAGE" = "200" ] \
  && [ "$CONSOLE" = "active" ] && [ "$CONSOLE_PAGE" = "200" ]; then
  SSH "cd '$SNAP_ROOT' && ls -1d */ 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf" || true
  log "部署成功 ✔  快照保留在 $SNAP_ROOT/$STAMP(最近 $KEEP 份)"
  exit 0
fi

# ---------- 5. 回滚 ----------
log "健康检查未通过,回滚到快照 $STAMP …"
SSH "systemctl stop trss-yunzai bl-console && node '$REMOTE_STAGE/scripts/release.mjs' rollback '$REMOTE_DIR' '$BACKUP' && mv '$REMOTE_DIR/node_modules' '$REMOTE_STAGE/failed-node_modules' && mv '$BACKUP/node_modules' '$REMOTE_DIR/node_modules' && systemctl start trss-yunzai bl-console" || true
sleep 15
RB=$(SSH "systemctl is-active trss-yunzai || true")
fail "部署失败已回滚(回滚后服务: $RB)。手动排查: journalctl -u trss-yunzai -n 50 / journalctl -u bl-console -n 50"
