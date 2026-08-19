const express = require('express');
const db = require('../utils/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

router.get('/profile', async (req, res) => {
  try {
    const rows = await db.query(
      'SELECT id, openid, nickname, avatar_url, phone, created_at FROM users WHERE id = ?',
      [req.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: 'User not found' });
    }
    res.json({ code: 0, data: rows[0] });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.put('/profile', async (req, res) => {
  try {
    const { nickname, avatarUrl, phone } = req.body;
    await db.query(
      'UPDATE users SET nickname = COALESCE(?, nickname), avatar_url = COALESCE(?, avatar_url), phone = COALESCE(?, phone), updated_at = NOW() WHERE id = ?',
      [nickname || null, avatarUrl || null, phone || null, req.userId]
    );
    res.json({ code: 0, message: 'Updated' });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

module.exports = router;
