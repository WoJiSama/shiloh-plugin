#!/usr/bin/env bash
# bl-chat-plugin → 服务器 shiloh-plugin 一键部署
# 流程: 本地全量测试 → 服务器快照(hardlink 秒级) → rsync → 重启 Yunzai → 健康检查 → 失败自动回滚
#
# 用法:
#   ./scripts/deploy.sh                  # 完整流程
#   ./scripts/deploy.sh --skip-tests     # 跳过本地测试(紧急修复用,慎用)
#
# 环境变量:
#   DEPLOY_TARGET   默认 root@124.223.95.142
#   SSHPASS         SSH 密码(密码登录时需要;配好 key 后不用)
#
# 健康检查四项全部通过才算成功:服务 active / 零载入错误 / 消息管线启动 / 命令页 200。
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

# ---------- 1. 本地测试(失败自动重试一次,吸收时间敏感的 flaky 用例) ----------
if [ "${1:-}" != "--skip-tests" ]; then
  log "本地全量测试…"
  if ! npm test --silent >/tmp/deploy-tests.log 2>&1; then
    log "首轮失败,重试一次吸收 flaky…"
    npm test --silent >/tmp/deploy-tests-retry.log 2>&1 \
      || { tail -30 /tmp/deploy-tests-retry.log; fail "本地测试两轮未通过,已中止(未触碰服务器)"; }
  fi
  log "测试通过"
fi

# ---------- 2. 服务器快照 ----------
log "快照 → $SNAP_ROOT/$STAMP"
SSH "mkdir -p '$SNAP_ROOT' && cp -al '$REMOTE_DIR' '$SNAP_ROOT/$STAMP'"

# ---------- 3. rsync 同步 ----------
log "同步代码 → $REMOTE_DIR"
"${RSYNC[@]}" --delete "${EXCLUDES[@]}" ./ "$TARGET:$REMOTE_DIR/" >/dev/null

# ---------- 4. 重启 + 健康检查 ----------
log "重启 Yunzai…"
HEALTH=$(SSH 'bash -s' <<'REMOTE_CHECK'
systemctl restart trss-yunzai
sleep 18
ACTIVE=$(systemctl is-active trss-yunzai || true)
ERRORS=$(journalctl -u trss-yunzai --since "-45 seconds" --no-pager 2>/dev/null | grep -caE "载入插件错误|ReferenceError|SyntaxError|is not defined|unhandled" || true)
PIPE=$(journalctl -u trss-yunzai --since "-45 seconds" --no-pager 2>/dev/null | grep -ca "MessagePipeline.*已启动" || true)
PAGE=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://127.0.0.1:2536/bl-chat/commands 2>/dev/null || echo 000)
echo "$ACTIVE $ERRORS $PIPE $PAGE"
REMOTE_CHECK
)
read -r ACTIVE ERRORS PIPE PAGE <<<"$HEALTH"
log "健康检查: service=$ACTIVE load_errors=$ERRORS pipeline=$PIPE commands_page=$PAGE"

if [ "$ACTIVE" = "active" ] && [ "${ERRORS:-1}" = "0" ] && [ "${PIPE:-0}" -ge 1 ] && [ "$PAGE" = "200" ]; then
  SSH "cd '$SNAP_ROOT' && ls -1d */ 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf" || true
  log "部署成功 ✔  快照保留在 $SNAP_ROOT/$STAMP(最近 $KEEP 份)"
  exit 0
fi

# ---------- 5. 回滚 ----------
log "健康检查未通过,回滚到快照 $STAMP …"
SSH "rm -rf '$REMOTE_DIR' && cp -al '$SNAP_ROOT/$STAMP' '$REMOTE_DIR' && systemctl restart trss-yunzai" || true
sleep 15
RB=$(SSH "systemctl is-active trss-yunzai || true")
fail "部署失败已回滚(回滚后服务: $RB)。手动排查: journalctl -u trss-yunzai -n 50"
