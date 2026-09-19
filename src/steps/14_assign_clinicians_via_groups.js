// 14_assign_clinicians_via_groups.js
//
// ande_db has TWO ways a clinician can be linked to a patient:
//   1. authenticator_patient.assigned_clinician_id — direct 1-to-1 (already
//      handled by 09_patient_doctor_details.js).
//   2. authenticator_clinician_patient_groups — a clinician is linked to a
//      PATIENT GROUP, and any patient in that group is effectively under
//      that clinician's care, even with assigned_clinician_id = NULL.
//      Confirmed against real data: e.g. tkuhl@rootsdpc.com has 0 direct
//      assignments but dozens of patients via the "Default"/"In-Clinic"
//      group link.
//
// This step fills in dc_patient_details.assigned_clinician_id in the NEW
// database for patients who have no direct assignment, using this group
// relationship — but ONLY when a patient's group maps to EXACTLY ONE
// clinician. A patient group linked to multiple clinicians is ambiguous
// (we can't safely guess which one is "the" assigned clinician), so those
// are skipped and logged for manual review rather than assigned arbitrarily.
//
// Never overwrites an existing assigned_clinician_id — only fills NULLs.

const logger = require('../logger');
const { andeDb, getMysqlPool } = require('../db');
const { getMapping } = require('../idMap');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const STEP = 'assign_clinicians_via_groups';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000', 10);

async function buildGroupToCliniciansMap() {
  const result = await andeDb.query(`
    SELECT cpg.patientgroup_id, c.andeuser_ptr_id as clinician_uuid
    FROM authenticator_clinician_patient_groups cpg
    JOIN authenticator_clinician c ON c.andeuser_ptr_id = cpg.clinician_id
  `);
  const map = new Map(); // patientgroup_id -> [clinician_uuid, ...]
  for (const row of result.rows) {
    if (!map.has(row.patientgroup_id)) map.set(row.patientgroup_id, []);
    map.get(row.patientgroup_id).push(row.clinician_uuid);
  }
  return map;
}

async function run() {
  logger.step('Step 14: Assigning clinicians to patients via group membership');
  const pool = await getMysqlPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Group-based clinician assignment already complete (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }

  const groupToClinicians = await buildGroupToCliniciansMap();
  logger.info(`Loaded ${groupToClinicians.size} patient groups with clinician links.`);

  let rowsDone = checkpoint?.rows_done || 0;
  let assigned = 0, ambiguousGroups = new Set(), skippedNoGroup = 0, skippedUnresolved = 0;

  let lastId = checkpoint?.last_source_id || null;

  while (true) {
    const params = [];
    let where = `WHERE p.assigned_clinician_id IS NULL AND p.patient_group_id IS NOT NULL`;
    if (lastId) {
      params.push(lastId);
      where += ` AND p.andeuser_ptr_id > $${params.length}`;
    }
    params.push(BATCH_SIZE);

    const result = await andeDb.query(
      `SELECT p.andeuser_ptr_id, p.patient_group_id
       FROM authenticator_patient p
       ${where}
       ORDER BY p.andeuser_ptr_id ASC
       LIMIT $${params.length}`,
      params
    );
    if (result.rows.length === 0) break;

    for (const patient of result.rows) {
      const clinicianUuids = groupToClinicians.get(patient.patient_group_id);

      if (!clinicianUuids || clinicianUuids.length === 0) {
        skippedNoGroup++;
      } else if (clinicianUuids.length > 1) {
        ambiguousGroups.add(patient.patient_group_id);
      } else {
        const newPatientId = await getMapping('ande_db', 'authenticator_andeuser', patient.andeuser_ptr_id, 'dc_users');
        const newClinicianId = await getMapping('ande_db', 'authenticator_andeuser', clinicianUuids[0], 'dc_users');

        if (newPatientId && newClinicianId) {
          await pool.query(
            `UPDATE dc_patient_details SET assigned_clinician_id = ?
             WHERE user_id_fk = ? AND assigned_clinician_id IS NULL`,
            [newClinicianId, newPatientId]
          );
          assigned++;
        } else {
          skippedUnresolved++;
        }
      }

      rowsDone++;
    }

    lastId = result.rows[result.rows.length - 1].andeuser_ptr_id;
    await saveCheckpoint(STEP, lastId, rowsDone);
    logger.progress('patients_checked_for_group_assignment', rowsDone, null);

    if (result.rows.length < BATCH_SIZE) break;
  }

  logger.info(`Group-based assignment complete: ${assigned} patients assigned a clinician via group membership.`);
  if (ambiguousGroups.size > 0) {
    logger.warn(`${ambiguousGroups.size} patient groups have MULTIPLE clinicians linked — skipped as ` +
      `ambiguous (can't safely pick one). Group IDs: ${[...ambiguousGroups].slice(0, 20).join(', ')}` +
      (ambiguousGroups.size > 20 ? ` ... and ${ambiguousGroups.size - 20} more` : '') +
      `. Review these manually if per-patient assignment matters for them.`);
  }
  if (skippedNoGroup) logger.info(`${skippedNoGroup} patients skipped — their group has no clinician linked at all.`);
  if (skippedUnresolved) logger.warn(`${skippedUnresolved} patients skipped — patient or clinician user not resolvable in new DB.`);
  await markComplete(STEP, rowsDone);
}

module.exports = { run };
