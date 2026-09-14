// idMap.js
//
// Since ande_db uses UUID primary keys and vitalflo_db uses auto-increment
// integers, every migrated row needs its old ID mapped to its new ID so that
// foreign keys can be rewritten correctly. This is stored as a table INSIDE
// vitalflo_db itself (not a separate file), so it's easy to inspect, resume
// from, and doesn't sit around locally after the migration.
//
// It stores only IDs (UUIDs / integers), never any personal data.

const { getMysqlPool } = require('./db');

async function ensureIdMapTable() {
  const pool = await getMysqlPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migration_id_map (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      source_db VARCHAR(50) NOT NULL,
      source_table VARCHAR(100) NOT NULL,
      source_id VARCHAR(64) NOT NULL,
      target_table VARCHAR(100) NOT NULL,
      target_id BIGINT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_source (source_db, source_table, source_id, target_table)
    ) ENGINE=InnoDB;
  `);
}

async function recordMapping(sourceDb, sourceTable, sourceId, targetTable, targetId) {
  const pool = await getMysqlPool();
  await pool.query(
    `INSERT INTO _migration_id_map (source_db, source_table, source_id, target_table, target_id)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE target_id = VALUES(target_id)`,
    [sourceDb, sourceTable, String(sourceId), targetTable, targetId]
  );
}

async function getMapping(sourceDb, sourceTable, sourceId, targetTable) {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT target_id FROM _migration_id_map
     WHERE source_db = ? AND source_table = ? AND source_id = ? AND target_table = ?
     LIMIT 1`,
    [sourceDb, sourceTable, String(sourceId), targetTable]
  );
  return rows.length ? rows[0].target_id : null;
}

// Bulk-load a whole mapping (source_id -> target_id) into memory for a given
// source table, so per-row lookups during a big migration don't each hit
// the database individually.
async function loadMappingCache(sourceDb, sourceTable, targetTable) {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT source_id, target_id FROM _migration_id_map
     WHERE source_db = ? AND source_table = ? AND target_table = ?`,
    [sourceDb, sourceTable, targetTable]
  );
  const cache = new Map();
  for (const row of rows) cache.set(row.source_id, row.target_id);
  return cache;
}

module.exports = { ensureIdMapTable, recordMapping, getMapping, loadMappingCache };
