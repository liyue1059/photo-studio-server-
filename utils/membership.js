/**
 * 会员权益写入工具（下单确认 / 支付回调共用）
 */
const db = require('./db');
const redis = require('./redis');

// 各套餐对应会员时长（天）
// 注意：续费语义当前为「覆盖」——end_date 从 NOW() 起算，而非在原有 end_date 上叠加。
// 若产品要求「到期日顺延」（叠加），需将下方 ON DUPLICATE KEY UPDATE 的
// end_date = DATE_ADD(NOW(), ...) 改为 DATE_ADD(GREATEST(end_date, NOW()), ...)。此为业务决策，暂不改。
const DURATIONS = {
  single: 0,    // 按次：不计时长，仅 +1 次
  trial: 30,    // 试用包月
  monthly: 30,  // 月度会员
  quarter: 90,  // 季度会员
  halfYear: 180, // 半年会员
  yearly: 365   // 年度会员
};

/**
 * 根据用户实际支付成功的套餐，写入 / 更新 memberships 表，并清理会员缓存。
 * @param {number} userId
 * @param {string} payType  single|trial|monthly|quarter|halfYear|yearly
 * @param {object} [conn]    可选事务连接；传入时走同一事务，保证与订单状态更新原子性
 */
async function applyMembership(userId, payType, conn = null) {
  // 未知套餐直接抛错，避免静默赠送 30 天会员
  if (!(payType in DURATIONS)) {
    throw new Error('Unknown payType: ' + payType);
  }

  // conn 优先（事务内），否则走连接池
  const exec = conn ? ((sql, p) => conn.execute(sql, p)) : ((sql, p) => db.query(sql, p));

  if (payType === 'single') {
    await exec(
      `INSERT INTO memberships (user_id, plan_type, remain_count, status, start_date, end_date)
       VALUES (?, ?, 1, 1, NOW(), DATE_ADD(NOW(), INTERVAL 365 DAY))
       ON DUPLICATE KEY UPDATE remain_count = remain_count + 1`,
      [userId, 'single']
    );
  } else {
    const duration = DURATIONS[payType];
    await exec(
      `INSERT INTO memberships (user_id, plan_type, start_date, end_date, status, remain_count)
       VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), 1, -1)
       ON DUPLICATE KEY UPDATE
         plan_type = ?, start_date = NOW(), end_date = DATE_ADD(NOW(), INTERVAL ? DAY), status = 1, remain_count = -1`,
      [userId, payType, duration, payType, duration]
    );
  }
  await redis.del('membership:' + userId);
}

/**
 * 校验用户当前是否有可用免费额度（用于生成/修复前拦截）。
 * @returns {Promise<'ok'|'vip'|'exhausted'>}
 *   ok       — single 试用行且 remain_count > 0，可消耗
 *   vip      — 会员（plan_type !== 'single'），无需消耗
 *   exhausted— 无 single 行或 remain_count <= 0，额度已用完
 */
async function checkQuota(userId) {
  const rows = await db.query(
    "SELECT plan_type, remain_count FROM memberships WHERE user_id = ? AND status = 1 ORDER BY id DESC LIMIT 1",
    [userId]
  );
  if (rows.length === 0) return 'exhausted';
  if (rows[0].plan_type !== 'single') return 'vip';
  if (rows[0].remain_count > 0) return 'ok';
  return 'exhausted';
}

/**
 * 实际扣减 1 次免费额度（仅在生成/修复成功时调用）。
 * 原子 UPDATE + `remain_count > 0` 守卫，保证不会扣成负数；
 * 会员（plan_type !== 'single'）行不受影响。
 * @returns {Promise<boolean>} 是否成功扣减（false 表示本就不是 single 行或已无额度）
 */
async function decrementQuota(userId) {
  const res = await db.query(
    "UPDATE memberships SET remain_count = remain_count - 1 WHERE user_id = ? AND plan_type = 'single' AND status = 1 AND remain_count > 0",
    [userId]
  );
  if (res.affectedRows > 0) {
    await redis.del('membership:' + userId);
    return true;
  }
  return false;
}

module.exports = { applyMembership, checkQuota, decrementQuota, DURATIONS };
