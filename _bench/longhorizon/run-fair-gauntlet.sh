#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/../.."
R=_bench/longhorizon
echo "[fair $(date +%H:%M)] START — fair head-to-head, keys in .env up front for both"
for i in 1 2 3; do
  for agent in opencode forge; do
    echo "[fair $(date +%H:%M)] === run $i: $agent ==="
    node "$R/longhorizon-runner.mjs" --agent "$agent" --max-iterations 1000 --timeout-hours 3 --port 44$((90+i)) \
      > "$R/runs/fair-$agent-$i.log" 2>&1
    echo "[fair $(date +%H:%M)] $agent run $i DONE: $(grep -oE 'RESULT:.*' "$R/runs/fair-$agent-$i.log" | tail -1)"
  done
done
echo "[fair $(date +%H:%M)] FAIR GAUNTLET COMPLETE"
