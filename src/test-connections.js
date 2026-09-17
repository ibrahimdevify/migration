#!/usr/bin/env node
// test-connections.js
// Run this BEFORE anything else to confirm all database connections work
// (ande_db, portal_db, the new vitalflo_db, and — if configured — the old
// live vitalflo_db used by the delta-sync steps). Prints only server info
// and row counts — never actual data.

require('dotenv').config();
const { Pool } = require('pg');
const mysql = require('mysql2/promise');

async function testPostgres(name, connectionString) {
  console.log(`\n--- Testing ${name} (PostgreSQL) ---`);
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 8000 });
  try {
    const { rows } = await pool.query('SELECT version(), current_database()');
    console.log(`✅ Connected. Database: ${rows[0].current_database}`);
    console.log(`   Server: ${rows[0].version.split(',')[0]}`);

    const { rows: countRows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name LIMIT 5
    `);
    console.log(`   Sample tables visible: ${countRows.map(r => r.table_name).join(', ')}`);
  } catch (err) {
    console.error(`❌ Failed to connect to ${name}: ${err.message}`);
  } finally {
    await pool.end();
  }
}

async function testMysql(name, uri) {
  console.log(`\n--- Testing ${name} (MySQL) ---`);
  try {
    const conn = await mysql.createConnection({ uri, connectTimeout: 8000 });
    const [rows] = await conn.query('SELECT VERSION() as version, DATABASE() as db');
    console.log(`✅ Connected. Database: ${rows[0].db}`);
    console.log(`   Server: MySQL ${rows[0].version}`);

    const [tables] = await conn.query('SHOW TABLES');
    console.log(`   Table count: ${tables.length}`);
    await conn.end();
  } catch (err) {
    console.error(`❌ Failed to connect to ${name}: ${err.message}`);
  }
}

async function main() {
  console.log('Testing all database connections defined in .env ...');

  const required = ['ANDE_DB_URL', 'PORTAL_DB_URL', 'VITALFLO_DB_URL'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`❌ Missing env vars: ${missing.join(', ')}. Check your .env file.`);
    process.exit(1);
  }

  await testPostgres('ande_db', process.env.ANDE_DB_URL);
  await testPostgres('portal_db', process.env.PORTAL_DB_URL);
  await testMysql('vitalflo_db (new/target)', process.env.VITALFLO_DB_URL);

  // Optional: only needed for the delta-sync steps (11, 12). Not required
  // for the main historical migration, so don't fail the whole script if
  // it's not set — just note it's being skipped.
  if (process.env.OLD_VITALFLO_DB_URL) {
    await testMysql('OLD vitalflo_db (live project)', process.env.OLD_VITALFLO_DB_URL);
  } else {
    console.log('\n--- Skipping OLD vitalflo_db (live project) ---');
    console.log('   OLD_VITALFLO_DB_URL not set — only needed for the delta-sync steps (11, 12).');
  }

  console.log('\nDone.');
}

main();
