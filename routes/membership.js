const express = require('express');
const db = require('../utils/db');
const redis = require('../utils/redis');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Get membership status
router.get('/status', async (req, res) => {
  try {
    // Try cache first
    const cached = await redis.get('membership:' + req.userId);
    if (cached) {
      return res.json({ code: 0, data: cached });
    }

    const rows = await db.query(
      'SELECT * FROM memberships WHERE user_id = ? AND status = 1 ORDER BY id DESC LIMIT 1',
      [req.userId]
    );

    let membership = {
      isVip: false,
      remainCount: 0,
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
