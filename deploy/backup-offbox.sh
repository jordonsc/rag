#!/usr/bin/env bash
# Off-box backup of the tracker and the ledger to S3 (tracker m06, TB-01).
#
# What it puts in the bucket, under RAG_BACKUP__S3_URI (e.g. s3://rag-atlas-backups/atlas):
#   db/daily/<db>-<YYYYMMDD>.db.zst     a consistent `sqlite3 .backup` copy, zstd-compressed
#   db/daily/<db>-<YYYYMMDD>.json       its manifest: sha256 + size of the uncompressed copy,
#                                       integrity_check result, and the row count of every table
#   db/weekly/<db>-<GGGG>-W<VV>.db.zst  the first daily copy of each ISO week (+ its .json)
#   attachments/<sha[0..2]>/<sha256>    the tracker's content-addressed attachments
# for <db> in tracker and ledger. Keeps the newest 7 daily and 4 weekly copies of each
# database and deletes older ones (the bucket is versioned, so a deleted copy stays
# recoverable as a noncurrent version for 30 days: a second net, not the retention).
#
# Attachments are synced by hash: a blob's name IS its sha256 and is never rewritten,
# so a blob is uploaded only when its name is not yet in the bucket, after its bytes
# are checked against its name. Nothing is ever deleted from attachments/.
#
# Never a raw copy of a live WAL database: the copy is made with sqlite3's online
# backup, which reads one consistent snapshot while rag-serve keeps writing.
#
# Configuration (the env vars win; otherwise read from ~/.config/rag/env, which holds
# NO AWS keys — the AWS CLI's own profile, in ~/.aws, supplies the credentials):
#   RAG_BACKUP__S3_URI       required, s3://bucket[/prefix]
#   RAG_BACKUP__AWS_PROFILE  default "default"
#   RAG_BACKUP__AWS_REGION   default "ap-southeast-4"
#   RAG_BACKUP__DATA_DIR     default ~/rag (holds tracker/, ledger/)
#   RAG_BACKUP__KEEP_DAILY   default 7
#   RAG_BACKUP__KEEP_WEEKLY  default 4
#
# Run by rag-backup-offbox.service (nightly timer). By hand:
#   bash deploy/backup-offbox.sh
# Restore: deploy/RUNBOOK.md, "Restore from S3" (deploy/restore-offbox.sh).
#
# Any failure exits non-zero, so `systemctl --user status rag-backup-offbox` shows it.
set -euo pipefail

ENV_FILE="${RAG_ENV_FILE:-$HOME/.config/rag/env}"

# Read RAG_BACKUP__* from the env file without sourcing it: it holds other secrets
# and its values are not shell-quoted. An already-set variable wins.
if [ -r "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            RAG_BACKUP__*=*) ;;
            *) continue ;;
        esac
        key="${line%%=*}"
        val="${line#*=}"
        val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
        [[ "$key" =~ ^RAG_BACKUP__[A-Z0-9_]+$ ]] || continue
        if [ -z "${!key:-}" ]; then
            export "$key=$val"
        fi
    done < "$ENV_FILE"
fi

S3_URI="${RAG_BACKUP__S3_URI:-}"
PROFILE="${RAG_BACKUP__AWS_PROFILE:-default}"
REGION="${RAG_BACKUP__AWS_REGION:-ap-southeast-4}"
DATA_DIR="${RAG_BACKUP__DATA_DIR:-$HOME/rag}"
KEEP_DAILY="${RAG_BACKUP__KEEP_DAILY:-7}"
KEEP_WEEKLY="${RAG_BACKUP__KEEP_WEEKLY:-4}"

die() { echo "ERROR: $*" >&2; exit 1; }

case "$S3_URI" in
    s3://?*) ;;
    *) die "RAG_BACKUP__S3_URI is not set to s3://bucket[/prefix] (env or $ENV_FILE)" ;;
esac
[[ "$KEEP_DAILY" =~ ^[1-9][0-9]*$ ]] || die "RAG_BACKUP__KEEP_DAILY must be a positive integer"
[[ "$KEEP_WEEKLY" =~ ^[1-9][0-9]*$ ]] || die "RAG_BACKUP__KEEP_WEEKLY must be a positive integer"

for tool in aws sqlite3 zstd sha256sum flock; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not installed (apt: awscli v2 / sqlite3 / zstd / coreutils / util-linux)"
done

# s3://bucket/prefix -> BUCKET, PREFIX (no leading/trailing slash; may be empty).
rest="${S3_URI#s3://}"
BUCKET="${rest%%/*}"
PREFIX=""
[ "$rest" != "$BUCKET" ] && PREFIX="${rest#*/}"
PREFIX="${PREFIX%/}"
key_of() { if [ -n "$PREFIX" ]; then printf '%s/%s' "$PREFIX" "$1"; else printf '%s' "$1"; fi; }

aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

# Keys under a prefix, one per line (the CLI paginates; "None" means empty).
# A failed listing is fatal (never mistaken for an empty prefix).
list_keys() {
    local out
    out="$(aws_ s3api list-objects-v2 --bucket "$BUCKET" --prefix "$1" \
        --query 'Contents[].Key' --output text)" || die "cannot list s3://$BUCKET/$1"
    [ "$out" = "None" ] && return 0
    printf '%s\n' "$out" | tr '\t' '\n' | sed '/^$/d'
}

# One run at a time (the timer and a hand run must not interleave their prunes).
mkdir -p "$DATA_DIR/backups"
exec 9>"$DATA_DIR/backups/.offbox.lock"
flock -n 9 || die "another off-box backup is running (lock $DATA_DIR/backups/.offbox.lock)"

WORK="$(mktemp -d "$DATA_DIR/backups/offbox.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

DAY="$(date -u +%Y%m%d)"
WEEK="$(date -u +%G-W%V)"
echo "== off-box backup $DAY ($WEEK) -> s3://$BUCKET/${PREFIX:+$PREFIX/} (profile $PROFILE, $REGION) =="

# Fail early, before any work, if the bucket is not reachable with these credentials.
aws_ s3api head-bucket --bucket "$BUCKET" >/dev/null || die "cannot reach bucket $BUCKET with profile $PROFILE"

# The row count of every table, as JSON object members ("t": n, ...).
table_counts() {
    local db="$1" first=1 t n
    while IFS= read -r t; do
        n="$(sqlite3 -readonly "$db" "SELECT count(*) FROM \"${t//\"/\"\"}\";")"
        [ "$first" = 1 ] || printf ', '
        printf '"%s": %s' "$t" "$n"
        first=0
    done < <(sqlite3 -readonly "$db" "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;")
}

backup_db() {
    local name="$1" src="$2"
    echo "== $name: $src =="
    [ -f "$src" ] || die "$src does not exist"

    local copy="$WORK/$name.db"
    # The online backup API: a consistent snapshot of a live WAL database.
    sqlite3 -readonly "$src" ".timeout 30000" ".backup '$copy'"
    local check
    check="$(sqlite3 -readonly "$copy" 'PRAGMA integrity_check;')"
    [ "$check" = "ok" ] || die "$name: integrity_check of the copy failed: $check"

    local sha size counts
    sha="$(sha256sum "$copy" | cut -d' ' -f1)"
    size="$(stat -c %s "$copy")"
    counts="$(table_counts "$copy")"
    cat > "$WORK/$name.json" <<EOF
{"db": "$name", "taken_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "source": "$src", "sha256": "$sha", "size": $size, "integrity_check": "ok", "tables": {$counts}}
EOF
    zstd -q -10 -T0 "$copy" -o "$WORK/$name.db.zst"
    echo "  copy: $size bytes, sha256 ${sha:0:16}…, compressed $(stat -c %s "$WORK/$name.db.zst") bytes"
    echo "  rows: $counts"

    local daily
    daily="$(key_of "db/daily/$name-$DAY")"
    aws_ s3 cp --only-show-errors "$WORK/$name.db.zst" "s3://$BUCKET/$daily.db.zst"
    aws_ s3 cp --only-show-errors --content-type application/json "$WORK/$name.json" "s3://$BUCKET/$daily.json"
    local remote_size
    remote_size="$(aws_ s3api head-object --bucket "$BUCKET" --key "$daily.db.zst" --query ContentLength --output text)"
    [ "$remote_size" = "$(stat -c %s "$WORK/$name.db.zst")" ] \
        || die "$name: uploaded size $remote_size does not match the local $(stat -c %s "$WORK/$name.db.zst")"
    echo "  uploaded s3://$BUCKET/$daily.db.zst"

    # The week's first copy becomes its weekly (server-side copy, no re-upload).
    local weekly
    weekly="$(key_of "db/weekly/$name-$WEEK")"
    if ! aws_ s3api head-object --bucket "$BUCKET" --key "$weekly.db.zst" >/dev/null 2>&1; then
        aws_ s3 cp --only-show-errors "s3://$BUCKET/$daily.db.zst" "s3://$BUCKET/$weekly.db.zst"
        aws_ s3 cp --only-show-errors "s3://$BUCKET/$daily.json" "s3://$BUCKET/$weekly.json"
        echo "  weekly s3://$BUCKET/$weekly.db.zst"
    fi

    prune "$(key_of "db/daily/$name-")" "$KEEP_DAILY"
    prune "$(key_of "db/weekly/$name-")" "$KEEP_WEEKLY"
}

# Keep the newest $2 copies under key prefix $1; a copy is its .db.zst and its .json.
# The stamp in the name (YYYYMMDD, GGGG-Www) sorts in time order.
prune() {
    local pfx="$1" keep="$2" stem
    local keys
    keys="$(list_keys "$pfx")"
    printf '%s\n' "$keys" | { grep '\.db\.zst$' || true; } | sed 's/\.db\.zst$//' | sort -r \
        | tail -n +$((keep + 1)) | while IFS= read -r stem; do
            echo "  prune s3://$BUCKET/$stem.db.zst"
            aws_ s3api delete-object --bucket "$BUCKET" --key "$stem.db.zst" >/dev/null
            aws_ s3api delete-object --bucket "$BUCKET" --key "$stem.json" >/dev/null
        done
}

backup_db tracker "$DATA_DIR/tracker/tracker.db"
backup_db ledger "$DATA_DIR/ledger/ledger.db"

echo "== attachments (by hash) =="
ATT_DIR="$DATA_DIR/tracker/attachments"
att_prefix="$(key_of attachments/)"
remote_att="$(list_keys "$att_prefix")"
printf '%s\n' "$remote_att" | sed "s|^$att_prefix||; /^$/d" | sort > "$WORK/remote-attachments"
# Only finished blobs: <2 hex>/<64 hex>. In-flight writes are dot-files ending .tmp.
if [ -d "$ATT_DIR" ]; then
    (cd "$ATT_DIR" && find . -mindepth 2 -maxdepth 2 -type f -regextype posix-extended \
        -regex '\./[0-9a-f]{2}/[0-9a-f]{64}' | sed 's|^\./||' | sort) > "$WORK/local-attachments"
else
    : > "$WORK/local-attachments"
fi
local_n="$(wc -l < "$WORK/local-attachments")"
new=0
bad=0
while IFS= read -r rel; do
    sha="${rel#*/}"
    if [ "${rel%%/*}" != "${sha:0:2}" ] || [ "$(sha256sum "$ATT_DIR/$rel" | cut -d' ' -f1)" != "$sha" ]; then
        echo "  BAD: $rel does not hash to its name; not uploaded" >&2
        bad=$((bad + 1))
        continue
    fi
    aws_ s3 cp --only-show-errors "$ATT_DIR/$rel" "s3://$BUCKET/$att_prefix$rel"
    new=$((new + 1))
done < <(comm -23 "$WORK/local-attachments" "$WORK/remote-attachments")
echo "  $local_n local, $new uploaded, $((local_n - new - bad)) already in the bucket"
[ "$bad" = 0 ] || die "$bad attachment(s) do not hash to their names (see above)"

echo "off-box backup OK"
