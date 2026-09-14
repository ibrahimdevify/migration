#!/usr/bin/env node
// verify.js
// Run AFTER migration to sanity-check row counts between source and target.
// Prints only counts — never row contents.

require('dotenv').config();
const { andeDb, portalDb, getMysqlPool, closeAll } = require('./db');
const logger = require('./logger');

async function countPg(pool, table) {
  const { rows } = await pool.query(`SELECT COUNT(*) FROM ${table}`);
  return parseInt(rows[0].count, 10);
}

async function countMysql(pool, table) {
  const [rows] = await pool.query(`SELECT COUNT(*) as c FROM ${table}`);
  return rows[0].c;
}

async function main() {
  const mysqlPool = await getMysqlPool();

  logger.step('Verification: source vs target row counts');

  // --- ande_db-sourced tables ---
  const andeChecks = [
    { source: 'authenticator_account', target: 'vf_account' },
    { source: 'authenticator_patientgroup', target: 'vf_patient_group' },
    { source: 'authenticator_andeuser', target: 'dc_users' },
  ];
  for (const check of andeChecks) {
    const sourceCount = await countPg(andeDb, check.source);
    const targetCount = await countMysql(mysqlPool, check.target);
    logger.info(`[ande_db] ${check.source} (${sourceCount}) -> ${check.target} (${targetCount})`);
  }

  // --- portal_db user linking check ---
  const portalUserCount = await countPg(portalDb, 'dashboard_user');
  const [mapRows] = await mysqlPool.query(
    `SELECT COUNT(*) as c FROM _migration_id_map WHERE source_db = 'portal_db' AND source_table = 'dashboard_user'`
  );
  const linkedCount = mapRows[0].c;
  logger.info(`[portal_db] dashboard_user (${portalUserCount}) -> linked mappings (${linkedCount})`);
  if (portalUserCount !== linkedCount) {
    logger.warn(`Mismatch: ${portalUserCount - linkedCount} portal_db users have no recorded mapping.`);
  }

  // --- breakdown of dc_users by origin ---
  const [totalUsers] = await mysqlPool.query(`SELECT COUNT(*) as c FROM dc_users`);
  const [needsReset] = await mysqlPool.query(
    `SELECT COUNT(*) as c FROM dc_users WHERE password = 'MIGRATED_NEEDS_PASSWORD_RESET'`
  );
  logger.info(`[dc_users] total rows: ${totalUsers[0].c} (of which ${needsReset[0].c} are ` +
    `portal-only accounts needing a password reset before they can log in)`);

  // --- clinical data checks ---
  const clinicalChecks = [
    { source: 'dashboard_observation', target: 'portal_observation' },
    { source: 'dashboard_spirometry', target: 'portal_spirometry' },
    { source: 'dashboard_flow', target: 'portal_flow' },
    { source: 'dashboard_volume', target: 'portal_volume' },
    { source: 'dashboard_stepsobservations', target: 'portal_steps_observations' },
    { source: 'dashboard_indoorairquality', target: 'portal_indoor_air_quality' },
    { source: 'dashboard_notes', target: 'portal_notes' },
    { source: 'dashboard_alert', target: 'portal_alert' },
    { source: 'dashboard_alertnotification', target: 'portal_alert_notification' },
    { source: 'dashboard_heartrateobservations', target: 'portal_heart_rate_observations' },
  ];
  for (const check of clinicalChecks) {
    const sourceCount = await countPg(portalDb, check.source);
    const targetCount = await countMysql(mysqlPool, check.target);
    const diff = sourceCount - targetCount;
    const flag = diff === 0 ? 'OK' : `DIFF of ${diff}`;
    logger.info(`[portal_db] ${check.source} (${sourceCount}) -> ${check.target} (${targetCount})  [${flag}]`);
  }

  // predicted_value isn't 1:1 with spirometry rows (up to 4 rows each), so
  // just report the raw count for a sanity glance rather than a strict diff.
  const predictedCount = await countMysql(mysqlPool, 'portal_predicted_value');
  const spiroCount = await countPg(portalDb, 'dashboard_spirometry');
  logger.info(`[portal_db] dashboard_spirometry (${spiroCount} rows) -> ` +
    `portal_predicted_value (${predictedCount} rows, up to 4 per spirometry row expected)`);

  await closeAll();
}

main();
