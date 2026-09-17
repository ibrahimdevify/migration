// 12_sync_old_db_clinical.js
//
// For every user synced in step 11 (matched or newly created), pulls any
// clinical activity from the OLD database that doesn't already exist in
// the NEW one — using a PER-USER "latest already-present timestamp"
// comparison rather than one global cutoff date, since different users'
// data was captured at different times:
//
//   - For a NEWLY CREATED user (no prior match): nothing exists for them
//     yet in the new DB at all — migrate everything.
//   - For a MATCHED existing user: find the latest dbdate/created already
//     in the new DB for them, and only pull OLD-db rows newer than that.
//
// Covers: portal_observation (+spirometry/flow/volume), portal_notes,
// portal_alert (+notifications). Does NOT yet cover predicted_values or
// patient/doctor details deltas — extend following the same pattern if
// needed.

const logger = require('../logger');
const { getMysqlPool, getOldMergeDbPool } = require('../db');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const STEP = 'sync_old_db_clinical';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '500', 10); // smaller: this is per-user work

async function getLatestNewDbTimestamp(pool, table, dateColumn, userId) {
  const [rows] = await pool.query(
    `SELECT MAX(${dateColumn}) as latest FROM ${table} WHERE user_id = ?`,
    [userId]
  );
  return rows[0]?.latest || null; // null means "nothing exists yet — migrate everything"
}

async function syncObservationsForUser(pool, oldPool, oldUserId, newUserId, isNewUser) {
  let sinceClause = '';
  let params = [oldUserId];

  if (!isNewUser) {
    const latest = await getLatestNewDbTimestamp(pool, 'portal_observation', 'dbdate', newUserId);
    if (latest) {
      sinceClause = 'AND dbdate > ?';
      params.push(latest);
    }
  }

  const [oldObs] = await oldPool.query(
    `SELECT * FROM portal_observation WHERE user_id = ? ${sinceClause} ORDER BY id ASC`,
    params
  );

  let obsCount = 0, spiroCount = 0, flowCount = 0, volumeCount = 0;

  for (const obs of oldObs) {
    const [result] = await pool.query(
      `INSERT INTO portal_observation
         (dbdate, user_id, fev1_grade, fvc_grade, is_post_bronchodilator, height)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [obs.dbdate, newUserId, obs.fev1_grade, obs.fvc_grade, !!obs.is_post_bronchodilator, obs.height]
    );
    const newObsId = result.insertId;
    obsCount++;

    const [oldSpiros] = await oldPool.query(
      `SELECT * FROM portal_spirometry WHERE observation_id = ?`, [obs.id]
    );
    for (const spiro of oldSpiros) {
      const [spiroResult] = await pool.query(
        `INSERT INTO portal_spirometry
           (dbdate, observation_id, btps, temp_celsius, quality_message, symptom,
            fev1_acceptability, fvc_acceptability, fvc, fev1, pefr, fef2575, fev6, fev1_perc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [spiro.dbdate, newObsId, spiro.btps, spiro.temp_celsius, spiro.quality_message,
         spiro.symptom, spiro.fev1_acceptability, spiro.fvc_acceptability, spiro.fvc,
         spiro.fev1, spiro.pefr, spiro.fef2575, spiro.fev6, spiro.fev1_perc]
      );
      const newSpiroId = spiroResult.insertId;
      spiroCount++;

      const [oldFlows] = await oldPool.query(
        `SELECT time, value, volume, dbdate FROM portal_flow WHERE spirometry_id = ?`, [spiro.id]
      );
      if (oldFlows.length > 0) {
        const values = oldFlows.map(f => [f.time, f.value, f.volume, f.dbdate, newSpiroId]);
        await pool.query(`INSERT INTO portal_flow (time, value, volume, dbdate, spirometry_id) VALUES ?`, [values]);
        flowCount += values.length;
      }

      const [oldVolumes] = await oldPool.query(
        `SELECT volume, time FROM portal_volume WHERE spirometry_id = ?`, [spiro.id]
      );
      if (oldVolumes.length > 0) {
        const values = oldVolumes.map(v => [v.volume, v.time, newSpiroId]);
        await pool.query(`INSERT INTO portal_volume (volume, time, spirometry_id) VALUES ?`, [values]);
        volumeCount += values.length;
      }
    }
  }

  return { obsCount, spiroCount, flowCount, volumeCount };
}

async function syncNotesForUser(pool, oldPool, oldUserId, newUserId, isNewUser) {
  let sinceClause = '';
  let params = [oldUserId];

  if (!isNewUser) {
    const latest = await getLatestNewDbTimestamp(pool, 'portal_notes', 'recorded_date', newUserId);
    if (latest) {
      sinceClause = 'AND recorded_date > ?';
      params.push(latest);
    }
  }

  const [oldNotes] = await oldPool.query(
    `SELECT * FROM portal_notes WHERE user_id = ? ${sinceClause} ORDER BY id ASC`,
    params
  );

  for (const note of oldNotes) {
    await pool.query(
      `INSERT INTO portal_notes (user_id, text, dbdate, recorded_date, page) VALUES (?, ?, ?, ?, ?)`,
      [newUserId, note.text, note.dbdate, note.recorded_date, note.page]
    );
  }
  return oldNotes.length;
}

async function syncAlertsForUser(pool, oldPool, oldUserId, newUserId, isNewUser) {
  let sinceClause = '';
  let params = [oldUserId];

  if (!isNewUser) {
    const latest = await getLatestNewDbTimestamp(pool, 'portal_alert', 'created', newUserId);
    if (latest) {
      sinceClause = 'AND created > ?';
      params.push(latest);
    }
  }

  const [oldAlerts] = await oldPool.query(
    `SELECT * FROM portal_alert WHERE user_id = ? ${sinceClause} ORDER BY id ASC`,
    params
  );

  let alertCount = 0, notificationCount = 0;
  for (const alert of oldAlerts) {
    const [result] = await pool.query(
      `INSERT INTO portal_alert (user_id, message, created, is_read) VALUES (?, ?, ?, ?)`,
      [newUserId, alert.message, alert.created, !!alert.is_read]
    );
    const newAlertId = result.insertId;
    alertCount++;

    const [oldNotifs] = await oldPool.query(
      `SELECT * FROM portal_alert_notification WHERE alert_id = ?`, [alert.id]
    );
    for (const n of oldNotifs) {
      await pool.query(
        `INSERT INTO portal_alert_notification (alert_id, sent_at, channel) VALUES (?, ?, ?)`,
        [newAlertId, n.sent_at, n.channel]
      );
      notificationCount++;
    }
  }
  return { alertCount, notificationCount };
}

async function run() {
  logger.step('Step 12: Syncing new clinical activity from OLD database');
  const pool = await getMysqlPool();
  const oldPool = await getOldMergeDbPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Old-DB clinical sync already complete (${checkpoint.rows_done} users processed). Skipping.`);
    return;
  }
  let rowsDone = checkpoint?.rows_done || 0;

  // Get all synced user mappings (built in step 11).
  const [mappings] = await pool.query(
    `SELECT source_id as old_user_id, target_id as new_user_id
     FROM _migration_id_map
     WHERE source_db = 'old_merged_db' AND source_table = 'dc_users' AND target_table = 'dc_users'
     ORDER BY id ASC`
  );

  // Figure out which of these were newly created (vs matched) in step 11 —
  // a newly created user has NO other mapping pointing at that same
  // new_user_id from ande_db/portal_db, meaning nothing pre-existed for them.
  const [andeMapped] = await pool.query(
    `SELECT DISTINCT target_id FROM _migration_id_map
     WHERE source_table = 'authenticator_andeuser' AND target_table = 'dc_users'`
  );
  const preExistingUserIds = new Set(andeMapped.map(r => r.target_id));

  const startIndex = checkpoint?.last_source_id ? parseInt(checkpoint.last_source_id, 10) : 0;
  let totals = { obs: 0, spiro: 0, flow: 0, volume: 0, notes: 0, alerts: 0, notifications: 0 };

  for (let i = startIndex; i < mappings.length; i++) {
    const { old_user_id, new_user_id } = mappings[i];
    const isNewUser = !preExistingUserIds.has(new_user_id);

    const obsResult = await syncObservationsForUser(pool, oldPool, old_user_id, new_user_id, isNewUser);
    const notesCount = await syncNotesForUser(pool, oldPool, old_user_id, new_user_id, isNewUser);
    const alertResult = await syncAlertsForUser(pool, oldPool, old_user_id, new_user_id, isNewUser);

    totals.obs += obsResult.obsCount;
    totals.spiro += obsResult.spiroCount;
    totals.flow += obsResult.flowCount;
    totals.volume += obsResult.volumeCount;
    totals.notes += notesCount;
    totals.alerts += alertResult.alertCount;
    totals.notifications += alertResult.notificationCount;

    rowsDone++;
    if (rowsDone % 100 === 0) {
      await saveCheckpoint(STEP, i + 1, rowsDone);
      logger.progress('users_processed_for_clinical_sync', rowsDone, mappings.length);
    }
  }

  await saveCheckpoint(STEP, mappings.length, rowsDone);
  logger.info(`Old-DB clinical sync complete. Processed ${rowsDone} users. ` +
    `New rows: ${totals.obs} observations, ${totals.spiro} spirometry, ${totals.flow} flow, ` +
    `${totals.volume} volume, ${totals.notes} notes, ${totals.alerts} alerts, ${totals.notifications} notifications.`);
  await markComplete(STEP, rowsDone);
}

module.exports = { run };
