// 08_predicted_values.js
//
// Computes GLI-2012 predicted values from dashboard_spirometry rows using
// the same formula Django's `spiref_predicted` uses, and stores one row
// per (observation, variable) in portal_predicted_value.
//
// Formula (GLI-2012, LMS method):
//   z_score           = ((observed / M)^L − 1) / (L × S)
//   LLN               = M × (1 + L × S × (−1.645))^(1 / L)
//   predicted         = M
//   percent_predicted = (observed / M) × 100
//
// M, S, L come from the GLI-2012 coefficient table (same source rspiro uses).
//
// Inputs (matching Django's rules exactly):
//   age       = currentYear − birthYear (integer, no birthday correction)
//   height    = observation.height first, then attributes.height (cm)
//   sex       = 1 if gender is 'M', 2 if 'F'
//   ethnicity = lookup_table mapped to 1..5 (unknown → 5)
//
// Variables stored: FEV1, FVC, FEV1/FVC, FEF25-75

const logger = require('../logger');
const { portalDb, getMysqlPool } = require('../db');
const { batchedFetch } = require('../batch');
const { getMapping } = require('../idMap');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');
const { calculateGli2012 } = require('../../src/helpers/gli2012');
const { normalizeSpirometryValue } = require('../../src/helpers/spirometry');

const STEP = 'predicted_values';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000', 10);

// ─────────────────────────────────────────────────────────────
// Demographics helpers — replicate Django's input rules
// ─────────────────────────────────────────────────────────────

/**
 * Build GLI-2012 demographics from a Postgres observation row + its user's
 * attributes. Returns { age, height, sex, ethnicity }.
 */
function buildDemographics(observation, attributes) {
  const attrs = attributes || {};

  // Height: observation.height preferred, else attributes.height
  const obsHeight = Number(observation?.height);
  const attrHeight = Number(attrs.height);
  const height =
    obsHeight > 0 ? obsHeight :
    attrHeight > 0 ? attrHeight :
    170;

  // Age: integer years, currentYear − birthYear
  const dobYear = attrs.dob ? new Date(attrs.dob).getFullYear() : null;
  const age = dobYear ? (new Date().getFullYear() - dobYear) : 40;

  // Sex: 1 = male, 2 = female (Django: 'F' → female, else male)
  const sex = String(attrs.gender || '').toUpperCase() === 'F' ? 2 : 1;

  // Ethnicity: from lookup_table
  const ethMap = {
    Caucasian: 1,
    AfricanAmerican: 2,
    NEAsian: 3,
    SEAsian: 4,
  };
  const ethnicity = ethMap[attrs.lookup_table] || 5;

  return { age, height, sex, ethnicity };
}

/**
 * Fetch the demographic record for a patient. Adjust the table/column names
 * to match your portal_db schema. Common layouts:
 *   - authenticator_attributes (older)
 *   - dashboard_user has no demographics; join via user_id UUID
 */
async function fetchAttributes(userRow) {
  // Try dashboard_attributes first, then fall back to authenticator_attributes
  try {
    const res = await portalDb.query(
      `SELECT dob, gender, lookup_table, height
       FROM authenticator_attributes
       WHERE patient_id = $1
       LIMIT 1`,
      [userRow.uuid]
    );
    if (res.rows[0]) return res.rows[0];
  } catch (_err) {
    // Table may not exist under this name; ignore and try the next
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Observed values — best-of-trials per variable
// ─────────────────────────────────────────────────────────────

/**
 * Fetch all spirometry trials for an observation, normalize ×100 → real,
 * take max per variable, and compute the FEV1/FVC ratio.
 */
async function getBestObservedValues(observationId) {
  const res = await portalDb.query(
    `SELECT fev1, fvc, pefr, fef2575, fev6
     FROM dashboard_spirometry
     WHERE observation_id = $1`,
    [observationId]
  );

  if (res.rows.length === 0) return null;

  const normalized = res.rows.map((r) => ({
    fev1: normalizeSpirometryValue(r.fev1),
    fvc: normalizeSpirometryValue(r.fvc),
    pefr: normalizeSpirometryValue(r.pefr),
    fef2575: normalizeSpirometryValue(r.fef2575),
    fev6: normalizeSpirometryValue(r.fev6),
  }));

  const maxOrNull = (key) => {
    const vals = normalized.map((r) => r[key]).filter((v) => v !== null);
    return vals.length > 0 ? Math.max(...vals) : null;
  };

  const fev1 = maxOrNull('fev1');
  const fvc = maxOrNull('fvc');
  const fev1Fvc = fev1 && fvc ? Number((fev1 / fvc).toFixed(2)) : null;

  return {
    FEV1: fev1,
    FVC: fvc,
    FEV1FVC: fev1Fvc,
    FEF2575: maxOrNull('fef2575'),
  };
}

// ─────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────

function buildVariableRows(observed, demo) {
  // Returns an array of { variable, predicted, lln, z_score, percent_predicted }
  // where each value comes from the GLI-2012 calculation.
  return [
    { variable: 'FEV1',     gli: calculateGli2012(observed.FEV1, demo, 'FEV1') },
    { variable: 'FVC',      gli: calculateGli2012(observed.FVC, demo, 'FVC') },
    { variable: 'FEV1/FVC', gli: calculateGli2012(observed.FEV1FVC, demo, 'FEV1FVC') },
    { variable: 'FEF25-75', gli: calculateGli2012(observed.FEF2575, demo, 'FEF2575') },
  ].filter(({ gli }) => gli && gli.predicted !== null);
}

// ─────────────────────────────────────────────────────────────
// Migration entry point
// ─────────────────────────────────────────────────────────────

async function run() {
  logger.step('Step 08: Computing GLI-2012 predicted values into portal_predicted_value');
  const pool = await getMysqlPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Predicted values already migrated (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }

  let rowsDone = checkpoint?.rows_done || 0;
  let skippedNoObservation = 0;
  let skippedNoUser = 0;
  let skippedNoDemographics = 0;
  let skippedNoObserved = 0;

  for await (const batch of batchedFetch(portalDb, {
    table: 'dashboard_observation',
    idColumn: 'id',
    batchSize: BATCH_SIZE,
    startAfterId: checkpoint?.last_source_id || null,
  })) {
    for (const obs of batch) {
      // Resolve dc_users mapping from Postgres user_id UUID
      const dcUserId = await getMapping('portal_db', 'dashboard_user', obs.user_id, 'dc_users');
      if (!dcUserId) { skippedNoUser++; continue; }

      // Resolve the UUID of the patient in Postgres for demographic lookup
      const userRes = await portalDb.query(
        `SELECT user_id FROM dashboard_user WHERE id = $1`,
        [obs.user_id]
      );
      const userRow = userRes.rows[0];
      if (!userRow) { skippedNoUser++; continue; }

      // Fetch demographics
      const attrs = await fetchAttributes(userRow);
      if (!attrs) { skippedNoDemographics++; continue; }

      // Build GLI-2012 inputs from observation + attributes
      const demo = buildDemographics(obs, attrs);

      // Get best-of-trials observed values for this observation
      const observed = await getBestObservedValues(obs.id);
      if (!observed) { skippedNoObserved++; continue; }

      // Compute GLI-2012 for each variable
      const variables = buildVariableRows(observed, demo);

      // Persist. Delete existing rows for this observation first so the
      // migration is idempotent.
      await pool.query(
        `DELETE FROM portal_predicted_value WHERE observation_id = ?`,
        [obs.id]
      );

      for (const { variable, gli } of variables) {
        await pool.query(
          `INSERT INTO portal_predicted_value
             (user_id, observation_id, variable, predicted, lln, uln, z_score, percent_predicted, created)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            dcUserId,
            obs.id,
            variable,
            gli.predicted,
            gli.lln,
            null,                // ULN not defined by GLI-2012 for these variables
            gli.zScore,
            gli.percentPredicted,
            obs.dbdate,
          ]
        );
      }

      rowsDone++;
    }

    const lastId = batch[batch.length - 1].id;
    await saveCheckpoint(STEP, lastId, rowsDone);
    logger.progress('portal_predicted_value (observations processed)', rowsDone, null);
  }

  if (skippedNoObservation) logger.warn(`${skippedNoObservation} observations skipped — no user.`);
  if (skippedNoUser)        logger.warn(`${skippedNoUser} observations skipped — unresolvable user mapping.`);
  if (skippedNoDemographics) logger.warn(`${skippedNoDemographics} observations skipped — no demographic record.`);
  if (skippedNoObserved)    logger.warn(`${skippedNoObserved} observations skipped — no spirometry trials.`);

  logger.info(`Predicted values complete: ${rowsDone} observations processed (up to 4 rows each).`);
  await markComplete(STEP, rowsDone);
}

module.exports = { run };