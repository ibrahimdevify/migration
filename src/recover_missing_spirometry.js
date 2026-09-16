#!/usr/bin/env node
// recover_missing_spirometry.js
//
// Finds dashboard_spirometry rows in portal_db that have NO entry in
// _migration_id_map (meaning they were never successfully migrated —
// likely due to a mid-batch interruption) and inserts just those, plus
// their flow/volume children. Safe to run multiple times — already-mapped
// rows are skipped.

require('dotenv').config();
const { portalDb, getMysqlPool, closeAll } = require('./db');
const { recordMapping, getMapping } = require('./idMap');
const logger = require('./logger');

async function main() {
  const pool = await getMysqlPool();

  // Find every dashboard_spirometry id already mapped.
  const [mappedRows] = await pool.query(
    `SELECT source_id FROM _migration_id_map WHERE source_table = 'dashboard_spirometry'`
  );
  const mappedIds = new Set(mappedRows.map(r => r.source_id));
  logger.info(`Already mapped: ${mappedIds.size} spirometry rows.`);

  // Fetch ALL source spirometry ids (just ids, cheap) to find the gap.
  const allIdsResult = await portalDb.query(`SELECT id FROM dashboard_spirometry ORDER BY id`);
  const missingIds = allIdsResult.rows
    .map(r => r.id)
    .filter(id => !mappedIds.has(String(id)));

  logger.info(`Found ${missingIds.length} missing spirometry rows to recover.`);
  if (missingIds.length === 0) {
    logger.info('Nothing to recover.');
    await closeAll();
    return;
  }

  let recovered = 0, skippedNoObs = 0, flowRows = 0, volumeRows = 0;

  for (const spiroId of missingIds) {
    const spiroResult = await portalDb.query(`SELECT * FROM dashboard_spirometry WHERE id = $1`, [spiroId]);
    const spiro = spiroResult.rows[0];
    if (!spiro || !spiro.observation_id) { skippedNoObs++; continue; }

    const newObsId = await getMapping('portal_db', 'dashboard_observation', spiro.observation_id, 'portal_observation');
    if (!newObsId) { skippedNoObs++; continue; }

    const [spiroInsert] = await pool.query(
      `INSERT INTO portal_spirometry
         (dbdate, observation_id, btps, temp_celsius, quality_message, symptom,
          fev1_acceptability, fvc_acceptability, fvc, fev1, pefr, fef2575, fev6, fev1_perc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [spiro.dbdate, newObsId, spiro.btps, spiro.tempCelsius, spiro.qualityMessage,
       spiro.symptom, spiro.fev1Acceptability, spiro.fvcAcceptability, spiro.fvc,
       spiro.fev1, spiro.pefr, spiro.fef2575, spiro.fev6, spiro.fev1Perc]
    );
    const newSpiroId = spiroInsert.insertId;
    await recordMapping('portal_db', 'dashboard_spirometry', spiro.id, 'portal_spirometry', newSpiroId);
    recovered++;

    const flowResult = await portalDb.query(
      `SELECT time, value, volume, dbdate FROM dashboard_flow WHERE spirometry_id = $1`, [spiro.id]
    );
    if (flowResult.rows.length > 0) {
      const values = flowResult.rows.map(f => [f.time, f.value, f.volume, f.dbdate, newSpiroId]);
      await pool.query(`INSERT INTO portal_flow (time, value, volume, dbdate, spirometry_id) VALUES ?`, [values]);
      flowRows += values.length;
    }

    const volumeResult = await portalDb.query(
      `SELECT volume, time FROM dashboard_volume WHERE spirometry_id = $1`, [spiro.id]
    );
    if (volumeResult.rows.length > 0) {
      const values = volumeResult.rows.map(v => [v.volume, v.time, newSpiroId]);
      await pool.query(`INSERT INTO portal_volume (volume, time, spirometry_id) VALUES ?`, [values]);
      volumeRows += values.length;
    }

    logger.info(`Recovered spirometry ${spiroId} -> new id ${newSpiroId} (${flowResult.rows.length} flow, ${volumeResult.rows.length} volume)`);
  }

  logger.info(`Done. Recovered ${recovered} spirometry rows, ${flowRows} flow points, ${volumeRows} volume points. Skipped ${skippedNoObs} (no resolvable observation).`);
  await closeAll();
}

main().catch(async (err) => {
  logger.error('Recovery script failed', err);
  await closeAll();
  process.exit(1);
});
