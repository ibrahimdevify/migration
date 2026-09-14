# VitalFlo Migration Script

Migrates data from `ande_db` (PostgreSQL) and `portal_db` (PostgreSQL) into
the unified `vitalflo_db` (MySQL) schema.

## ⚠️ Scope note — read this first

This script currently implements, end-to-end:

- Lookup tables (`dc_user_type`, `dc_user_status`, `dc_gender`, `dc_martial_status`)
- `authenticator_account` → `vf_account` (+ attributes)
- `authenticator_patientgroup` → `vf_patient_group` (+ attributes)
- `authenticator_andeuser` (+ role subtype tables) → `dc_users`

It does **not** yet cover `dc_doctor_details`, `dc_patient_details`,
`vf_attributes`, or any of the `portal_*` clinical tables (spirometry,
observations, alerts, etc.), or anything from `portal_db`. Those need
business-logic decisions (e.g. how a `dashboard_user` in `portal_db` is
matched to the correct `dc_users` row — by email? by an external ID?) that
should be confirmed before writing that code, so they aren't guessed at
here. The framework (batching, checkpoints, ID mapping, safe logging) is
fully built and ready to extend — new steps just need to follow the same
pattern as `02_accounts.js` / `03_patient_groups.js`.

## Safety principles built in

- **No PII in logs.** `logger.js` only ever prints counts and IDs.
- **Resumable.** Progress is checkpointed in `_migration_checkpoint`
  (a table inside `vitalflo_db`), so a crash or Ctrl+C doesn't force a
  restart from zero — just re-run the same command.
- **ID mapping preserved.** `_migration_id_map` (also inside `vitalflo_db`)
  records every old-ID → new-ID pair, so foreign keys are rewritten
  correctly and the mapping stays inspectable/auditable afterward.
- **Idempotent-ish inserts.** Re-running a completed step skips it
  entirely rather than duplicating rows.
- **Batched reads.** Uses keyset pagination (not `OFFSET`), so it stays
  fast and memory-safe even on very large tables.

## Step-by-step: how to run this

### 1. Run this ON THE VPS, not your laptop

Copy this whole `migration/` folder onto the VPS (e.g. via `scp` or `git`),
since both source databases already live there — this avoids sending
sensitive data over the public internet and is dramatically faster.

```bash
scp -r migration/ user@31.97.71.250:~/migration
ssh user@31.97.71.250
cd ~/migration
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
nano .env
```

Fill in the real connection strings for `ANDE_DB_URL`, `PORTAL_DB_URL`,
and `VITALFLO_DB_URL`. Since you're running on the VPS itself, use
`127.0.0.1` as the host for all three (not the public IP) — this avoids
needing to open any database ports externally at all.

**Never commit `.env` to git.**

### 4. Take fresh backups (if you haven't already today)

```bash
pg_dump -U postgres -h 127.0.0.1 -d ande_db -F c -f ~/ande_db_backup.dump
pg_dump -U postgres -h 127.0.0.1 -d portal_db -F c -f ~/portal_db_backup.dump
mysqldump -u root -p --single-transaction vitalflo_db > ~/vitalflo_db_backup.sql
```

### 5. Dry run first

```bash
npm run migrate:dry
```

This connects to all three databases and confirms setup without writing
any data — confirms your `.env` and network access are correct.

### 6. Run a single step first, on the smallest table

```bash
node src/migrate.js --only=lookups
node src/migrate.js --only=accounts
```

Check the row counts printed and spot-check `vf_account` in MySQL
directly before continuing.

### 7. Run the full migration

```bash
npm run migrate
```

Progress prints as `table: done/total` — safe to leave running in the
background:

```bash
nohup npm run migrate > migration.log 2>&1 &
```

(Even in `migration.log`, only counts/IDs are written — never PII.)

### 8. If it stops or crashes

Just run the same command again:

```bash
npm run migrate
```

Completed steps are skipped; in-progress steps resume from their last
checkpointed ID, not from zero.

### 9. Verify afterward

```bash
node src/verify.js
```

Compares row counts between source and target tables and flags any
mismatch for manual review (some mismatch is expected/fine if rows were
intentionally skipped due to conflicts — check the migration log's
"skipped" warnings for those cases).

### 10. Clean up

Once verified, drop the `_migration_id_map` / `_migration_checkpoint`
tables if you don't need the audit trail anymore, and securely delete
any `.dump`/`.sql` backups you no longer need — or move them to encrypted
long-term storage if you do.

## Extending this to the remaining tables

Follow the pattern in `src/steps/02_accounts.js`:
1. Batch-fetch from the source table via `batchedFetch()`.
2. Look up any parent IDs via `getMapping()`.
3. Insert into the MySQL target table.
4. Record the new ID via `recordMapping()`.
5. Checkpoint progress via `saveCheckpoint()` after each batch.
6. Register the new step in `src/migrate.js`'s `STEPS` array.
