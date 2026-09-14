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
      // IMPORTANT: never enable query logging that dumps bound parameters
      // (that would leak PII into terminal/log files).
    });
  }
  return mysqlPool;
}

async function closeAll() {
  await andeDb.end();
  await portalDb.end();
  if (mysqlPool) await mysqlPool.end();
}

module.exports = { andeDb, portalDb, getMysqlPool, closeAll };
