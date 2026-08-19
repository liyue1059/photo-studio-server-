const mysql = require('mysql2/promise');
const config = require('../config');

let pool = null;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool(config.db);
    // Test connection
    const conn = await pool.getConnection();
    conn.release();
    console.log('MySQL connected');
  }
  return pool;
}

async function query(sql, params = []) {
  const pool = await getPool();
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function transaction(callback) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await callback(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { query, transaction, getPool };
