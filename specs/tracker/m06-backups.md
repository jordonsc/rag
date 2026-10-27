m06: backups
============
**State: Built and running on atlas, 2026-10-27** (`rag-t0002`; uncommitted). Acceptance 1 and 3 met on the first
run; 2 needs eight nights to show on live data (the prune is proven on seeded copies by `deploy/test-offbox.sh`).
Spec: [`master.md`](master.md), D19.

Once the specs and concepts live only in the tracker, a disk failure would lose them. This puts a copy off the box.


Work items
----------
| WP | Work | Size | Files |
|---|---|---|---|
| TB-01 | **The backup**: `deploy/backup-offbox.sh`: a consistent SQLite `.backup` of `tracker.db` and `ledger.db` (never a raw file copy of a live WAL database), compressed, uploaded to an S3 prefix set in the server's env file (`RAG_BACKUP__S3_URI`); the attachments synced by hash (only new files move); retention of 7 daily and 4 weekly copies of each database, pruned by the script. The owner names the bucket and the AWS credentials the server uses when this milestone is briefed | M | `deploy/backup-offbox.sh` (new) |
| TB-02 | **The timer**: `rag-backup.{service,timer}`, nightly, in the style of `rag-sync`; a failed run logs and exits non-zero so `systemctl --user status` shows it | S | `deploy/` |
| TB-03 | **Restore**: `deploy/RUNBOOK.md` gains *Restore from S3* (stop `rag-serve`, fetch and decompress, put the files in place, start, `make reconcile-ledger` and `make reconcile-tracker`), and is **rehearsed once** into a scratch directory, with the result written into the runbook | S | `deploy/RUNBOOK.md` |
| TB-04 | **Docs**: `CLAUDE.md` (the env key), `deploy/README.md` | S | as listed |


Acceptance
----------
1. The timer runs; the bucket holds the night's databases and the attachments; a second night uploads no attachment
   twice.
2. After eight nights, seven daily copies remain (and the weekly ones).
3. The rehearsed restore opens both databases and their row counts match the source at backup time.


As built (2026-10-27)
---------------------
* **Owner's ruling (2026-10-27)**: a new private bucket in ap-southeast-4, credentials from the AWS CLI profile
  already on atlas (`default`, the owner's IAM user). An earlier ruling the same day (js_web's `jsweb-atlas-backup`
  user) was withdrawn before anything of js_web's was changed. No key is stored for rag.
* **Bucket** `rag-atlas-backups` (ap-southeast-4): all public access blocked, bucket-owner-enforced, versioning on,
  SSE-S3 default encryption, noncurrent versions expire after 30 days, incomplete uploads abort after 7, as js_web's
  `js-web-atlas-backups`. Created with the CLI, not Terraform (rag has none); the commands are in the runbook.
* **Env keys** (`~/.config/rag/env`, read by the script itself, not sourced): `RAG_BACKUP__S3_URI`
  (`s3://rag-atlas-backups/atlas`), `RAG_BACKUP__AWS_PROFILE` (`default`), `RAG_BACKUP__AWS_REGION`
  (`ap-southeast-4`); optional `RAG_BACKUP__DATA_DIR`, `_KEEP_DAILY`, `_KEEP_WEEKLY`. The containers also receive
  them and ignore them (the config loader rejects no unknown key).
* **TB-01** `deploy/backup-offbox.sh`: `sqlite3 -readonly <db> .backup`, `PRAGMA integrity_check` on the copy (a
  failure stops the upload), a manifest `<db>-<YYYYMMDD>.json` (sha256, size, every table's row count), `zstd -10`,
  upload to `db/daily/`, size checked; the ISO week's first copy is server-side copied to
  `db/weekly/<db>-<GGGG>-W<VV>`; newest 7 daily and 4 weekly kept, by the stamp in the key. Attachments: keys under
  `attachments/` listed once, local blobs `<2>/<64 hex>` not in the list uploaded after checking their bytes hash
  to their name; `.tmp` in-flight files skipped; nothing deleted there. `flock` against two runs. A listing failure
  is fatal rather than read as an empty prefix.
* **TB-02** units are **`rag-backup-offbox.{service,timer}`**, not `rag-backup.*`: that name was already the
  same-box backup's (`backup-qdrant.sh`), and keeping them apart means a failed upload never costs the local copy.
  Timer 01:33 UTC + up to 2 min (clear of the 00:00 same-box backup, js_web's 03:00 CronJobs and the sync timers'
  minutes), `Persistent=true`; service `Nice=10`, idle I/O. `deploy.sh` installs both and enables the timer only
  where `RAG_BACKUP__S3_URI` is set, warning when `aws`/`sqlite3`/`zstd` is missing.
* **TB-03** `deploy/restore-offbox.sh DEST [STAMP]` fetches a daily or weekly copy into a scratch directory and
  verifies sha256, integrity and row counts against the manifest, and every attachment against its name; it refuses
  the live directories and a destination already holding a database. The runbook's *Restore from S3* moves the old
  files (including `-wal`/`-shm`) aside before putting the restored ones in place. Rehearsed 2026-10-27: counts
  matched (runbook).
* **Tests**: `deploy/test-offbox.sh`, 29 checks against a throwaway prefix with synthetic data, every version
  deleted afterwards: by-hash upload and no second upload (one S3 version per blob), 7/4 pruning of seeded copies
  with their manifests, the weekly kept within its week, daily and weekly restore; negatives for a row-count
  mismatch, a sha256 mismatch, a live or non-empty restore destination, a corrupt attachment (fails, not uploaded),
  no URI, an unreachable bucket, a missing database and a concurrent run. All pass; shellcheck clean.
* **Found on the way**: atlas had no `sqlite3` on the systemd PATH (only the Android SDK's, seen by interactive
  shells), so `rag-backup.service`'s nightly same-box copies were raw copies of live WAL databases. The distro
  `sqlite3` package is now installed. The runbook's *Restore the ledger DB* now removes the old `-wal`/`-shm` first.
* **First run** 2026-10-27 11:16 UTC: tracker 295 KB → 40 KB, ledger 44.4 MB → 9.0 MB, 0 attachments; 30 s CPU.
