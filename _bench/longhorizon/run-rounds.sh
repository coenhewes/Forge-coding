#!/usr/bin/env bash
# Long-horizon rounds: forge x3, opencode xN. Concurrent forge+opencode pairs on distinct ports.
set -u
cd "$(dirname "$0")/../.."
R=_bench/longhorizon
run() { node "$R/longhorizon-runner.mjs" --agent "$1" --max-iterations 800 --timeout-hours 4 --port "$2" > "$R/runs/batch-$1-$3.log" 2>&1; echo "[$(date +%H:%M)] done $1 $3: $(grep -oE 'RESULT:.*' "$R/runs/batch-$1-$3.log" | tail -1)"; }
echo "[$(date +%H:%M)] WAVE 1"; run forge 4491 r1 & run opencode 4591 r1 & wait
echo "[$(date +%H:%M)] WAVE 2"; run forge 4492 r2 & run opencode 4592 r2 & wait
echo "[$(date +%H:%M)] WAVE 3"; run forge 4493 r3 & run opencode 4593 r3 & wait
echo "[$(date +%H:%M)] ALL ROUNDS DONE"
