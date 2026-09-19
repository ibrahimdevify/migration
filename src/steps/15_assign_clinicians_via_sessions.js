// 15_assign_clinicians_via_sessions.js
//
// A third, more precise signal for "who treats this patient": every time a
// clinician creates a session for a patient, authenticator_vfsession
// records clinician_created_id. Confirmed against real data to be more
// trustworthy than group membership — e.g. patient "TraeseKuhl295" sits in
// an ambiguous "Default" group (2 clinicians linked, so step 14 correctly
// skipped her), but her actual treating clinician per session history is
// a DIFFERENT doctor entirely than the group would have suggested. Group
// membership answers "who COULD treat this patient"; session history
// answers "who ACTUALLY does."
//
// For every patient still missing assigned_clinician_id (whether they had
// no group link, an ambiguous group, or weren't reachable by step 14 at
// all), this finds whichever clinician created the MOST sessions for them
// and assigns that one. Requires at least MIN_SESSION_COUNT sessions from
// a single clinician before assigning, to avoid acting on a single
// one-off/accidental session. Never overwrites an existing assignment.

const logger = require('../logger');
const { andeDb, getMysqlPool } = require('../db');
const { getMapping } = require('../idMap');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const STEP = 'assign_clinicians_via_sessions';
const MIN_SESSION_COUNT = 2; // require at least this many sessions from the same clinician

async function run() {
  logger.step('Step 15: Assigning clinicians to patients via session-creation history');
  const pool = await getMysqlPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Session-based clinician assignment already complete (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }

  // All patients still missing an assignment, with their new-db user_id.
  const [unassigned] = await pool.query(
    `SELECT user_id_fk FROM dc_patient_details WHERE assigned_clinician_id IS NULL
     ORDER BY user_id_fk ASC`
  );
  logger.info(`${unassigned.length} patients still unassigned — checking session history for each.`);

  const startIndex = checkpoint?.last_source_id ? parseInt(checkpoint.last_source_id, 10) : 0;
  let rowsDone = checkpoint?.rows_done || 0;
  let assigned = 0, noSessionData = 0, belowThreshold = 0, unresolvedSourceUuid = 0, unresolvedClinician = 0;

  for (let i = startIndex; i < unassigned.length; i++) {
    const newPatientId = unassigned[i].user_id_fk;

    // Reverse-lookup: find this patient's ande_db source UUID.
    const [mapRows] = await pool.query(
      `SELECT source_id FROM _migration_id_map
       WHERE target_table = 'dc_users' AND target_id = ?
         AND source_table = 'authenticator_andeuser' AND source_db = 'ande_db'
       LIMIT 1`,
      [newPatientId]
    );
    if (mapRows.length === 0) { unresolvedSourceUuid++; rowsDone++; continue; }
    const patientUuid = mapRows[0].source_id;

    const sessionResult = await andeDb.query(
      `SELECT clinician_created_id, COUNT(*) as session_count
       FROM authenticator_vfsession
       WHERE user_id = $1 AND clinician_created_id IS NOT NULL
       GROUP BY clinician_created_id
       ORDER BY session_count DESC
       LIMIT 1`,
      [patientUuid]
    );

    if (sessionResult.rows.length === 0) { noSessionData++; rowsDone++; continue; }
    const top = sessionResult.rows[0];
    if (parseInt(top.session_count, 10) < MIN_SESSION_COUNT) { belowThreshold++; rowsDone++; continue; }

    const newClinicianId = await getMapping('ande_db', 'authenticator_andeuser', top.clinician_created_id, 'dc_users');
    if (!newClinicianId) { unresolvedClinician++; rowsDone++; continue; }

    await pool.query(
      `UPDATE dc_patient_details SET assigned_clinician_id = ?
       WHERE user_id_fk = ? AND assigned_clinician_id IS NULL`,
      [newClinicianId, newPatientId]
    );
    assigned++;
    rowsDone++;

    if (rowsDone % 100 === 0) {
      await saveCheckpoint(STEP, i + 1, rowsDone);
      logger.progress('patients_checked_for_session_assignment', rowsDone, unassigned.length);
    }
  }

  await saveCheckpoint(STEP, unassigned.length, rowsDone);
  logger.info(`Session-based assignment complete: ${assigned} patients assigned a clinician via session history.`);
  logger.info(`Remaining unresolved: ${noSessionData} with no session data at all, ` +
    `${belowThreshold} below the ${MIN_SESSION_COUNT}-session confidence threshold, ` +
    `${unresolvedSourceUuid} couldn't be traced back to ande_db, ` +
    `${unresolvedClinician} had a clinician that couldn't be resolved in the new DB.`);
  await markComplete(STEP, rowsDone);
}

module.exports = { run };
