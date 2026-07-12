#!/bin/sh
# Local guide-sitemap-monitor runner (Part A, indie-builder-brain/briefs/2026-07-12-sitemap-discovery-radar.md).
# Mirrors run-monitor.sh's structure; shares its file lock (same LOCK_DIR) since both touch state/.
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/bin:/bin"

# ---- 文件锁：跟本机另一个 runner 互斥（避免同时改动 state/ 引发提交冲突）----
LOCK_DIR="/tmp/roblox-window-monitor.runlock"
STALE_SECS=600
acquire_lock() {
  local tries=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ -d "$LOCK_DIR" ]; then
      local mtime age
      mtime=$(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0)
      age=$(( $(date +%s) - mtime ))
      if [ "$age" -gt "$STALE_SECS" ]; then
        echo "warn: stale lock (${age}s old), removing"
        rmdir "$LOCK_DIR" 2>/dev/null
        continue
      fi
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
      echo "warn: lock busy after ${tries} tries, skipping this run"
      exit 0
    fi
    sleep 2
  done
  trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT
}
acquire_lock

echo "=== $(date '+%F %T') ==="
git pull --rebase --quiet || echo "warn: git pull failed, running on local state"
node guide-sitemap-monitor.mjs
git add state/
if git diff --cached --quiet; then
  echo "no state changes"
else
  git commit --quiet -m "chore: update guide-sitemap-monitor state [skip ci]"
  # push 重试（jittered backoff），跟 Part 0.2 给 sitemap-monitor.yml 加的重试同一个模式——
  # 本机锁只管本机两个 runner 互斥，管不到远端已经领先的提交，仍需要 pull --rebase 重试。
  ok=0
  for attempt in 1 2 3; do
    if git push --quiet; then ok=1; break; fi
    echo "warn: push failed (attempt $attempt/3), retrying after backoff"
    sleep $((attempt * 3 + RANDOM % 3))
    git pull --rebase --quiet || true
  done
  [ "$ok" = 1 ] || echo "warn: push failed after retries, will retry next run"
fi
