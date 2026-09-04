const express = require('express');
const db = require('../utils/db');
const redis = require('../utils/redis');
const config = require('../config');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// 每日看广告可领取免费额度的上限（防刷；可通过 AD_DAILY_CAP 环境变量调整）
const DAILY_CAP = (config.ad && config.ad.dailyCap) || 5;
const FREE_TRIALS = (config.membership && config.membership.freeTrials) || 2;

// 距当天本地零点剩余的秒数（用于 Redis 计数器自动过期，次日清零）
function secondsUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  return Math.max(1, Math.ceil((midnight - now) / 1000));
}

/**
 * POST /api/ad/watch
 * 前端在激励视频广告「完整播放」（isEnded=true）后调用本接口发放额度。
 * 防刷：Redis 按 userId+日期 计数，达 DAILY_CAP 即拒绝；不依赖客户端是否真看完，
 * 但仅当广告完整播放才允许前端调用（前端在 onClose.isEnded 为真时才请求）。
 */
router.post('/watch', async (req, res) => {
  try {
    const userId = req.userId;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const counterKey = 'ad:grant:' + userId + ':' + today;

    // 1) 每日上限预检
    let used = parseInt((await redis.get(counterKey)) || '0', 10);
    if (used >= DAILY_CAP) {
      return res.json({
        code: 1,
        message: '今日观看次数已达上限（' + DAILY_CAP + '次），明天再来吧',
        data: { remainCount: null, dailyLeft: 0 }
      });
    }

    // 2) 会员（plan_type !== 'single'，remain_count = -1）无需看广告
    let rows = await db.query(
      'SELECT id, plan_type, status FROM memberships WHERE user_id = ? AND status = 1 ORDER BY id DESC LIMIT 1',
      [userId]
    );
    if (rows.length && rows[0].plan_type !== 'single') {
      return res.json({
        code: 1,
        message: '您已是会员，无需观看广告',
        data: { remainCount: -1, dailyLeft: DAILY_CAP - used }
      });
    }

    // 3) 懒初始化 single 试用行（与 /status 同款，幂等）
    if (rows.length === 0) {
      await db.query(
        `INSERT INTO memberships (user_id, plan_type, remain_count, status, start_date, end_date)
         SELECT ?, 'single', ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL 365 DAY)
         WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ? AND status = 1)`,
        [userId, FREE_TRIALS, userId]
      );
      rows = await db.query(
        "SELECT id FROM memberships WHERE user_id = ? AND status = 1 AND plan_type = 'single' ORDER BY id DESC LIMIT 1",
        [userId]
      );
    }

    // 4) 计数 +1（原子 incr），首次写入时设置 TTL 到当天零点
    const newUsed = await redis.incr(counterKey);
    if (newUsed === 1) {
      await redis.set(counterKey, newUsed, secondsUntilMidnight());
    }
    if (newUsed > DAILY_CAP) {
      return res.json({
        code: 1,
        message: '今日观看次数已达上限（' + DAILY_CAP + '次），明天再来吧',
        data: { remainCount: null, dailyLeft: 0 }
      });
    }

    // 5) +1 次免费额度
    await db.query(
      "UPDATE memberships SET remain_count = remain_count + 1 WHERE user_id = ? AND plan_type = 'single' AND status = 1",
      [userId]
    );

    // 6) 清理会员缓存，读取最新 remainCount 返回
    await redis.del('membership:' + userId);
    const fresh = await db.query(
      "SELECT remain_count FROM memberships WHERE user_id = ? AND status = 1 AND plan_type = 'single' ORDER BY id DESC LIMIT 1",
      [userId]
    );
    const remainCount = fresh.length ? fresh[0].remain_count : FREE_TRIALS;

    res.json({
      code: 0,
      message: '已获得 1 次免费额度',
      data: { remainCount, dailyLeft: DAILY_CAP - newUsed }
    });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

module.exports = router;
