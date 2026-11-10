#!/usr/bin/env bash
# Refresh the CineStream catalog, enrich it, and publish the result.
#
# Runs the same pipeline as .github/workflows/refresh-catalog.yml so the site
# can also be updated from a machine with a checkout (cron, systemd timer, or
# a manual `./scripts/weekly_update.sh`).
#
# Usage:
#   scripts/weekly_update.sh              # full refresh + commit + push
#   scripts/weekly_update.sh --no-push    # refresh + commit only
#   scripts/weekly_update.sh --dry-run    # refresh, leave the tree dirty
#
# Cron (Mondays 06:17, same slot as the GitHub Action):
#   17 6 * * 1 cd /path/to/cinestream-br-v2 && ./scripts/weekly_update.sh >> .cache/weekly.log 2>&1

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PUSH=1
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-push) PUSH=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

if ! python3 -c 'import requests' 2>/dev/null; then
  log "installing python dependency: requests"
  python3 -m pip install --user --disable-pip-version-check requests
fi

log "fetching catalog"
python3 scripts/fetch_catalog.py --workers 6

log "filling missing genres from IMDb"
python3 scripts/enrich_imdb_genres.py || log "genre enrichment failed; keeping previous genres"

log "fetching episode counts"
python3 scripts/fetch_episodes.py --workers 3 || log "episode fetch failed; keeping previous counts"

log "probing episode counts on the player"
python3 scripts/probe_episodes.py --workers 6 || log "episode probe failed; keeping previous counts"

log "validating JSON"
python3 - <<'PY'
import json, os, sys
ok = True
for name in ("movies", "series", "animes"):
    path = f"data/{name}.json"
    try:
        payload = json.load(open(path, encoding="utf-8"))
    except Exception as exc:
        print(f"{path}: invalid ({exc})")
        ok = False
        continue
    items = payload.get("items") or []
    count = payload.get("count")
    print(f"{path}: {len(items)} items")
    if not items:
        print(f"{path}: empty catalog")
        ok = False
    if count is not None and count != len(items):
        print(f"{path}: count={count} but {len(items)} items")
        ok = False
if not ok:
    sys.exit(1)
PY

if [ "$DRY_RUN" = "1" ]; then
  log "dry run: leaving changes uncommitted"
  git status --short data
  exit 0
fi

if git diff --quiet -- data; then
  log "no catalog changes"
  exit 0
fi

git add data
git -c user.name="CineStream updater" -c user.email="updater@users.noreply.github.com" \
  commit -m "chore: refresh catalog data"

if [ "$PUSH" = "1" ]; then
  log "pushing to $(git rev-parse --abbrev-ref HEAD)"
  git push
  log "done — GitHub Pages redeploys automatically"
else
  log "commit created; push skipped (--no-push)"
fi
