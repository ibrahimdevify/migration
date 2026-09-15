// 09_patient_doctor_details.js
//
// Migrates from ande_db -> vitalflo_db:
//   authenticator_clinician              -> dc_doctor_details
//   authenticator_patient                -> dc_patient_details
//   authenticator_attributes             -> vf_attributes (+ addresses, air monitors)
//   authenticator_medication             -> dc_ehr_prescriptions + dc_ehr_prescription_medicines
//                                            (force-fit per user's explicit choice — see below)
//
// >>> IMPORTANT LIMITATIONS — read before trusting this data downstream <<<
//
// DOCTOR DETAILS: authenticator_clinician only has (title, account_id) — none
// of dc_doctor_details' other required fields (about_doctor, license_no,
// education, experience, is_specialist, is_writer) exist in the source.
// Required-but-missing fields get placeholders:
//   - license_no: 'MIGRATED-<uuid>' (guaranteed unique, NOT a real license)
//   - about_doctor: the clinician's title, or 'MIGRATED_NO_DATA' if blank
//   - ps_id_fk: hardcoded to 1 — this field has no lookup table anywhere in
//     the schema (orphan FK-shaped column with nothing to reference), so
//     there is no correct value to put here. Flag for the app team.
//
// MEDICATIONS: dc_ehr_prescription_medicines requires a parent
// dc_ehr_prescriptions row (doctor_id_fk, patient_id_fk, pharmacy_instruction,
// diagnosis all required, NOT NULL). The source medication list
// (authenticator_medication) has none of these — it's just a name per
// patient, no prescriber, no dosage, no diagnosis. To force-fit:
//   - ONE synthetic dc_ehr_prescriptions row is created per patient who has
//     any medications, with diagnosis/pharmacy_instruction explicitly
//     marked 'MIGRATED_LEGACY_DATA — no original record'.
//   - doctor_id_fk is set to the PATIENT'S OWN user_id (self-reference),
//     since no real prescriber exists in the source. This is a structural
//     workaround, not real data — do not treat these as real prescriptions.
//   - dosage/frequency/quantity/days/direction (all required strings) are
//     set to 'UNKNOWN'.

const logger = require('../logger');
const { andeDb, getMysqlPool } = require('../db');
const { batchedFetch } = require('../batch');
const { recordMapping, getMapping } = require('../idMap');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000', 10);

// --- authenticator_clinician -> dc_doctor_details ---
async function migrateDoctorDetails() {
  const STEP = 'doctor_details';
  const pool = await getMysqlPool();
  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Doctor details already migrated (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  let rowsDone = checkpoint?.rows_done || 0;
  let skipped = 0;

  for await (const batch of batchedFetch(andeDb, {
    table: 'authenticator_clinician',
    idColumn: 'andeuser_ptr_id',
    batchSize: BATCH_SIZE,
    startAfterId: checkpoint?.last_source_id || null,
  })) {
    for (const clin of batch) {
      const dcUserId = await getMapping('ande_db', 'authenticator_andeuser', clin.andeuser_ptr_id, 'dc_users');
      const hospitalId = await getMapping('ande_db', 'authenticator_account', clin.account_id, 'vf_account');
      if (!dcUserId || !hospitalId) { skipped++; continue; }

      try {
        await pool.query(
          `INSERT INTO dc_doctor_details
             (about_doctor, license_no, is_specialist, experience, is_writer, h_id_fk, ps_id_fk, user_id_fk)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [clin.title || 'MIGRATED_NO_DATA', `MIGRATED-${clin.andeuser_ptr_id}`,
           false, '2 yrs', false, hospitalId, 1, dcUserId]
        );
        rowsDone++;
      } catch (err) {
        skipped++;
        logger.warn(`Skipped doctor details (source id ${clin.andeuser_ptr_id}): ${err.code || err.message}`);
      }
    }
    await saveCheckpoint(STEP, batch[batch.length - 1].andeuser_ptr_id, rowsDone);
    logger.progress('dc_doctor_details', rowsDone, null);
  }

  if (skipped) logger.warn(`${skipped} clinicians skipped (unresolved user/account or insert conflict).`);
  logger.info(`Doctor details complete: ${rowsDone} rows.`);
  await markComplete(STEP, rowsDone);
}

// --- authenticator_patient (+attributes, address, air monitor) -> dc_patient_details (+vf_attributes...) ---
async function migratePatientDetails() {
  const STEP = 'patient_details';
  const pool = await getMysqlPool();
  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Patient details already migrated (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  let rowsDone = checkpoint?.rows_done || 0;
  let skipped = 0;
  let attrRows = 0, addressRows = 0, monitorRows = 0;

  for await (const batch of batchedFetch(andeDb, {
    table: 'authenticator_patient',
    idColumn: 'andeuser_ptr_id',
    batchSize: BATCH_SIZE,
    startAfterId: checkpoint?.last_source_id || null,
  })) {
    for (const pat of batch) {
      const dcUserId = await getMapping('ande_db', 'authenticator_andeuser', pat.andeuser_ptr_id, 'dc_users');
      if (!dcUserId) { skipped++; continue; }

      const patientGroupId = pat.patient_group_id
        ? await getMapping('ande_db', 'authenticator_patientgroup', pat.patient_group_id, 'vf_patient_group')
        : null;
      const assignedClinicianId = pat.assigned_clinician_id
        ? await getMapping('ande_db', 'authenticator_andeuser', pat.assigned_clinician_id, 'dc_users')
        : null;

      const [pdResult] = await pool.query(
        `INSERT INTO dc_patient_details
           (chart_no, invite_code, is_web_allowed, user_id_fk, patient_group_id, assigned_clinician_id,
            graph_view, access_code, awair_refresh_token, date_spirometer_received, rpm_consent, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`MIGRATED-${pat.andeuser_ptr_id.slice(0, 8)}`, `MIGRATED-${pat.andeuser_ptr_id}`,
         false, dcUserId, patientGroupId, assignedClinicianId, !!pat.graph_view,
         pat.access_code, pat.awair_refresh_token, pat.date_spirometer_received,
         !!pat.rpm_consent, pat.status || 'unverified']
      );
      const newPdId = pdResult.insertId;
      await recordMapping('ande_db', 'authenticator_patient', pat.andeuser_ptr_id, 'dc_patient_details', newPdId);

      // --- child: authenticator_attributes -> vf_attributes ---
      const attrResult = await andeDb.query(
        `SELECT * FROM authenticator_attributes WHERE patient_id = $1`, [pat.andeuser_ptr_id]
      );
      for (const attr of attrResult.rows) {
        const [vfResult] = await pool.query(
          `INSERT INTO vf_attributes
             (first_name, last_name, phone, dob, height, weight, gender, identify, ethnic_group,
              lookup_table, smoking, start_date, pd_id, mobile_app_save, extra, chart_number,
              account_type, welcome_method)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [attr.first_name || '', attr.last_name || '', attr.phone, attr.dob, attr.height || 0,
           attr.weight, attr.gender || '', attr.identify, attr.ethnic_group,
           attr.lookup_table || '', !!attr.smoking, attr.start_date, newPdId,
           attr.mobile_app_save ? JSON.stringify(attr.mobile_app_save) : null,
           attr.extra ? JSON.stringify(attr.extra) : null, attr.chart_number,
           attr.account_type || 'test', attr.welcome_method || 'text']
        );
        const newAttrId = vfResult.insertId;
        await recordMapping('ande_db', 'authenticator_attributes', attr.id, 'vf_attributes', newAttrId);
        attrRows++;

        // --- grandchildren: address, air monitor ---
        const addrResult = await andeDb.query(
          `SELECT * FROM authenticator_address WHERE attributes_id = $1`, [attr.id]
        );
        for (const addr of addrResult.rows) {
          await pool.query(
            `INSERT INTO vf_address (street, city, state, zip, attributes_id) VALUES (?, ?, ?, ?, ?)`,
            [addr.street, addr.city, addr.state, addr.zip, newAttrId]
          );
          addressRows++;
        }

        const monResult = await andeDb.query(
          `SELECT * FROM authenticator_airmonitor WHERE attributes_id = $1`, [attr.id]
        );
        for (const mon of monResult.rows) {
          await pool.query(
            `INSERT INTO vf_air_monitor (monitor_id, label, dev_id, attributes_id) VALUES (?, ?, ?, ?)`,
            [mon.monitor_id, mon.label, null, newAttrId]
          );
          monitorRows++;
        }
      }

      rowsDone++;
    }
    await saveCheckpoint(STEP, batch[batch.length - 1].andeuser_ptr_id, rowsDone);
    logger.progress('dc_patient_details (+attributes/address/monitor)', rowsDone, null);
  }

  if (skipped) logger.warn(`${skipped} patients skipped — no resolvable user.`);
  logger.info(`Patient details complete: ${rowsDone} patients, ${attrRows} attribute records, ` +
    `${addressRows} addresses, ${monitorRows} air monitors.`);
  await markComplete(STEP, rowsDone);
}

// --- authenticator_medication -> dc_ehr_prescriptions + dc_ehr_prescription_medicines (force-fit) ---
async function migrateMedications() {
  const STEP = 'medications';
  const pool = await getMysqlPool();
  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Medications already migrated (${checkpoint.rows_done} rows). Skipping.`);
    return;
  }
  let rowsDone = checkpoint?.rows_done || 0;
  let skipped = 0;
  let prescriptionsCreated = 0;

  // Cache of attributes_id -> synthetic prescription id, so all medications
  // for the same patient share ONE synthetic prescription rather than
  // creating a new one per medication row.
  const prescriptionCache = new Map();

  for await (const batch of batchedFetch(andeDb, {
    table: 'authenticator_medication',
    idColumn: 'id',
    batchSize: BATCH_SIZE,
    startAfterId: checkpoint?.last_source_id || null,
  })) {
    for (const med of batch) {
      let prescriptionId = prescriptionCache.get(med.attributes_id);

      if (prescriptionId === undefined) {
        // Resolve which patient this medication belongs to, via authenticator_attributes.
        const dcPatientUserResult = await andeDb.query(
          `SELECT patient_id FROM authenticator_attributes WHERE id = $1`, [med.attributes_id]
        );
        const patientAndeuserId = dcPatientUserResult.rows[0]?.patient_id;
        const dcUserId = patientAndeuserId
          ? await getMapping('ande_db', 'authenticator_andeuser', patientAndeuserId, 'dc_users')
          : null;

        if (!dcUserId) {
          prescriptionCache.set(med.attributes_id, null);
          skipped++;
          continue;
        }

        const [rxResult] = await pool.query(
          `INSERT INTO dc_ehr_prescriptions
             (pharmacy_instruction, diagnosis, doctor_id_fk, patient_id_fk, is_deleted)
           VALUES (?, ?, ?, ?, ?)`,
          ['MIGRATED_LEGACY_DATA — no original record', 'MIGRATED_LEGACY_DATA — no original record',
           dcUserId, dcUserId, false]
        );
        prescriptionId = rxResult.insertId;
        prescriptionCache.set(med.attributes_id, prescriptionId);
        prescriptionsCreated++;
      }

      if (prescriptionId === null) { skipped++; continue; } // resolved earlier as unresolvable

      await pool.query(
        `INSERT INTO dc_ehr_prescription_medicines
           (type, drug, dosage, frequency, quantity, days, units, direction, pr_id_fk, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [null, med.name, 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', null, 'UNKNOWN', prescriptionId, false]
      );
      rowsDone++;
    }
    await saveCheckpoint(STEP, batch[batch.length - 1].id, rowsDone);
    logger.progress('dc_ehr_prescription_medicines', rowsDone, null);
  }

  if (skipped) logger.warn(`${skipped} medications skipped — no resolvable patient.`);
  logger.info(`Medications complete: ${rowsDone} medication rows across ${prescriptionsCreated} ` +
    `synthetic prescription records (self-referencing doctor_id_fk = patient's own user_id — not real prescribers).`);
  await markComplete(STEP, rowsDone);
}

async function run() {
  logger.step('Step 09: Migrating doctor/patient details, attributes, and medications');
  await migrateDoctorDetails();
  await migratePatientDetails();
  await migrateMedications();
  logger.info('Step 09 complete.');
}

module.exports = { run };
