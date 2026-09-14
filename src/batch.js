// batch.js
//
// Reads a large Postgres table in fixed-size batches using keyset
// pagination (WHERE id > lastId ORDER BY id LIMIT n), rather than loading
// the whole table into memory or using slow OFFSET pagination.
//
// `idColumn` must be sortable (int, or uuid works fine with ORDER BY too,
// though for pure UUID tables you may prefer ordering by a creation
// timestamp column if one exists, since UUIDs don't sort meaningfully).

async function* batchedFetch(pgPool, { table, idColumn, batchSize, startAfterId = null }) {
  let lastId = startAfterId;

  while (true) {
    const params = [];
    let where = '';
    if (lastId !== null) {
      params.push(lastId);
      where = `WHERE ${idColumn} > $${params.length}`;
    }
    params.push(batchSize);

    const sql = `
      SELECT * FROM ${table}
      ${where}
      ORDER BY ${idColumn} ASC
      LIMIT $${params.length}
    `;

    const { rows } = await pgPool.query(sql, params);
    if (rows.length === 0) break;

    yield rows;

    lastId = rows[rows.length - 1][idColumn];
    if (rows.length < batchSize) break; // last page
  }
}

module.exports = { batchedFetch };
