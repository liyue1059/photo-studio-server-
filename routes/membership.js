const express = require('express');
const db = require('../utils/db');
const redis = require('../utils/redis');
const config = require('../config');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// 新用户免费试用次数（唯一真相源，见 config.membership.freeTrials）
const FREE_TRIALS = (config.membership && config.membership.freeTrials) || 2;

// Get membership status
router.get('/status', async (req, res) => {
  try {
    // Try cache first
    const cached = await redis.get('membership:' + req.userId);
    if (cached) {
      return res.json({ code: 0, data: cached });
    }

    let rows = await db.query(
      'SELECT * FROM memberships WHERE user_id = ? AND status = 1 ORDER BY id DESC LIMIT 1',
      [req.userId]
    );

    // ── 懒初始化免费试用次数 ──────────────────────────────────────
    // 上线前漏了这一步：新用户（甚至已注册但因 bug 没拿到权益的用户）在 memberships
    // 表里没有任何行，/status 默认返回 remainCount:0，前端据此判「需付费」把三大功能全拦了。
    // 这里在「查不到任何 active 会员行」时补插一条 single 试用行（remain_count=FREE_TRIALS），
    // 让新用户直接拥有 FREE_TRIALS 次免费使用权。幂等：用 WHERE NOT EXISTS 防止并发双插。
    if (rows.length === 0) {
      await db.query(
        `INSERT INTO memberships (user_id, plan_type, remain_count, status, start_date, end_date)
         SELECT ?, 'single', ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL 365 DAY)
         WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ? AND status = 1)`,
        [req.userId, FREE_TRIALS, req.userId]
      );
      rows = await db.query(
        'SELECT * FROM memberships WHERE user_id = ? AND status = 1 ORDER BY id DESC LIMIT 1',
        [req.userId]
      );
    }

    // 兜底：理论上走到这里时 rows 必非空（上方已懒初始化）。
    // 但若 DB 异常导致插入未生效，仍用 FREE_TRIALS 兜底，保证已登录用户绝不被拦死。
    let membership = {
      isVip: false,
      remainCount: FREE_TRIALS,
      planType: 'free',
      startDate: null,
      endDate: null,
      daysLeft: 0
    };

    if (rows.length > 0) {
      const row = rows[0];
      const now = new Date();
      const endDate = new Date(row.end_date);
      const daysLeft = Math.max(0, Math.ceil((endDate - now) / (1000 * 60 * 60 * 24)));

      if (row.plan_type !== 'single') {
        membership = {
          isVip: daysLeft > 0,
          remainCount: -1,
          planType: row.plan_type,
          startDate: row.start_date,
          endDate: row.end_date,
          daysLeft,
          autoRenew: row.auto_renew === 1
        };
      } else if (row.remain_count > 0) {
        membership = {
          isVip: false,
          remainCount: row.remain_count,
          planType: 'single',
          startDate: row.start_date,
          endDate: row.end_date,
          daysLeft,
          autoRenew: false
        };
      }
    }

    // Cache for 5 minutes
    await redis.set('membership:' + req.userId, membership, 300);

    res.json({ code: 0, data: membership });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

module.exports = router;
