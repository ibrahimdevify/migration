// 08_predicted_values.js
//
// portal_db stores GLI (Global Lung Function Initiative) predicted-value
// stats as inline columns on dashboard_spirometry (gli2012_fev1_predicted,
// gli2012_fev1_lln, gli2012_fev1_zscore, and similarly for fvc, fev1fvc,
// fef2575). The target schema instead wants one ROW per variable in
// portal_predicted_value. This step explodes each spirometry record's GLI
// columns into up to 4 separate rows (one per variable), attached to the
// observation's user.
//
// percent_predicted is computed as (actual / predicted * 100) when both the
// actual measured value and the predicted value are available; left NULL
// otherwise (e.g. for FEV1/FVC, since there's no direct "actual fev1/fvc
// ratio" column to divide against cleanly — only fev1 and fvc separately).
//
// Variable name format: 'FEV1', 'FVC', 'FEV1/FVC', 'FEF25-75' — this exact
// casing/punctuation was confirmed against real rows in the production
// database's portal_predicted_value table before writing this step.

const logger = require('../logger');
const { portalDb, getMysqlPool } = require('../db');
const { batchedFetch } = require('../batch');
const { getMapping } = require('../idMap');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const STEP = 'predicted_values';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000', 10);

function pctPredicted(actual, predicted) {
  if (actual === null || actual === undefined) return null;
  if (predicted === null || predicted === undefined || predicted === 0) return null;
  return (actual / predicted) * 100;
}

// Each entry: [variableName, lln, predicted, zscore, actualValueForPct]
// Variable name strings match the format already used in the production
// database (confirmed by querying real portal_predicted_value rows):
// 'FEV1', 'FVC', 'FEV1/FVC', 'FEF25-75' — uppercase, with a slash and a
// hyphen respectively. This is NOT the same as a lowercased/concatenated
// version — match it exactly so the API layer's queries (which expect this
// real format) find the data.
function buildVariableRows(spiro) {
  return [
    ['FEV1', spiro.gli2012_fev1_lln, spiro.gli2012_fev1_predicted, spiro.gli2012_fev1_zscore, spiro.fev1],
    ['FVC', spiro.gli2012_fvc_lln, spiro.gli2012_fvc_predicted, spiro.gli2012_fvc_zscore, spiro.fvc],
    ['FEV1/FVC', spiro.gli2012_fev1fvc_lln, spiro.gli2012_fev1fvc_predicted, spiro.gli2012_fev1fvc_zscore, null],
    ['FEF25-75', spiro.gli2012_fef2575_lln, spiro.gli2012_fef2575_predicted, spiro.gli2012_fef2575_zscore, spiro.fef2575],
  ];
}

async function run() {
  logger.step('Step 08: Exploding GLI predicted values from spirometry');
  const pool = await getMysqlPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Predicted values already migrated (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  let rowsDone = checkpoint?.rows_done || 0;
  let skippedNoUser = 0;
  let skippedNoObservation = 0;

  for await (const batch of batchedFetch(portalDb, {
    table: 'dashboard_spirometry',
    idColumn: 'id',
    batchSize: BATCH_SIZE,
    startAfterId: checkpoint?.last_source_id || null,
  })) {
    for (const spiro of batch) {
      if (!spiro.observation_id) { skippedNoObservation++; continue; }

      const obsResult = await portalDb.query(
        `SELECT user_id, dbdate FROM dashboard_observation WHERE id = $1`, [spiro.observation_id]
      );
      const obs = obsResult.rows[0];
      if (!obs) { skippedNoObservation++; continue; }

      const dcUserId = await getMapping('portal_db', 'dashboard_user', obs.user_id, 'dc_users');
      if (!dcUserId) { skippedNoUser++; continue; }

      for (const [variable, lln, predicted, zscore, actual] of buildVariableRows(spiro)) {
        if (lln === null && predicted === null && zscore === null) continue; // nothing to record
        await pool.query(
          `INSERT INTO portal_predicted_value
             (user_id, variable, predicted, lln, uln, z_score, percent_predicted, created)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [dcUserId, variable, predicted, lln, null, zscore, pctPredicted(actual, predicted), obs.dbdate]
        );
      }

      rowsDone++;
    }
    await saveCheckpoint(STEP, batch[batch.length - 1].id, rowsDone);
    logger.progress('portal_predicted_value (source spirometry rows processed)', rowsDone, null);
  }

  if (skippedNoObservation) logger.warn(`${skippedNoObservation} spirometry rows skipped — no linked observation.`);
  if (skippedNoUser) logger.warn(`${skippedNoUser} spirometry rows skipped — no resolvable user.`);
  logger.info(`Predicted values complete: ${rowsDone} spirometry rows processed (each may yield up to 4 predicted-value rows).`);
  await markComplete(STEP, rowsDone);
}

module.exports = { run };
