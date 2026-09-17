// 11_sync_old_db_users.js
//
// Syncs dc_users from the OLD merged database (currently connected to the
// live/real project) into the NEW one, so real production growth since the
// old DB's go-live isn't lost.
//
// Matching strategy (in order):
//   1. source_uuid — both databases were originally migrated from
//      ande_db/authenticator_andeuser, so a matching UUID is the strongest
//      possible signal these are the same real person.
//   2. email / phone — fallback for rows with no source_uuid.
//   3. Create new — a real new signup since the old DB's go-live. Copied
//      across as-is, INCLUDING ut_id_fk/us_id_fk, since both databases now
//      share the same real lookup-table pattern (confirmed: technician=1,
//      admin=2, clinician=3, patient=4, account_admin=5, clinician_admin=6;
//      active=1, inactive=2, deleted=3, pending=4) — no remapping needed.
//
// FLAGGED, NOT AUTO-EXCLUDED: two known system/demo accounts in the old DB
// (user_id 1 "System Admin", user_id 2 "Sarah Johnson"/doctor@vitalflow.com)
// have source_uuid = NULL and look like manually-created scaffolding, not
// real migrated patients. This script does NOT special-case them — if they
// don't match anything in the new DB by email, they'll be created like any
// other "new" user. Review the log's created-user list afterward and
// manually remove any that turn out to be test/demo accounts, since this
// script has no reliable way to distinguish "new real user" from
// "old system's test account" on its own.
//
// Every row (matched or newly created) gets an entry in _migration_id_map:
//   ('old_merged_db', 'dc_users', <old user_id>, 'dc_users', <new user_id>)
// Later steps (clinical data sync) use this mapping to resolve users.

const logger = require('../logger');
const { getMysqlPool, getOldMergeDbPool } = require('../db');
const { recordMapping, getMapping } = require('../idMap');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const STEP = 'sync_old_db_users';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000', 10);

async function findMatchInNewDb(pool, oldUser) {
  if (oldUser.source_uuid) {
    const [rows] = await pool.query(
      `SELECT user_id FROM dc_users WHERE source_uuid = ? LIMIT 1`,
      [oldUser.source_uuid]
    );
    if (rows.length) return rows[0].user_id;
  }
  if (oldUser.email) {
    const [rows] = await pool.query(
      `SELECT user_id FROM dc_users WHERE email = ? LIMIT 1`, [oldUser.email]
    );
    if (rows.length) return rows[0].user_id;
  }
  if (oldUser.phone) {
    const [rows] = await pool.query(
      `SELECT user_id FROM dc_users WHERE phone = ? LIMIT 1`, [oldUser.phone]
    );
    if (rows.length) return rows[0].user_id;
  }
  return null;
}

async function run() {
  logger.step('Step 11: Syncing users from OLD live database into NEW database');
  const pool = await getMysqlPool();
  const oldPool = await getOldMergeDbPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Old-DB user sync already complete (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  let rowsDone = checkpoint?.rows_done || 0;
  let matched = 0, created = 0;
  const createdUserIds = []; // for the manual-review log at the end

  let lastId = checkpoint?.last_source_id ? parseInt(checkpoint.last_source_id, 10) : 0;

  while (true) {
    const [oldUsers] = await oldPool.query(
      `SELECT * FROM dc_users WHERE user_id > ? ORDER BY user_id ASC LIMIT ?`,
      [lastId, BATCH_SIZE]
    );
    if (oldUsers.length === 0) break;

    for (const oldUser of oldUsers) {
      // Skip if already synced in a previous run.
      const existingMapping = await getMapping('old_merged_db', 'dc_users', oldUser.user_id, 'dc_users');
      if (existingMapping) { rowsDone++; continue; }

      let newUserId = await findMatchInNewDb(pool, oldUser);

      if (newUserId) {
        matched++;
      } else {
        // Genuinely new — create it, copying fields as-is (including
        // ut_id_fk/us_id_fk, which use the same pattern in both DBs).
        try {
          const [result] = await pool.query(
            `INSERT INTO dc_users
               (source_uuid, f_name, l_name, userName, email, phone, password,
                profile_pic, us_id_fk, ut_id_fk, is_guardian, is_availible,
                is_profile_completed, reg_date, profile_update_date,
                is_monthly_plan_reactivated, is_rpm_allow)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              oldUser.source_uuid, oldUser.f_name, oldUser.l_name, oldUser.userName,
              oldUser.email, oldUser.phone, oldUser.password, oldUser.profile_pic,
              oldUser.us_id_fk, oldUser.ut_id_fk, !!oldUser.is_guardian,
              !!oldUser.is_availible, !!oldUser.is_profile_completed,
              oldUser.reg_date, oldUser.profile_update_date,
              !!oldUser.is_monthly_plan_reactivated, !!oldUser.is_rpm_allow,
            ]
          );
          newUserId = result.insertId;
          created++;
          createdUserIds.push({ oldId: oldUser.user_id, newId: newUserId });
        } catch (err) {
          logger.warn(`Skipped creating user (old id ${oldUser.user_id}): ${err.code || err.message}`);
          continue;
        }
      }

      await recordMapping('old_merged_db', 'dc_users', oldUser.user_id, 'dc_users', newUserId);
      rowsDone++;
    }

    lastId = oldUsers[oldUsers.length - 1].user_id;
    await saveCheckpoint(STEP, lastId, rowsDone);
    logger.progress('old_db_users_synced', rowsDone, null);

    if (oldUsers.length < BATCH_SIZE) break;
  }

  logger.info(`Old-DB user sync complete: ${rowsDone} total, ${matched} matched to existing, ${created} newly created.`);
  if (createdUserIds.length > 0) {
    logger.warn(`${createdUserIds.length} new users created — IDs (old -> new): ` +
      createdUserIds.slice(0, 20).map(u => `${u.oldId}->${u.newId}`).join(', ') +
      (createdUserIds.length > 20 ? ` ... and ${createdUserIds.length - 20} more` : '') +
      `. Review these manually if you suspect any are test/system accounts (e.g. old user_id 1 or 2).`);
  }
  await markComplete(STEP, rowsDone);
}

module.exports = { run };
