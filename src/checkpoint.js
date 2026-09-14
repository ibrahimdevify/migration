// checkpoint.js
//
// Tracks migration progress per step, so if the script crashes or is
// stopped partway through a huge table, re-running it picks up where it
// left off instead of starting over (and instead of re-inserting
// duplicate rows). Stored as a small table in vitalflo_db — IDs/counts only.

const { getMysqlPool } = require('./db');

async function ensureCheckpointTable() {
  const pool = await getMysqlPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migration_checkpoint (
      step_name VARCHAR(100) PRIMARY KEY,
      last_source_id VARCHAR(64) DEFAULT NULL,
      rows_done BIGINT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'in_progress',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);
}

async function getCheckpoint(stepName) {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT * FROM _migration_checkpoint WHERE step_name = ?`,
    [stepName]
  );
  return rows[0] || null;
}

async function saveCheckpoint(stepName, lastSourceId, rowsDone, status = 'in_progress') {
  const pool = await getMysqlPool();
  await pool.query(
    `INSERT INTO _migration_checkpoint (step_name, last_source_id, rows_done, status)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE last_source_id = VALUES(last_source_id),
       rows_done = VALUES(rows_done), status = VALUES(status)`,
    [stepName, lastSourceId ? String(lastSourceId) : null, rowsDone, status]
  );
}

async function markComplete(stepName, rowsDone) {
  await saveCheckpoint(stepName, null, rowsDone, 'complete');
}

module.exports = { ensureCheckpointTable, getCheckpoint, saveCheckpoint, markComplete };
