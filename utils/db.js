const mysql = require('mysql2/promise');
const config = require('../config');

let pool = null;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...config.db,
      // ────────────────────────────────────────────────────────────
      // 关键：CloudBase 容器网关/负载均衡对空闲连接有 ~60s 的硬切阈值。
      // 没有 keepalive，连接空闲 ~60s 后被网关静默切断，下一次查询
      // 抛 read ECONNRESET（线上 14:17:11 复现：登录首次 SELECT 即中招）。
      // 开启 keepalive 后，mysql2 会周期性发 TCP 心跳，网关看到连接仍活跃
      // 就不会切。keepAliveInitialDelay 设 30s 是经验值：比网关阈值宽，
      // 又不至于狂打心跳。
      // ────────────────────────────────────────────────────────────
      enableKeepAlive: true,
      keepAliveInitialDelay: 30000
    });
    // Test connection
    const conn = await pool.getConnection();
    conn.release();
    console.log('MySQL connected');
  }
  return pool;
}

// 仅对「瞬时网络错误」重试一次；语法错、约束冲突等业务错误原样上抛。
// 真实生产案例：CloudBase 网关偶尔把仍活跃的连接也切了（keepalive 失效），
// 此时 mysql2 内部已把坏连接踢出池子，第二次 pool.execute 会拿新连接。
function isTransientNetworkError(err) {
  if (!err) return false;
  return (
    err.code === 'ECONNRESET' ||
    err.code === 'PROTOCOL_CONNECTION_LOST' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'EAI_AGAIN' ||
    err.fatal === true
  );
}

async function query(sql, params = []) {
  const pool = await getPool();
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (err) {
    if (!isTransientNetworkError(err)) throw err;
    // 单次重试：mysql2 池子已自动移除坏连接，第二次 execute 会拿新连接。
    console.warn('[db] 瞬时网络错误，单次重试 | code =', err.code, '| sql =', sql.slice(0, 60));
    const [rows] = await pool.execute(sql, params);
    return rows;
  }
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
