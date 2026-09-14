// 04_users.js
//
// Migrates authenticator_andeuser (ande_db) -> dc_users (vitalflo_db).
//
// >>> IMPORTANT ASSUMPTIONS — review before running <<<
// - dc_users is a single flat table, but ande_db spreads a user's real name/
//   phone across role-specific attribute tables (authenticator_attributes for
//   patients, authenticator_clinicianattributes for clinicians,
//   authenticator_accountadminattributes has no name fields at all). This
//   script looks up whichever attributes table matches the user's role and
//   pulls f_name/l_name/phone from there. Admins with no attributes get
//   blank names — you may want to fill these in manually afterward.
// - "Role" (ut_id_fk) is determined by which subtype table the andeuser_ptr_id
//   appears in (accountadmin / clinician / patient / technician), checked in
//   that order. Users matching none of these default to 'patient' rather
//   than being skipped.
// - us_id_fk (status) is set from is_active: true -> 'active', false -> 'inactive'.
//   authenticator_patient.status ('unverified' etc.) is NOT consulted here —
//   add that override yourself if patients need finer-grained status.
// - userName is case-insensitively unique in MySQL's default collation, even
//   though it's only case-sensitively unique in the Postgres source. When a
//   case-insensitive duplicate is detected, later occurrences get a
//   "_duplicate_1", "_duplicate_2", ... suffix appended so no user is
//   silently dropped.
// - phone is not required to be unique (source data has legitimately shared
//   numbers, e.g. guardians/dependents). A placeholder is still used when
//   phone is completely missing, just for visibility (search 'NO_PHONE_').

const logger = require('../logger');
const { andeDb, getMysqlPool } = require('../db');
const { batchedFetch } = require('../batch');
const { recordMapping } = require('../idMap');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const STEP = 'users';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000', 10);

async function resolveRoleAndProfile(userId) {
  const admin = await andeDb.query(
    `SELECT * FROM authenticator_accountadmin WHERE andeuser_ptr_id = $1`, [userId]
  );
  if (admin.rows.length) return { role: 'account_admin', fName: '', lName: '', phone: null };

  const clinician = await andeDb.query(
    `SELECT c.*, ca.first_name, ca.last_name, ca.phone
     FROM authenticator_clinician c
     LEFT JOIN authenticator_clinicianattributes ca ON ca.clinician_id = c.andeuser_ptr_id
     WHERE c.andeuser_ptr_id = $1`, [userId]
  );
  if (clinician.rows.length) {
    const r = clinician.rows[0];
    return { role: 'clinician', fName: r.first_name || '', lName: r.last_name || '', phone: r.phone };
  }

  const patient = await andeDb.query(
    `SELECT p.*, pa.first_name, pa.last_name, pa.phone
     FROM authenticator_patient p
     LEFT JOIN authenticator_attributes pa ON pa.patient_id = p.andeuser_ptr_id
     WHERE p.andeuser_ptr_id = $1`, [userId]
  );
  if (patient.rows.length) {
    const r = patient.rows[0];
    return { role: 'patient', fName: r.first_name || '', lName: r.last_name || '', phone: r.phone };
  }

  const technician = await andeDb.query(
    `SELECT * FROM authenticator_technician WHERE andeuser_ptr_id = $1`, [userId]
  );
  if (technician.rows.length) return { role: 'technician', fName: '', lName: '', phone: null };

  // No matching subtype found — default to 'patient' rather than skipping
  // the user entirely. Adjust this default if a different role makes more
  // sense for your data.
  return { role: 'patient', fName: '', lName: '', phone: null };
}

async function run(lookups) {
  logger.step('Step 04: Migrating users');
  const pool = await getMysqlPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Users already migrated (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  const startAfter = checkpoint?.last_source_id || null;
  let rowsDone = checkpoint?.rows_done || 0;
  let skipped = 0;
  let unresolvedRole = 0;
  let renamedUsernames = 0;

  // Tracks how many times each lowercased username has been seen so far in
  // THIS run, so later duplicates (case-insensitive) get a "_duplicate_N"
  // suffix instead of failing the unique constraint. Loaded fresh each run —
  // if you re-run after a partial failure, existing rows in dc_users are
  // NOT re-scanned here, since the whole step is checkpointed as a unit.
  const usernameSeenCount = new Map();

  for await (const batch of batchedFetch(andeDb, {
    table: 'authenticator_andeuser',
    idColumn: 'id',
    batchSize: BATCH_SIZE,
    startAfterId: startAfter,
  })) {
    for (const u of batch) {
      const { role, fName, lName, phone } = await resolveRoleAndProfile(u.id);
      if (!role) {
        unresolvedRole++;
        continue;
      }

      const utId = lookups.userTypeMap.get(role);
      const usId = lookups.userStatusMap.get(u.is_active ? 'active' : 'inactive');

      // Resolve case-insensitive username collisions before insert, since
      // MySQL's default collation treats "John" and "john" as the same value
      // even though Postgres (source) does not.
      const lowerUsername = (u.username || '').toLowerCase();
      const seenCount = usernameSeenCount.get(lowerUsername) || 0;
      let finalUsername = u.username;
      if (seenCount > 0) {
        finalUsername = `${u.username}_duplicate_${seenCount}`;
        renamedUsernames++;
      }
      usernameSeenCount.set(lowerUsername, seenCount + 1);

      // dc_users requires a non-null phone, but NOT a unique one (source
      // data has legitimately shared numbers). Fall back to a
      // clearly-marked placeholder only when phone is missing entirely —
      // flag these for manual follow-up (search for 'NO_PHONE_' after migrating).
      const safePhone = phone || `NO_PHONE_${u.id}`;

      try {
        const [result] = await pool.query(
          `INSERT INTO dc_users
             (source_uuid, f_name, l_name, userName, email, phone, password,
              us_id_fk, ut_id_fk, reg_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            u.id, fName, lName, finalUsername, u.email || `no-email-${u.id}@placeholder.local`,
            safePhone, u.password, usId, utId, u.date_joined,
          ]
        );
        await recordMapping('ande_db', 'authenticator_andeuser', u.id, 'dc_users', result.insertId);
        rowsDone++;
      } catch (err) {
        // Most likely a UNIQUE constraint clash (email/username/phone
        // already used) — skip and count rather than crash the whole run.
        skipped++;
        logger.warn(`Skipped user (source id ${u.id}) due to insert error: ${err.code || err.message}`);
      }
    }
    await saveCheckpoint(STEP, batch[batch.length - 1].id, rowsDone);
    logger.progress('dc_users', rowsDone, null);
  }

  if (unresolvedRole) logger.info(`${unresolvedRole} users had no matching role subtype — defaulted to 'patient'.`);
  if (renamedUsernames) logger.warn(`${renamedUsernames} usernames renamed with '_duplicate_N' suffix due to case-insensitive collisions.`);
  if (skipped) logger.warn(`${skipped} users skipped due to constraint conflicts — review manually.`);
  await markComplete(STEP, rowsDone);
  logger.info(`Users migration complete: ${rowsDone} rows.`);
}

module.exports = { run };
