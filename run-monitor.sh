#!/bin/sh
# Local monitor runner (Mac mini primary since 2026-07-06; Actions cron was throttled to ~5h gaps).
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/bin:/bin"
export SPIKE_PCT="${SPIKE_PCT:-100}"

echo "=== $(date '+%F %T') ==="
git pull --rebase --quiet || echo "warn: git pull failed, running on local state"
node monitor.mjs
git add state/
if git diff --cached --quiet; then
  echo "no state changes"
else
  git commit --quiet -m "chore: update monitor state [skip ci]"
  git push --quiet || echo "warn: push failed, will retry next run"
fi
