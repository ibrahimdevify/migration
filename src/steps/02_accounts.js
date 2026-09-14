// 02_accounts.js
// Migrates: authenticator_account (+ authenticator_accountattributes) -> vf_account (+ vf_account_attributes)

const logger = require('../logger');
const { andeDb, getMysqlPool } = require('../db');
const { batchedFetch } = require('../batch');
const { recordMapping } = require('../idMap');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const STEP = 'accounts';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000', 10);

async function run() {
  logger.step('Step 02: Migrating accounts');
  const pool = await getMysqlPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Accounts already migrated (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  const startAfter = checkpoint?.last_source_id || null;
  let rowsDone = checkpoint?.rows_done || 0;

  // Note: authenticator_account.id is a UUID, so ordering by it doesn't
  // reflect creation order — that's fine here since we just need a stable,
  // deterministic pagination cursor, not chronological order.
  for await (const batch of batchedFetch(andeDb, {
    table: 'authenticator_account',
    idColumn: 'id',
    batchSize: BATCH_SIZE,
    startAfterId: startAfter,
  })) {
    for (const acc of batch) {
      const [result] = await pool.query(
        `INSERT INTO vf_account (name, creation_date) VALUES (?, ?)`,
        [acc.name, acc.creation_date]
      );
      const newId = result.insertId;
      await recordMapping('ande_db', 'authenticator_account', acc.id, 'vf_account', newId);

      // Pull matching attributes row, if present
      const { rows: attrRows } = await andeDb.query(
        `SELECT * FROM authenticator_accountattributes WHERE account_id = $1 LIMIT 1`,
        [acc.id]
      );
      if (attrRows.length) {
        const attr = attrRows[0];
        await pool.query(
          `INSERT INTO vf_account_attributes
             (account_id, breezometer, awair, bronchodilator_responsiveness_testing,
              clinical_decision_support_flowchart, extra)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            newId,
            !!attr.breezometer,
            !!attr.awair,
            !!attr.bronchodilator_responsiveness_testing,
            !!attr.clinical_decision_support_flowchart,
            attr.extra ? JSON.stringify(attr.extra) : null,
          ]
        );
      }
      rowsDone++;
    }
    await saveCheckpoint(STEP, batch[batch.length - 1].id, rowsDone);
    logger.progress('vf_account', rowsDone, null);
  }

  await markComplete(STEP, rowsDone);
  logger.info(`Accounts migration complete: ${rowsDone} rows.`);
}

module.exports = { run };
