// 13_sync_old_db_patient_doctor_details.js
//
// Syncs dc_patient_details (+vf_attributes+vf_address) and dc_doctor_details
// from the OLD live database into the NEW one, using the user mapping built
// in step 11 (sync_old_db_users).
//
// Unlike the append-only clinical tables (observations, notes, alerts),
// each patient/doctor has AT MOST ONE details/attributes row — so this
// isn't really a "find what's new" delta, it's an upsert:
//
//   - NEW users (no prior match, created in step 11): create their
//     patient/doctor details fresh, since nothing exists for them yet.
//   - MATCHED existing users: UPDATE their existing row with the OLD
//     database's current values. This treats the OLD (live) database as
//     the more authoritative/current source, since real users have been
//     editing their profiles there since go-live — the original
//     ande_db-sourced row in the new DB could be stale by comparison.
//     If you'd rather never overwrite existing data (only fill gaps),
//     change the UPDATE branches below to skip instead.
//
// Same schema on both sides, so this is a direct field-for-field copy —
// no transformation needed, unlike the original ande_db migration.

const logger = require('../logger');
const { getMysqlPool, getOldMergeDbPool } = require('../db');
const { getCheckpoint, saveCheckpoint, markComplete } = require('../checkpoint');

const STEP = 'sync_old_db_patient_doctor_details';

async function getUserMappings(pool) {
  const [mappings] = await pool.query(
    `SELECT source_id as old_user_id, target_id as new_user_id
     FROM _migration_id_map
     WHERE source_db = 'old_merged_db' AND source_table = 'dc_users' AND target_table = 'dc_users'`
  );
  return mappings;
}

async function syncPatientDetails(pool, oldPool, oldUserId, newUserId) {
  const [oldRows] = await oldPool.query(
    `SELECT * FROM dc_patient_details WHERE user_id_fk = ?`, [oldUserId]
  );
  if (oldRows.length === 0) return { action: 'none' };
  const old = oldRows[0];

  const [existingRows] = await pool.query(
    `SELECT pd_id FROM dc_patient_details WHERE user_id_fk = ?`, [newUserId]
  );

  if (existingRows.length > 0) {
    // UPDATE existing — old (live) DB treated as more current.
    await pool.query(
      `UPDATE dc_patient_details SET
         chart_no = ?, height = ?, blood_group = ?, geno_type = ?, invite_code = ?,
         is_web_allowed = ?, weight = ?, graph_view = ?, access_code = ?,
         awair_refresh_token = ?, date_spirometer_received = ?, rpm_consent = ?, status = ?
       WHERE user_id_fk = ?`,
      [old.chart_no, old.height, old.blood_group, old.geno_type, old.invite_code,
       !!old.is_web_allowed, old.weight, !!old.graph_view, old.access_code,
       old.awair_refresh_token, old.date_spirometer_received, !!old.rpm_consent,
       old.status, newUserId]
    );
    return { action: 'updated', pdId: existingRows[0].pd_id };
  }

  // CREATE — nothing existed yet for this user.
  const [result] = await pool.query(
    `INSERT INTO dc_patient_details
       (chart_no, height, blood_group, geno_type, invite_code, is_web_allowed,
        user_id_fk, weight, graph_view, access_code, awair_refresh_token,
        date_spirometer_received, rpm_consent, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [old.chart_no, old.height, old.blood_group, old.geno_type, old.invite_code,
     !!old.is_web_allowed, newUserId, old.weight, !!old.graph_view, old.access_code,
     old.awair_refresh_token, old.date_spirometer_received, !!old.rpm_consent, old.status]
  );
  return { action: 'created', pdId: result.insertId };
}

async function syncAttributesAndAddress(pool, oldPool, oldUserId, newUserId, newPdId) {
  // Attributes are keyed by pd_id (dc_patient_details.pd_id), so we need
  // the OLD db's pd_id for this user to find their old attributes row.
  const [oldPdRows] = await oldPool.query(
    `SELECT pd_id FROM dc_patient_details WHERE user_id_fk = ?`, [oldUserId]
  );
  if (oldPdRows.length === 0) return { action: 'none' };
  const oldPdId = oldPdRows[0].pd_id;

  const [oldAttrRows] = await oldPool.query(
    `SELECT * FROM vf_attributes WHERE pd_id = ?`, [oldPdId]
  );
  if (oldAttrRows.length === 0) return { action: 'none' };
  const old = oldAttrRows[0];

  const [existingAttrRows] = await pool.query(
    `SELECT id FROM vf_attributes WHERE pd_id = ?`, [newPdId]
  );

  let newAttrId;
  if (existingAttrRows.length > 0) {
    newAttrId = existingAttrRows[0].id;
    await pool.query(
      `UPDATE vf_attributes SET
         first_name = ?, last_name = ?, phone = ?, dob = ?, height = ?, weight = ?,
         gender = ?, identify = ?, ethnic_group = ?, lookup_table = ?, smoking = ?,
         start_date = ?, mobile_app_save = ?, extra = ?, chart_number = ?,
         account_type = ?, welcome_method = ?
       WHERE id = ?`,
      [old.first_name, old.last_name, old.phone, old.dob, old.height, old.weight,
       old.gender, old.identify, old.ethnic_group, old.lookup_table, !!old.smoking,
       old.start_date, old.mobile_app_save, old.extra, old.chart_number,
       old.account_type, old.welcome_method, newAttrId]
    );
  } else {
    const [result] = await pool.query(
      `INSERT INTO vf_attributes
         (first_name, last_name, phone, dob, height, weight, gender, identify,
          ethnic_group, lookup_table, smoking, start_date, pd_id, mobile_app_save,
          extra, chart_number, account_type, welcome_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [old.first_name, old.last_name, old.phone, old.dob, old.height, old.weight,
       old.gender, old.identify, old.ethnic_group, old.lookup_table, !!old.smoking,
       old.start_date, newPdId, old.mobile_app_save, old.extra, old.chart_number,
       old.account_type, old.welcome_method]
    );
    newAttrId = result.insertId;
  }

  // Address — simplest correct approach: delete any existing addresses for
  // this attributes row and re-insert from old DB, avoiding duplicate-vs-
  // stale-partial-match ambiguity (a patient has very few addresses, so
  // this is cheap).
  await pool.query(`DELETE FROM vf_address WHERE attributes_id = ?`, [newAttrId]);
  const [oldAddresses] = await oldPool.query(
    `SELECT street, city, state, zip FROM vf_address WHERE attributes_id = ?`, [old.id]
  );
  for (const addr of oldAddresses) {
    await pool.query(
      `INSERT INTO vf_address (street, city, state, zip, attributes_id) VALUES (?, ?, ?, ?, ?)`,
      [addr.street, addr.city, addr.state, addr.zip, newAttrId]
    );
  }

  return { action: existingAttrRows.length > 0 ? 'updated' : 'created', addressCount: oldAddresses.length };
}

async function syncDoctorDetails(pool, oldPool, oldUserId, newUserId) {
  const [oldRows] = await oldPool.query(
    `SELECT * FROM dc_doctor_details WHERE user_id_fk = ?`, [oldUserId]
  );
  if (oldRows.length === 0) return { action: 'none' };
  const old = oldRows[0];

  const [existingRows] = await pool.query(
    `SELECT dd_id FROM dc_doctor_details WHERE user_id_fk = ?`, [newUserId]
  );

  if (existingRows.length > 0) {
    await pool.query(
      `UPDATE dc_doctor_details SET
         about_doctor = ?, education = ?, license_no = ?, is_specialist = ?,
         experience = ?, is_writer = ?, h_id_fk = ?, ps_id_fk = ?
       WHERE user_id_fk = ?`,
      [old.about_doctor, old.education, old.license_no, !!old.is_specialist,
       old.experience, !!old.is_writer, old.h_id_fk, old.ps_id_fk, newUserId]
    );
    return { action: 'updated' };
  }

  // NOTE: h_id_fk (hospital -> vf_account) references an account ID that
  // must already exist in the NEW db. Since vf_account was fully migrated
  // from ande_db already (step 02), and both DBs' accounts should trace
  // back to the same source, this is expected to resolve correctly — but
  // isn't explicitly re-validated here. If this insert fails with a FK
  // error, the account itself may need investigating.
  try {
    await pool.query(
      `INSERT INTO dc_doctor_details
         (about_doctor, education, license_no, is_specialist, experience,
          is_writer, h_id_fk, ps_id_fk, user_id_fk)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [old.about_doctor, old.education, old.license_no, !!old.is_specialist,
       old.experience, !!old.is_writer, old.h_id_fk, old.ps_id_fk, newUserId]
    );
    return { action: 'created' };
  } catch (err) {
    return { action: 'skipped', error: err.code || err.message };
  }
}

async function run() {
  logger.step('Step 13: Syncing patient/doctor details from OLD live database');
  const pool = await getMysqlPool();
  const oldPool = await getOldMergeDbPool();

  const checkpoint = await getCheckpoint(STEP);
  if (checkpoint?.status === 'complete') {
    logger.info(`Old-DB patient/doctor details sync already complete (${checkpoint.rows_done} users). Skipping.`);
    return;
  }

  const mappings = await getUserMappings(pool);
  const startIndex = checkpoint?.last_source_id ? parseInt(checkpoint.last_source_id, 10) : 0;
  let rowsDone = checkpoint?.rows_done || 0;

  let patientCreated = 0, patientUpdated = 0;
  let attrCreated = 0, attrUpdated = 0;
  let doctorCreated = 0, doctorUpdated = 0, doctorSkipped = 0;

  for (let i = startIndex; i < mappings.length; i++) {
    const { old_user_id, new_user_id } = mappings[i];

    const patientResult = await syncPatientDetails(pool, oldPool, old_user_id, new_user_id);
    if (patientResult.action === 'created') patientCreated++;
    if (patientResult.action === 'updated') patientUpdated++;

    if (patientResult.pdId) {
      const attrResult = await syncAttributesAndAddress(pool, oldPool, old_user_id, new_user_id, patientResult.pdId);
      if (attrResult.action === 'created') attrCreated++;
      if (attrResult.action === 'updated') attrUpdated++;
    }

    const doctorResult = await syncDoctorDetails(pool, oldPool, old_user_id, new_user_id);
    if (doctorResult.action === 'created') doctorCreated++;
    if (doctorResult.action === 'updated') doctorUpdated++;
    if (doctorResult.action === 'skipped') {
      doctorSkipped++;
      logger.warn(`Doctor details skipped for user (new id ${new_user_id}): ${doctorResult.error}`);
    }

    rowsDone++;
    if (rowsDone % 100 === 0) {
      await saveCheckpoint(STEP, i + 1, rowsDone);
      logger.progress('users_processed_for_details_sync', rowsDone, mappings.length);
    }
  }

  await saveCheckpoint(STEP, mappings.length, rowsDone);
  logger.info(`Patient/doctor details sync complete. Processed ${rowsDone} users. ` +
    `Patient details: ${patientCreated} created, ${patientUpdated} updated. ` +
    `Attributes: ${attrCreated} created, ${attrUpdated} updated. ` +
    `Doctor details: ${doctorCreated} created, ${doctorUpdated} updated, ${doctorSkipped} skipped.`);
  await markComplete(STEP, rowsDone);
}

module.exports = { run };
