// 01_lookups.js
//
// dc_user_type, dc_user_status, dc_gender, dc_martial_status do not exist as
// standalone tables in ande_db/portal_db — they were implicit (e.g. Django's
// separate user subtype tables, or free-text fields). These need to be
// seeded with a fixed, known set of values BEFORE users are migrated, since
// dc_users.ut_id_fk / us_id_fk are required (non-null) foreign keys.
//
// >>> REVIEW THESE VALUES BEFORE RUNNING <<<
// Adjust names/order to match whatever your application code expects.

const logger = require('../logger');
const { getMysqlPool } = require('../db');

const USER_TYPES = ['patient', 'doctor', 'clinician', 'account_admin', 'technician'];
const USER_STATUSES = ['active', 'inactive', 'unverified', 'suspended'];
const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'];
const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed', 'unknown'];

async function upsertLookup(pool, table, idCol, nameCol, values) {
  const map = new Map();
  for (const name of values) {
    const [existing] = await pool.query(
      `SELECT ${idCol} FROM ${table} WHERE ${nameCol} = ? LIMIT 1`,
      [name]
    );
    if (existing.length) {
      map.set(name, existing[0][idCol]);
      continue;
    }
    const [result] = await pool.query(
      `INSERT INTO ${table} (${nameCol}) VALUES (?)`,
      [name]
    );
    map.set(name, result.insertId);
  }
  return map;
}

async function run() {
  logger.step('Step 01: Seeding lookup tables');
  const pool = await getMysqlPool();

  const userTypeMap = await upsertLookup(pool, 'dc_user_type', 'ut_id', 'name', USER_TYPES);
  const userStatusMap = await upsertLookup(pool, 'dc_user_status', 'us_id', 'name', USER_STATUSES);
  const genderMap = await upsertLookup(pool, 'dc_gender', 'gender_id', 'name', GENDERS);
  const maritalMap = await upsertLookup(pool, 'dc_martial_status', 'ms_id', 'name', MARITAL_STATUSES);

  logger.info(`Seeded ${userTypeMap.size} user types, ${userStatusMap.size} statuses, ` +
    `${genderMap.size} genders, ${maritalMap.size} marital statuses.`);

  return { userTypeMap, userStatusMap, genderMap, maritalMap };
}

// Used by other steps (e.g. users) when run standalone via --only=,
// so they don't depend on lookups having run earlier in the same process.
async function loadExistingLookupMaps() {
  const pool = await getMysqlPool();

  async function loadMap(table, idCol, nameCol) {
    const [rows] = await pool.query(`SELECT ${idCol}, ${nameCol} FROM ${table}`);
    const map = new Map();
    for (const row of rows) map.set(row[nameCol], row[idCol]);
    return map;
  }

  return {
    userTypeMap: await loadMap('dc_user_type', 'ut_id', 'name'),
    userStatusMap: await loadMap('dc_user_status', 'us_id', 'name'),
    genderMap: await loadMap('dc_gender', 'gender_id', 'name'),
    maritalMap: await loadMap('dc_martial_status', 'ms_id', 'name'),
  };
}

module.exports = { run, loadExistingLookupMaps };
