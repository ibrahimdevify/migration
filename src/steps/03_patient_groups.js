// 03_patient_groups.js
// Migrates: authenticator_patientgroup (+ ...groupattributes) -> vf_patient_group (+ ...group_attributes)
// Depends on: 02_accounts (needs vf_account IDs already mapped)

const logger = require('../logger');
const { andeDb, getMysqlPool } = require('../db');
const { batchedFetch } = require('../batch');
const { recordMapping, getMapping } = require('../idMap');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const STEP = 'patient_groups';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000', 10);

async function run() {
  logger.step('Step 03: Migrating patient groups');
  const pool = await getMysqlPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Patient groups already migrated (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  const startAfter = checkpoint?.last_source_id || null;
  let rowsDone = checkpoint?.rows_done || 0;
  let skipped = 0;

  for await (const batch of batchedFetch(andeDb, {
    table: 'authenticator_patientgroup',
    idColumn: 'id',
    batchSize: BATCH_SIZE,
    startAfterId: startAfter,
  })) {
    for (const pg of batch) {
      const newAccountId = await getMapping('ande_db', 'authenticator_account', pg.account_id, 'vf_account');
      if (!newAccountId) {
        skipped++;
        continue; // orphaned reference to an account that wasn't migrated — logged by count only
      }

      const [result] = await pool.query(
        `INSERT INTO vf_patient_group (name, account_id, creation_date) VALUES (?, ?, ?)`,
        [pg.name, newAccountId, pg.creation_date]
      );
      const newId = result.insertId;
      await recordMapping('ande_db', 'authenticator_patientgroup', pg.id, 'vf_patient_group', newId);

      const { rows: attrRows } = await andeDb.query(
        `SELECT * FROM authenticator_patientgroupattributes WHERE group_id = $1 LIMIT 1`,
        [pg.id]
      );
      if (attrRows.length) {
        await pool.query(
          `INSERT INTO vf_patient_group_attributes (group_id, extra) VALUES (?, ?)`,
          [newId, attrRows[0].extra ? JSON.stringify(attrRows[0].extra) : null]
        );
      }
      rowsDone++;
    }
    await saveCheckpoint(STEP, batch[batch.length - 1].id, rowsDone);
    logger.progress('vf_patient_group', rowsDone, null);
  }

  if (skipped) logger.warn(`Skipped ${skipped} patient groups with unresolved account_id.`);
  await markComplete(STEP, rowsDone);
  logger.info(`Patient groups migration complete: ${rowsDone} rows.`);
}

module.exports = { run };
