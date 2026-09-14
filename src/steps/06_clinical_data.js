// 06_clinical_data.js
//
// Migrates the core clinical/observational tables from portal_db into
// vitalflo_db, using the portal_db -> dc_users mapping built in
// 05_portal_users.js (NOT the ande_db one) to resolve every user_id.
//
// Covered in this step (high-confidence, direct field mappings):
//   dashboard_observation      -> portal_observation
//   dashboard_spirometry       -> portal_spirometry
//   dashboard_flow             -> portal_flow
//   dashboard_volume           -> portal_volume
//   dashboard_stepsobservations-> portal_steps_observations
//   dashboard_indoorairquality -> portal_indoor_air_quality
//   dashboard_notes            -> portal_notes
//   dashboard_alert            -> portal_alert
//   dashboard_alertnotification-> portal_alert_notification
//
// NOT covered yet (needs a design decision before writing):
//   - Heart rate: portal_heart_rate_point's shape matches dashboard_oximetry's
//     heartratepoint/spo2point child tables more closely than
//     dashboard_heartrateobservations (which stores one summary value, not a
//     point series). Needs a decision on which source truly feeds
//     portal_heart_rate_observations/point before implementing.
//   - portal_predicted_value: portal_db stores GLI predicted values as
//     inline columns on dashboard_spirometry (gli2012_fev1_predicted, etc.),
//     not as separate rows. Needs a decision on whether to explode these
//     into portal_predicted_value rows (one per variable) or leave them
//     out entirely since dashboard_spirometry already carries them.

const logger = require('../logger');
const { portalDb, getMysqlPool } = require('../db');
const { batchedFetch } = require('../batch');
const { recordMapping, getMapping } = require('../idMap');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000', 10);

async function resolveUser(sourceUserId) {
  return getMapping('portal_db', 'dashboard_user', sourceUserId, 'dc_users');
}

// --- dashboard_observation -> portal_observation (+ children) ---
async function migrateObservations() {
  const STEP = 'clinical_observations';
  const pool = await getMysqlPool();
  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Observations already migrated (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  let rowsDone = checkpoint?.rows_done || 0;
  let skippedNoUser = 0;
  let spiroRows = 0, flowRows = 0, volumeRows = 0;

  for await (const batch of batchedFetch(portalDb, {
    table: 'dashboard_observation',
    idColumn: 'id',
    batchSize: BATCH_SIZE,
    startAfterId: checkpoint?.last_source_id || null,
  })) {
    // Accumulated across this whole outer batch, then bulk-inserted once —
    // dramatically fewer round-trips than one INSERT per flow/volume point.
    const flowBuffer = [];
    const volumeBuffer = [];

    for (const obs of batch) {
      const dcUserId = await resolveUser(obs.user_id);
      if (!dcUserId) { skippedNoUser++; continue; }

      // linked_pre_post_observation_id is self-referential; resolve it only
      // if that linked observation was already migrated (earlier in this
      // same batched, ID-ascending scan — true for most cases since Django
      // typically creates the "pre" observation before the "post" one).
      let linkedId = null;
      if (obs.linked_pre_post_observation_id) {
        linkedId = await getMapping('portal_db', 'dashboard_observation',
          obs.linked_pre_post_observation_id, 'portal_observation');
      }

      const [result] = await pool.query(
        `INSERT INTO portal_observation
           (dbdate, user_id, fev1_grade, fvc_grade, is_post_bronchodilator, height, linked_pre_post_observation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [obs.dbdate, dcUserId, obs.fev1_grade, obs.fvc_grade,
         !!obs.is_post_bronchodilator, obs.height, linkedId]
      );
      const newObsId = result.insertId;
      await recordMapping('portal_db', 'dashboard_observation', obs.id, 'portal_observation', newObsId);

      // --- child: dashboard_spirometry (0 or 1+ per observation) ---
      const spiroResult = await portalDb.query(
        `SELECT * FROM dashboard_spirometry WHERE observation_id = $1`, [obs.id]
      );
      for (const spiro of spiroResult.rows) {
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
        spiroRows++;

        // --- grandchild: dashboard_flow, dashboard_volume ---
        // Buffered here, bulk-inserted once at the end of the outer batch.
        const flowResult = await portalDb.query(
          `SELECT time, value, volume, dbdate FROM dashboard_flow WHERE spirometry_id = $1`, [spiro.id]
        );
        for (const f of flowResult.rows) {
          flowBuffer.push([f.time, f.value, f.volume, f.dbdate, newSpiroId]);
        }

        const volumeResult = await portalDb.query(
          `SELECT volume, time FROM dashboard_volume WHERE spirometry_id = $1`, [spiro.id]
        );
        for (const v of volumeResult.rows) {
          volumeBuffer.push([v.volume, v.time, newSpiroId]);
        }
      }

      rowsDone++;
    }

    // Bulk insert everything accumulated in this outer batch, in chunks to
    // avoid a single query with millions of parameters.
    const CHUNK = 5000;
    for (let i = 0; i < flowBuffer.length; i += CHUNK) {
      const chunk = flowBuffer.slice(i, i + CHUNK);
      await pool.query(
        `INSERT INTO portal_flow (time, value, volume, dbdate, spirometry_id) VALUES ?`,
        [chunk]
      );
      flowRows += chunk.length;
    }
    for (let i = 0; i < volumeBuffer.length; i += CHUNK) {
      const chunk = volumeBuffer.slice(i, i + CHUNK);
      await pool.query(
        `INSERT INTO portal_volume (volume, time, spirometry_id) VALUES ?`,
        [chunk]
      );
      volumeRows += chunk.length;
    }

    await saveCheckpoint(STEP, batch[batch.length - 1].id, rowsDone);
    logger.progress('portal_observation (+spirometry/flow/volume)', rowsDone, null);
  }

  if (skippedNoUser) logger.warn(`${skippedNoUser} observations skipped — no resolvable user.`);
  logger.info(`Observations complete: ${rowsDone} observations, ${spiroRows} spirometry, ` +
    `${flowRows} flow points, ${volumeRows} volume points.`);
  await markComplete(STEP, rowsDone);
}

// --- Generic simple one-table migrations (no children) ---
async function migrateSimpleTable({ stepName, sourceTable, targetTable, mapRow }) {
  const pool = await getMysqlPool();
  const checkpoint = await getCheckpoint(stepName);
  if (checkpoint?.status === 'complete') {
    logger.info(`${sourceTable} already migrated (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  let rowsDone = checkpoint?.rows_done || 0;
  let skippedNoUser = 0;

  for await (const batch of batchedFetch(portalDb, {
    table: sourceTable,
    idColumn: 'id',
    batchSize: BATCH_SIZE,
    startAfterId: checkpoint?.last_source_id || null,
  })) {
    for (const row of batch) {
      const dcUserId = await resolveUser(row.user_id);
      if (!dcUserId) { skippedNoUser++; continue; }

      const { columns, values } = mapRow(row, dcUserId);
      const placeholders = columns.map(() => '?').join(', ');
      const [result] = await pool.query(
        `INSERT INTO ${targetTable} (${columns.join(', ')}) VALUES (${placeholders})`,
        values
      );
      await recordMapping('portal_db', sourceTable, row.id, targetTable, result.insertId);
      rowsDone++;
    }
    await saveCheckpoint(stepName, batch[batch.length - 1].id, rowsDone);
    logger.progress(targetTable, rowsDone, null);
  }

  if (skippedNoUser) logger.warn(`${skippedNoUser} ${sourceTable} rows skipped — no resolvable user.`);
  logger.info(`${sourceTable} -> ${targetTable} complete: ${rowsDone} rows.`);
  await markComplete(stepName, rowsDone);
}

async function run() {
  logger.step('Step 06: Migrating clinical data (spirometry chain, notes, alerts, steps, air quality)');

  await migrateObservations();

  await migrateSimpleTable({
    stepName: 'clinical_steps',
    sourceTable: 'dashboard_stepsobservations',
    targetTable: 'portal_steps_observations',
    mapRow: (row, dcUserId) => ({
      columns: ['dbdate', 'steps', 'user_id'],
      values: [row.dbdate, row.step_count, dcUserId],
    }),
  });

  await migrateSimpleTable({
    stepName: 'clinical_air_quality',
    sourceTable: 'dashboard_indoorairquality',
    targetTable: 'portal_indoor_air_quality',
    mapRow: (row, dcUserId) => ({
      columns: ['dbdate', 'user_id', 'pm25', 'pm10', 'temperature', 'humidity'],
      values: [row.dbdate, dcUserId, row.pm_2_5, row.pm_10, row.temp, row.hum],
    }),
  });

  await migrateSimpleTable({
    stepName: 'clinical_notes',
    sourceTable: 'dashboard_notes',
    targetTable: 'portal_notes',
    mapRow: (row, dcUserId) => ({
      columns: ['user_id', 'text', 'dbdate', 'recorded_date', 'page'],
      values: [dcUserId, row.text, row.dbdate, row.recorded_date, row.page],
    }),
  });

  // Alerts have a child table (notifications), handled separately since
  // migrateSimpleTable doesn't support children.
  await migrateAlerts();

  logger.info('Clinical data migration (this step) complete.');
}

async function migrateAlerts() {
  const STEP = 'clinical_alerts';
  const pool = await getMysqlPool();
  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Alerts already migrated (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  let rowsDone = checkpoint?.rows_done || 0;
  let skippedNoUser = 0;
  let notificationRows = 0;

  for await (const batch of batchedFetch(portalDb, {
    table: 'dashboard_alert',
    idColumn: 'id',
    batchSize: BATCH_SIZE,
    startAfterId: checkpoint?.last_source_id || null,
  })) {
    for (const alert of batch) {
      const dcUserId = await resolveUser(alert.user_id);
      if (!dcUserId) { skippedNoUser++; continue; }

      const [result] = await pool.query(
        `INSERT INTO portal_alert (user_id, message, created, is_read) VALUES (?, ?, ?, ?)`,
        [dcUserId, alert.name || alert.query || '', alert.dbdate, false]
      );
      const newAlertId = result.insertId;
      await recordMapping('portal_db', 'dashboard_alert', alert.id, 'portal_alert', newAlertId);

      const notifResult = await portalDb.query(
        `SELECT * FROM dashboard_alertnotification WHERE alert_id = $1`, [alert.id]
      );
      for (const n of notifResult.rows) {
        await pool.query(
          `INSERT INTO portal_alert_notification (alert_id, sent_at, channel) VALUES (?, ?, ?)`,
          [newAlertId, n.dbdate, 'unknown']
        );
        notificationRows++;
      }

      rowsDone++;
    }
    await saveCheckpoint(STEP, batch[batch.length - 1].id, rowsDone);
    logger.progress('portal_alert (+notifications)', rowsDone, null);
  }

  if (skippedNoUser) logger.warn(`${skippedNoUser} alerts skipped — no resolvable user.`);
  logger.info(`Alerts complete: ${rowsDone} alerts, ${notificationRows} notifications.`);
  await markComplete(STEP, rowsDone);
}

module.exports = { run };
