#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/../.."
R=_bench/longhorizon
# node-prefixed pattern avoids matching the monitor shell that greps the same string.
running() { pgrep -f "node .*longhorizon-runner\.mjs --agent forge" >/dev/null 2>&1; }
echo "[gauntlet $(date +%H:%M)] waiting for any in-flight forge run…"
while running; do sleep 30; done
for tag in r5 r6 r7; do
  echo "[gauntlet $(date +%H:%M)] starting forge $tag"
  node "$R/longhorizon-runner.mjs" --agent forge --max-iterations 1200 --timeout-hours 6 --port 4495 > "$R/runs/g-forge-$tag.log" 2>&1
  echo "[gauntlet $(date +%H:%M)] forge $tag DONE: $(grep -oE 'RESULT:.*' "$R/runs/g-forge-$tag.log" | tail -1)"
  sleep 5; while running; do sleep 30; done
done
echo "[gauntlet $(date +%H:%M)] FORGE GAUNTLET DONE (r2,r3,r4)"
