#!/usr/bin/env bash
# Forgeflow fair head-to-head. Bigger task → more iterations + longer timeout for forge;
# opencode self-terminates. Sequential (shared DB/machine). Arg: runs per agent (default 2).
set -u; cd "$(dirname "$0")/../.."
R=_bench/longhorizon2; N="${1:-2}"
echo "[ff $(date +%H:%M)] START Forgeflow head-to-head — $N runs/agent, keys in .env up front"
for i in $(seq 1 "$N"); do
  for agent in opencode forge; do
    echo "[ff $(date +%H:%M)] === run $i: $agent ==="
    node "$R/longhorizon-runner.mjs" --agent "$agent" --max-iterations 2500 --timeout-hours 6 --port 45$((90+i)) \
      > "$R/runs/ff-$agent-$i.log" 2>&1
    echo "[ff $(date +%H:%M)] $agent run $i DONE: $(grep -oE 'RESULT:.*' "$R/runs/ff-$agent-$i.log" | tail -1)"
  done
done
echo "[ff $(date +%H:%M)] FORGEFLOW GAUNTLET COMPLETE"
