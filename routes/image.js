const express = require('express');
const db = require('../utils/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Get image history count
router.get('/count', async (req, res) => {
  try {
    const rows = await db.query(
      'SELECT COUNT(*) as count FROM images WHERE user_id = ? AND is_deleted = 0',
      [req.userId]
    );
    res.json({ code: 0, data: { count: rows[0].count } });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// List image history
router.get('/list', async (req, res) => {
  try {
    const { page = 1, limit = 20, funcType } = req.query;
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset = (safePage - 1) * safeLimit;

    let sql = 'SELECT * FROM images WHERE user_id = ? AND is_deleted = 0';
    const params = [req.userId];

    if (funcType) {
      sql += ' AND func_type = ?';
      params.push(funcType);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(safeLimit, offset);

    const rows = await db.query(sql, params);
    res.json({ code: 0, data: { list: rows, page: safePage, limit: safeLimit } });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// Save image record
router.post('/save', async (req, res) => {
  try {
    const { originUrl, resultUrl, funcType } = req.body || {};
    // 必填校验，避免插入 undefined / NULL 行
    if (!originUrl || !resultUrl || !funcType) {
      return res.status(400).json({ code: 400, message: 'originUrl、resultUrl、funcType 均为必填' });
    }
    // funcType 边界：限制为合法字符串，防止异常类型入库
    if (typeof funcType !== 'string' || funcType.length === 0 || funcType.length > 32) {
      return res.status(400).json({ code: 400, message: 'funcType 不合法' });
    }
    const result = await db.query(
      'INSERT INTO images (user_id, origin_url, result_url, func_type, created_at) VALUES (?, ?, ?, ?, NOW())',
      [req.userId, originUrl, resultUrl, funcType]
    );
    res.json({ code: 0, data: { id: result.insertId } });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// Soft delete image
router.delete('/:id', async (req, res) => {
  try {
    await db.query(
      'UPDATE images SET is_deleted = 1 WHERE id = ? AND user_id = ?',
      [req.params.id, req.userId]
    );
    res.json({ code: 0, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

module.exports = router;
