// db.js
require('dotenv').config();
const { Pool } = require('pg');
const mysql = require('mysql2/promise');

const andeDb = new Pool({ connectionString: process.env.ANDE_DB_URL });
const portalDb = new Pool({ connectionString: process.env.PORTAL_DB_URL });

let mysqlPool;
async function getMysqlPool() {
  if (!mysqlPool) {
    mysqlPool = mysql.createPool({
      uri: process.env.VITALFLO_DB_URL,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 30000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      // IMPORTANT: never enable query logging that dumps bound parameters
      // (that would leak PII into terminal/log files).
    });
  }
  return mysqlPool;
}

// The OLD merged database — currently connected to the real/live project,
// and containing "delta" data (new signups + new activity) created after
// its own go-live, which the original ande_db/portal_db migration never
// saw. Same schema as the new database, both MySQL.
let oldMergeDbPool;
async function getOldMergeDbPool() {
  if (!oldMergeDbPool) {
    oldMergeDbPool = mysql.createPool({
      uri: process.env.OLD_VITALFLO_DB_URL,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 30000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
  }
  return oldMergeDbPool;
}

async function closeAll() {
  await andeDb.end();
  await portalDb.end();
  if (mysqlPool) await mysqlPool.end();
  if (oldMergeDbPool) await oldMergeDbPool.end();
}

module.exports = { andeDb, portalDb, getMysqlPool, getOldMergeDbPool, closeAll };
