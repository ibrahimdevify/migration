// 07_heart_rate.js
//
// Migrates dashboard_heartrateobservations -> portal_heart_rate_observations
// (+ a single portal_heart_rate_point per observation).
//
// NOTE ON SHAPE MISMATCH: dashboard_heartrateobservations stores ONE summary
// heart_rate value per observation window (begin_time -> end_time), not a
// time-series of points. The target schema's portal_heart_rate_point table
// is built for a point series (value + time per point). Since there's no
// real point series in the source, this migration creates exactly one
// point per observation, using the single heart_rate value and time = 0
// (a placeholder position, since there's no "time within the window" to
// give it). If your application actually expects multiple points per
// observation, this will need revisiting once real time-series heart rate
// data is available.

const logger = require('../logger');
const { portalDb, getMysqlPool } = require('../db');
const { batchedFetch } = require('../batch');
const { recordMapping, getMapping } = require('../idMap');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const STEP = 'heart_rate';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000', 10);

async function run() {
  logger.step('Step 07: Migrating heart rate observations');
  const pool = await getMysqlPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Heart rate already migrated (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  let rowsDone = checkpoint?.rows_done || 0;
  let skippedNoUser = 0;
  let pointRows = 0;

  for await (const batch of batchedFetch(portalDb, {
    table: 'dashboard_heartrateobservations',
    idColumn: 'id',
    batchSize: BATCH_SIZE,
    startAfterId: checkpoint?.last_source_id || null,
  })) {
    for (const hr of batch) {
      const dcUserId = await getMapping('portal_db', 'dashboard_user', hr.user_id, 'dc_users');
      if (!dcUserId) { skippedNoUser++; continue; }

      const [result] = await pool.query(
        `INSERT INTO portal_heart_rate_observations (dbdate, user_id) VALUES (?, ?)`,
        [hr.dbdate, dcUserId]
      );
      const newObsId = result.insertId;
      await recordMapping('portal_db', 'dashboard_heartrateobservations', hr.id,
        'portal_heart_rate_observations', newObsId);

      if (hr.heart_rate !== null && hr.heart_rate !== undefined) {
        await pool.query(
          `INSERT INTO portal_heart_rate_point (value, time, observation_id) VALUES (?, ?, ?)`,
          [hr.heart_rate, 0, newObsId]
        );
        pointRows++;
      }

      rowsDone++;
    }
    await saveCheckpoint(STEP, batch[batch.length - 1].id, rowsDone);
    logger.progress('portal_heart_rate_observations', rowsDone, null);
  }

  if (skippedNoUser) logger.warn(`${skippedNoUser} heart rate observations skipped — no resolvable user.`);
  logger.info(`Heart rate complete: ${rowsDone} observations, ${pointRows} points.`);
  await markComplete(STEP, rowsDone);
}

module.exports = { run };
