#!/usr/bin/env bash
# keeper-cron.sh — rinnova i token ARK e li pubblica sul branch 'tokens'
# Uso: ogni 7 minuti via cron. Commit solo se ci sono cambiamenti.
set -u
cd /home/agentsvc/work/streamhub-lite-web || exit 1
LOG=/home/agentsvc/work/streamhub-lite-web/logs/token-keeper.log
mkdir -p "$(dirname "$LOG")"

# 1. Rinnova token (salta quelli validi)
node scripts/token-keeper.mjs tokens.json >> "$LOG" 2>&1
KEEPER_RC=$?

# 2. Prepara push sul branch tokens
git fetch origin tokens -q 2>/dev/null
git checkout tokens -q 2>/dev/null || git checkout -b tokens origin/tokens -q 2>/dev/null
# porta il keeper aggiornato anche sul branch tokens (se manca)
git checkout main -- scripts/token-keeper.mjs scripts/keeper-cron.sh 2>/dev/null
git add tokens.json scripts/token-keeper.mjs scripts/keeper-cron.sh

if git diff --cached --quiet; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) no changes, skip push (keeper_rc=$KEEPER_RC)" >> "$LOG"
  git checkout main -q 2>/dev/null
  exit 0
fi

git commit -m "tokens refresh $(date -u +%Y%m%d-%H%M%S)" -q
if git push origin tokens -q >> "$LOG" 2>&1; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) pushed tokens refresh" >> "$LOG"
else
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) PUSH FAILED rc=$?" >> "$LOG"
fi
git checkout main -q 2>/dev/null
exit 0
