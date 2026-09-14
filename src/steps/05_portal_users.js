// 05_portal_users.js
//
// portal_db's clinical tables (dashboard_observation, dashboard_spirometry,
// etc.) all hang off dashboard_user.id. This step ensures EVERY
// dashboard_user has a corresponding dc_users row to attach to, using a
// three-tier matching strategy so no clinical data is ever orphaned:
//
//   1. UUID match: dashboard_user.user_id is a 36-char string, the same
//      shape as authenticator_andeuser.id (ande_db). We check our existing
//      ID map for that UUID first — this is the most reliable match.
//   2. Email/phone match: falls back to matching the linked
//      dashboard_administrator's email/phone against existing dc_users.
//   3. Create new: if neither matches, a new dc_users row is created from
//      whatever portal_db data is available, so the row is never dropped.
//      These are flagged (source_uuid prefixed 'PORTAL_ONLY_') for manual
//      review/merge later, since they may be duplicates of an existing
//      person under a different identity.
//
// Regardless of which tier resolves a user, a mapping is recorded:
//   ('portal_db', 'dashboard_user', <dashboard_user.id>, 'dc_users', <id>)
// Later clinical-data steps use THIS mapping (not the ande_db one) to
// resolve user_id references.
//
// Newly-created (Tier 3) users are identifiable afterward by:
//   WHERE password = 'MIGRATED_NEEDS_PASSWORD_RESET'
// (source_uuid itself is just the raw portal-side UUID, since the column
// is VARCHAR(36) with no room for a prefix).

const logger = require('../logger');
const { portalDb, getMysqlPool } = require('../db');
const { batchedFetch } = require('../batch');
const { recordMapping, getMapping } = require('../idMap');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const STEP = 'portal_users';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000', 10);

async function findExistingDcUserByContact(pool, email, phone) {
  if (email) {
    const [rows] = await pool.query(`SELECT user_id FROM dc_users WHERE email = ? LIMIT 1`, [email]);
    if (rows.length) return rows[0].user_id;
  }
  if (phone) {
    const [rows] = await pool.query(`SELECT user_id FROM dc_users WHERE phone = ? LIMIT 1`, [phone]);
    if (rows.length) return rows[0].user_id;
  }
  return null;
}

async function run(lookups) {
  logger.step('Step 05: Migrating portal_db users (linking to dc_users)');
  const pool = await getMysqlPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Portal users already linked (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  const startAfter = checkpoint?.last_source_id || null;
  let rowsDone = checkpoint?.rows_done || 0;
  let matchedByUuid = 0;
  let matchedByContact = 0;
  let created = 0;

  const patientTypeId = lookups.userTypeMap.get('patient');
  const clinicianTypeId = lookups.userTypeMap.get('clinician');
  const activeStatusId = lookups.userStatusMap.get('active');

  for await (const batch of batchedFetch(portalDb, {
    table: 'dashboard_user',
    idColumn: 'id',
    batchSize: BATCH_SIZE,
    startAfterId: startAfter,
  })) {
    for (const du of batch) {
      let dcUserId = null;

      // Tier 1: UUID match against already-migrated ande_db users
      dcUserId = await getMapping('ande_db', 'authenticator_andeuser', du.user_id, 'dc_users');
      if (dcUserId) {
        matchedByUuid++;
      } else {
        // Tier 2: email/phone match via the linked administrator record
        const adminResult = await portalDb.query(
          `SELECT email, phone FROM dashboard_administrator WHERE id = $1`,
          [du.administrator_id]
        );
        const admin = adminResult.rows[0];
        if (admin) {
          dcUserId = await findExistingDcUserByContact(pool, admin.email, admin.phone);
          if (dcUserId) matchedByContact++;
        }

        // Tier 3: create a new dc_users row rather than drop this record
        if (!dcUserId) {
          const utId = du.is_patient ? patientTypeId : clinicianTypeId;
          const placeholderPhone = (admin && admin.phone) || `NO_PHONE_PORTAL_${du.id}`;
          const placeholderEmail = (admin && admin.email) || `no-email-portal-${du.id}@placeholder.local`;
          const placeholderUsername = `portal_user_${du.id}`;

          const [result] = await pool.query(
            `INSERT INTO dc_users
               (source_uuid, f_name, l_name, userName, email, phone, password,
                us_id_fk, ut_id_fk, reg_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              du.user_id, '', '', placeholderUsername, placeholderEmail,
              placeholderPhone, 'MIGRATED_NEEDS_PASSWORD_RESET', activeStatusId, utId, new Date(),
            ]
          );
          dcUserId = result.insertId;
          created++;
        }
      }

      await recordMapping('portal_db', 'dashboard_user', du.id, 'dc_users', dcUserId);
      rowsDone++;
    }
    await saveCheckpoint(STEP, batch[batch.length - 1].id, rowsDone);
    logger.progress('portal_users_linked', rowsDone, null);
  }

  logger.info(`Portal user linking complete: ${rowsDone} total. ` +
    `${matchedByUuid} matched by UUID, ${matchedByContact} matched by email/phone, ${created} newly created.`);
  if (created > 0) {
    logger.warn(`${created} portal_db users had no match in ande_db and were created fresh — ` +
      `these may be duplicates of an existing person. Review rows in dc_users where ` +
      `password = 'MIGRATED_NEEDS_PASSWORD_RESET' (these accounts also cannot log in ` +
      `until a real password is set).`);
  }
  await markComplete(STEP, rowsDone);
}

module.exports = { run };
