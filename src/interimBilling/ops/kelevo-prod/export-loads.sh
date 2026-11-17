#!/usr/bin/env bash
# TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
#
# NOT APPLIED. Forced command for the interim-billing ssh key on kelevo-prod.
# Reads the window from SSH_ORIGINAL_COMMAND ("<from> <to>", two UTC
# timestamps like 2026-11-02T06:00:00Z), validates it strictly, then calls the
# one read-only SQL function and prints its JSON. Runs as root through the
# sudoers rule in sudoers.example; owned by root, not writable by anyone else.
set -euo pipefail

DB_NAME="__KELEVO_DB_NAME__"   # replaced when the owner approves applying this
CONTAINER="postgres-prod"

arg="${SSH_ORIGINAL_COMMAND:-}"
re='^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z) ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)$'
if [[ ! "$arg" =~ $re ]]; then
    echo "bad request" >&2
    exit 2
fi
from="${BASH_REMATCH[1]}"
to="${BASH_REMATCH[2]}"

# Real dates, in order, and a window of at most 400 days.
from_s="$(date -u -d "$from" +%s 2>/dev/null)" || { echo "bad request" >&2; exit 2; }
to_s="$(date -u -d "$to" +%s 2>/dev/null)" || { echo "bad request" >&2; exit 2; }
if (( to_s <= from_s )) || (( to_s - from_s > 400 * 86400 )); then
    echo "bad request" >&2
    exit 2
fi

sql="SELECT iwd_billing_loads(:'from_ts'::timestamptz, :'to_ts'::timestamptz);"
exec docker exec -i "$CONTAINER" psql -X -q -A -t -U iwd_billing_ro -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -v "from_ts=$from" -v "to_ts=$to" -f - <<<"$sql"
