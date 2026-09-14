// logger.js
// CRITICAL: This logger only ever prints counts, table names, and numeric/UUID
// IDs — never actual row data (names, emails, phone numbers, diagnoses, etc.)
// If you add new log lines elsewhere in this project, follow the same rule.

function ts() {
  return new Date().toISOString();
}

const logger = {
  info(msg) {
    console.log(`[${ts()}] INFO  ${msg}`);
  },
  step(msg) {
    console.log(`\n[${ts()}] ==== ${msg} ====`);
  },
  progress(table, done, total) {
    const pct = total ? ((done / total) * 100).toFixed(1) : '0.0';
    console.log(`[${ts()}] ${table}: ${done}/${total} (${pct}%)`);
  },
  warn(msg) {
    console.warn(`[${ts()}] WARN  ${msg}`);
  },
  error(msg, err) {
    // Only print the error message/stack (code-level), never the row/payload
    // that triggered it.
    console.error(`[${ts()}] ERROR ${msg}`);
    if (err) console.error(err.message || err);
  },
};

module.exports = logger;
