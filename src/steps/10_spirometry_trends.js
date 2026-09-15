// 10_spirometry_trends.js
//
// portal_spirometry_trends has no direct source table — it's derived here
// from portal_spirometry (already migrated in step clinical_data), one
// trends row per spirometry test (same granularity, not aggregated).
// user_id and dbdate come from the linked portal_observation.
//
// This step reads and writes entirely within vitalflo_db — it does NOT
// query ande_db or portal_db at all, since everything needed is already
// in the target database from earlier steps.

const logger = require('../logger');
const { getMysqlPool } = require('../db');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const STEP = 'spirometry_trends';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000', 10);

async function run() {
  logger.step('Step 10: Deriving portal_spirometry_trends from portal_spirometry');
  const pool = await getMysqlPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Spirometry trends already derived (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  let rowsDone = checkpoint?.rows_done || 0;
  let lastId = checkpoint?.last_source_id ? parseInt(checkpoint.last_source_id, 10) : 0;

  while (true) {
    const [rows] = await pool.query(
      `SELECT ps.id, ps.fev1, ps.fvc, ps.pefr, ps.fef2575, ps.fev1_perc,
              po.user_id, po.dbdate
       FROM portal_spirometry ps
       JOIN portal_observation po ON po.id = ps.observation_id
       WHERE ps.id > ?
       ORDER BY ps.id ASC
       LIMIT ?`,
      [lastId, BATCH_SIZE]
    );
    if (rows.length === 0) break;

    // Bulk insert for speed, same pattern as the clinical_data optimization.
    const values = rows.map(r => [r.user_id, r.dbdate, r.fev1, r.fvc, r.pefr, r.fef2575, r.fev1_perc]);
    await pool.query(
      `INSERT INTO portal_spirometry_trends (user_id, dbdate, fev1, fvc, pefr, fef2575, fev1_perc) VALUES ?`,
      [values]
    );
    rowsDone += rows.length;
    lastId = rows[rows.length - 1].id;

    await saveCheckpoint(STEP, lastId, rowsDone);
    logger.progress('portal_spirometry_trends', rowsDone, null);

    if (rows.length < BATCH_SIZE) break;
  }

  logger.info(`Spirometry trends complete: ${rowsDone} rows.`);
  await markComplete(STEP, rowsDone);
}

module.exports = { run };
