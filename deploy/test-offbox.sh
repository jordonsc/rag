#!/usr/bin/env bash
# Tests for deploy/backup-offbox.sh and deploy/restore-offbox.sh (tracker m06), against
# the real bucket under a throwaway prefix (test/offbox-<stamp>-<pid>/) with synthetic
# databases and attachments in a scratch directory. Never reads or writes ~/rag.
# Every object version it creates is deleted on exit.
#
#   bash deploy/test-offbox.sh
#
# Needs what the backup needs: RAG_BACKUP__S3_URI (for the bucket; its prefix is
# ignored), the AWS profile, sqlite3, zstd. Costs a few dozen S3 requests.
#
# `check NAME 'CONDITION'` evaluates CONDITION when it is called, so the conditions are
# single-quoted on purpose and the variables they name are used there (SC2016/SC2034).
# shellcheck disable=SC2016,SC2034
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${RAG_ENV_FILE:-$HOME/.config/rag/env}"
uri="${RAG_BACKUP__S3_URI:-$(grep -s '^RAG_BACKUP__S3_URI=' "$ENV_FILE" | head -n 1 | cut -d= -f2-)}"
profile="${RAG_BACKUP__AWS_PROFILE:-$(grep -s '^RAG_BACKUP__AWS_PROFILE=' "$ENV_FILE" | head -n 1 | cut -d= -f2-)}"
region="${RAG_BACKUP__AWS_REGION:-$(grep -s '^RAG_BACKUP__AWS_REGION=' "$ENV_FILE" | head -n 1 | cut -d= -f2-)}"
profile="${profile:-default}"
region="${region:-ap-southeast-4}"
case "$uri" in s3://?*) ;; *) echo "RAG_BACKUP__S3_URI is not set" >&2; exit 2 ;; esac
rest="${uri#s3://}"
BUCKET="${rest%%/*}"
RUN="test/offbox-$(date -u +%Y%m%dT%H%M%SZ)-$$"
SCRATCH="$(mktemp -d)"
aws_() { aws --profile "$profile" --region "$region" "$@"; }

cleanup() {
    # Every version and delete marker under the run's prefix (the bucket is versioned).
    aws_ s3api list-object-versions --bucket "$BUCKET" --prefix "$RUN/" --output json \
        | python3 -I -c 'import json,sys
d = json.load(sys.stdin)
for v in (d.get("Versions") or []) + (d.get("DeleteMarkers") or []):
    print(v["Key"] + "\t" + v["VersionId"])' \
        | while IFS=$'\t' read -r k v; do
            aws_ s3api delete-object --bucket "$BUCKET" --key "$k" --version-id "$v" >/dev/null
        done
    rm -rf "$SCRATCH"
}
trap cleanup EXIT

pass=0
fail=0
ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL: $1" >&2; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# Every run uses the scratch data and the throwaway prefix, and no env file.
export RAG_ENV_FILE=/dev/null
export RAG_BACKUP__S3_URI="s3://$BUCKET/$RUN"
export RAG_BACKUP__AWS_PROFILE="$profile" RAG_BACKUP__AWS_REGION="$region"
export RAG_BACKUP__DATA_DIR="$SCRATCH/data"

keys() {
    aws_ s3api list-objects-v2 --bucket "$BUCKET" --prefix "$RUN/$1" --query 'Contents[].Key' \
        --output text | tr '\t' '\n' | grep -v '^None$' | sed "s|^$RUN/||" | sort
}
versions() {
    aws_ s3api list-object-versions --bucket "$BUCKET" --prefix "$RUN/$1" --output json \
        | python3 -I -c 'import json,sys
k = sys.argv[1]
print(sum(1 for v in json.load(sys.stdin).get("Versions") or [] if v["Key"] == k))' "$RUN/$1"
}

echo "== setup: synthetic data in $SCRATCH, prefix s3://$BUCKET/$RUN/ =="
mkdir -p "$SCRATCH/data/tracker/attachments" "$SCRATCH/data/ledger"
for db in tracker ledger; do
    sqlite3 "$SCRATCH/data/$db/$db.db" "PRAGMA journal_mode=WAL;
        CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT);
        CREATE TABLE events (id INTEGER PRIMARY KEY, body TEXT);
        INSERT INTO items (title) VALUES ('a'), ('b'), ('c');
        INSERT INTO events (body) VALUES ('x'), ('y');" >/dev/null
done
add_blob() {
    local sha
    sha="$(printf '%s' "$1" | sha256sum | cut -d' ' -f1)"
    mkdir -p "$SCRATCH/data/tracker/attachments/${sha:0:2}"
    printf '%s' "$1" > "$SCRATCH/data/tracker/attachments/${sha:0:2}/$sha"
    echo "${sha:0:2}/$sha"
}
blob1="$(add_blob 'first attachment')"
blob2="$(add_blob 'second attachment')"
# An in-flight write is never uploaded.
touch "$SCRATCH/data/tracker/attachments/${blob1%%/*}/.${blob1#*/}.123.tmp"

# Older copies for the prune: 8 dailies and 5 weeklies of the tracker.
seed="$SCRATCH/seed"
printf 'old' > "$seed"
for d in 01 02 03 04 05 06 07 08; do
    aws_ s3 cp --only-show-errors "$seed" "s3://$BUCKET/$RUN/db/daily/tracker-202001$d.db.zst"
    aws_ s3 cp --only-show-errors "$seed" "s3://$BUCKET/$RUN/db/daily/tracker-202001$d.json"
done
for w in 01 02 03 04 05; do
    aws_ s3 cp --only-show-errors "$seed" "s3://$BUCKET/$RUN/db/weekly/tracker-2020-W$w.db.zst"
    aws_ s3 cp --only-show-errors "$seed" "s3://$BUCKET/$RUN/db/weekly/tracker-2020-W$w.json"
done

DAY="$(date -u +%Y%m%d)"
WEEK="$(date -u +%G-W%V)"

echo "== first run =="
out1="$(bash "$HERE/backup-offbox.sh" 2>&1)" && rc=0 || rc=$?
printf '%s\n' "$out1" | sed 's/^/    /'
check "first run exits 0" '[ "$rc" = 0 ]'
check "both attachments uploaded" 'printf "%s" "$out1" | grep -q "2 local, 2 uploaded, 0 already"'
check "attachments keyed by hash" '[ "$(keys attachments/)" = "$(printf "attachments/%s\n" "$blob1" "$blob2" | sort)" ]'
check "the .tmp in-flight file was not uploaded" '! keys attachments/ | grep -q tmp'
check "today's daily copies and manifests exist" \
    'keys db/daily/ | grep -qx "db/daily/tracker-$DAY.db.zst" && keys db/daily/ | grep -qx "db/daily/ledger-$DAY.json"'
check "the week's weekly copy exists" 'keys db/weekly/ | grep -qx "db/weekly/ledger-$WEEK.db.zst"'
check "tracker dailies pruned to 7 (oldest two gone)" \
    '[ "$(keys db/daily/tracker- | grep -c "\.db\.zst$")" = 7 ] && ! keys db/daily/ | grep -q "tracker-2020010[12]"'
check "pruned dailies lost their manifests too" '[ "$(keys db/daily/tracker- | grep -c "\.json$")" = 7 ]'
check "tracker weeklies pruned to 4 (W01, W02 gone)" \
    '[ "$(keys db/weekly/tracker- | grep -c "\.db\.zst$")" = 4 ] && ! keys db/weekly/ | grep -q "2020-W0[12]"'
check "ledger has 1 daily and 1 weekly" \
    '[ "$(keys db/daily/ledger- | grep -c "\.db\.zst$")" = 1 ] && [ "$(keys db/weekly/ledger- | grep -c "\.db\.zst$")" = 1 ]'

echo "== second run (same day) =="
sqlite3 "$SCRATCH/data/tracker/tracker.db" "INSERT INTO items (title) VALUES ('d');"
out2="$(bash "$HERE/backup-offbox.sh" 2>&1)" && rc=0 || rc=$?
check "second run exits 0" '[ "$rc" = 0 ]'
check "no attachment uploaded twice (log)" 'printf "%s" "$out2" | grep -q "2 local, 0 uploaded, 2 already"'
check "no attachment uploaded twice (one version each)" \
    '[ "$(versions "attachments/$blob1")" = 1 ] && [ "$(versions "attachments/$blob2")" = 1 ]'
check "the weekly copy is not replaced within its week" '[ "$(versions "db/weekly/tracker-$WEEK.db.zst")" = 1 ]'

echo "== restore =="
out3="$(bash "$HERE/restore-offbox.sh" "$SCRATCH/restore" 2>&1)" && rc=0 || rc=$?
printf '%s\n' "$out3" | sed 's/^/    /'
check "restore exits 0" '[ "$rc" = 0 ]'
check "restored tracker has the second run's row" \
    '[ "$(sqlite3 -readonly "$SCRATCH/restore/tracker/tracker.db" "SELECT count(*) FROM items;")" = 4 ]'
check "restored attachments match" 'cmp -s "$SCRATCH/restore/tracker/attachments/$blob1" "$SCRATCH/data/tracker/attachments/$blob1"'
out4="$(bash "$HERE/restore-offbox.sh" "$SCRATCH/restore-weekly" "$WEEK" 2>&1)" && rc=0 || rc=$?
check "restore of the weekly copy exits 0" '[ "$rc" = 0 ]'
check "the weekly copy is the week's first (3 items)" \
    '[ "$(sqlite3 -readonly "$SCRATCH/restore-weekly/tracker/tracker.db" "SELECT count(*) FROM items;")" = 3 ]'

echo "== negatives =="
# A manifest whose counts do not match its database is refused.
aws_ s3 cp --only-show-errors "s3://$BUCKET/$RUN/db/daily/tracker-$DAY.db.zst" "s3://$BUCKET/$RUN/db/daily/tracker-20990101.db.zst"
aws_ s3 cp --only-show-errors "s3://$BUCKET/$RUN/db/daily/ledger-$DAY.db.zst" "s3://$BUCKET/$RUN/db/daily/ledger-20990101.db.zst"
aws_ s3 cp --only-show-errors "s3://$BUCKET/$RUN/db/daily/ledger-$DAY.json" "s3://$BUCKET/$RUN/db/daily/ledger-20990101.json"
aws_ s3 cp --only-show-errors "s3://$BUCKET/$RUN/db/daily/tracker-$DAY.json" - \
    | sed 's/"items": 4/"items": 5/' > "$SCRATCH/tampered.json"
aws_ s3 cp --only-show-errors "$SCRATCH/tampered.json" "s3://$BUCKET/$RUN/db/daily/tracker-20990101.json"
out5="$(bash "$HERE/restore-offbox.sh" "$SCRATCH/restore-bad" 20990101 2>&1)" && rc=0 || rc=$?
check "a row-count mismatch fails the restore" '[ "$rc" != 0 ] && printf "%s" "$out5" | grep -q "row counts differ"'
# A sha256 mismatch is refused too (the ledger copy under a tracker manifest).
aws_ s3 cp --only-show-errors "s3://$BUCKET/$RUN/db/daily/ledger-$DAY.db.zst" "s3://$BUCKET/$RUN/db/daily/tracker-20990101.db.zst"
aws_ s3 cp --only-show-errors "s3://$BUCKET/$RUN/db/daily/tracker-$DAY.json" "s3://$BUCKET/$RUN/db/daily/tracker-20990101.json"
out6="$(bash "$HERE/restore-offbox.sh" "$SCRATCH/restore-bad2" 20990101 2>&1)" && rc=0 || rc=$?
check "a sha256 mismatch fails the restore" '[ "$rc" != 0 ] && printf "%s" "$out6" | grep -q "does not match the manifest"'
out7="$(bash "$HERE/restore-offbox.sh" "$SCRATCH/data/tracker" 2>&1)" && rc=0 || rc=$?
check "restore refuses the live data directory" '[ "$rc" != 0 ] && printf "%s" "$out7" | grep -q "DEST is the live"'
out8="$(bash "$HERE/restore-offbox.sh" "$SCRATCH/restore" 2>&1)" && rc=0 || rc=$?
check "restore refuses a directory holding a database" '[ "$rc" != 0 ] && printf "%s" "$out8" | grep -q "already holds"'
# A blob that does not hash to its name fails the run and is not uploaded.
badsha="$(printf 'something else' | sha256sum | cut -d' ' -f1)"
mkdir -p "$SCRATCH/data/tracker/attachments/${badsha:0:2}"
printf 'not what the name says' > "$SCRATCH/data/tracker/attachments/${badsha:0:2}/$badsha"
out9="$(bash "$HERE/backup-offbox.sh" 2>&1)" && rc=0 || rc=$?
check "a corrupt attachment fails the run" '[ "$rc" != 0 ] && printf "%s" "$out9" | grep -q "do not hash to their names"'
check "a corrupt attachment is not uploaded" '! keys attachments/ | grep -q "$badsha"'
rm -rf "${SCRATCH:?}/data/tracker/attachments/${badsha:0:2}"
out10="$(RAG_BACKUP__S3_URI='' bash "$HERE/backup-offbox.sh" 2>&1)" && rc=0 || rc=$?
check "no S3 URI fails the run" '[ "$rc" != 0 ] && printf "%s" "$out10" | grep -q "RAG_BACKUP__S3_URI is not set"'
out11="$(RAG_BACKUP__S3_URI="s3://$BUCKET-does-not-exist-$$/x" bash "$HERE/backup-offbox.sh" 2>&1)" && rc=0 || rc=$?
check "an unreachable bucket fails the run" '[ "$rc" != 0 ] && printf "%s" "$out11" | grep -q "cannot reach bucket"'
mv "$SCRATCH/data/ledger/ledger.db" "$SCRATCH/ledger.db.away"
out12="$(bash "$HERE/backup-offbox.sh" 2>&1)" && rc=0 || rc=$?
check "a missing database fails the run" '[ "$rc" != 0 ] && printf "%s" "$out12" | grep -q "does not exist"'
mv "$SCRATCH/ledger.db.away" "$SCRATCH/data/ledger/ledger.db"
exec 8>"$SCRATCH/data/backups/.offbox.lock"
flock -n 8
out13="$(bash "$HERE/backup-offbox.sh" 2>&1)" && rc=0 || rc=$?
check "a second concurrent run is refused" '[ "$rc" != 0 ] && printf "%s" "$out13" | grep -q "another off-box backup is running"'
exec 8>&-

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
