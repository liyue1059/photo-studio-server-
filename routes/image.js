const express = require('express');
const db = require('../utils/db');
const { authMiddleware } = require('../middleware/auth');
const cloudStorage = require('../utils/cloud-storage');

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

    // 若存的是 cloud:// fileID（callContainer 改造后首选），按需批量换为临时链接，
    // 绕过临时链接过期——保证用户素材库长期可访问（根治「容器重启丢图」后半段）。
    if (cloudStorage.cloudStorageEnabled()) {
      const ids = [];
      rows.forEach((r) => {
        if (cloudStorage.isCloudFileId(r.origin_url)) ids.push(r.origin_url);
        if (cloudStorage.isCloudFileId(r.result_url)) ids.push(r.result_url);
      });
      if (ids.length) {
        const resolved = await cloudStorage.resolveStoredUrls(ids);
        const map = {};
        ids.forEach((id, i) => { map[id] = resolved[i]; });
        rows.forEach((r) => {
          if (map[r.origin_url]) r.origin_url = map[r.origin_url];
          if (map[r.result_url]) r.result_url = map[r.result_url];
        });
      }
    }

    res.json({ code: 0, data: { list: rows, page: safePage, limit: safeLimit } });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// Save image record
router.post('/save', async (req, res) => {
  try {
    // 兼容两种来源：fileId（cloud://，永久，callContainer 改造后首选）或 URL（旧链路 / 临时链接）。
    // 优先用 fileId；无则回退 URL。最终都落进 origin_url / result_url 列（列类型可存任一字符串）。
    const { originUrl, resultUrl, originFileId, resultFileId, funcType } = req.body || {};
    const origin = originFileId || originUrl;
    const result = resultFileId || resultUrl;
    // 必填校验，避免插入 undefined / NULL 行
    if (!origin || !result || !funcType) {
      return res.status(400).json({ code: 400, message: 'originUrl/originFileId、resultUrl/resultFileId、funcType 均为必填' });
    }
    // funcType 边界：限制为合法字符串，防止异常类型入库
    if (typeof funcType !== 'string' || funcType.length === 0 || funcType.length > 32) {
      return res.status(400).json({ code: 400, message: 'funcType 不合法' });
    }
    const row = await db.query(
      'INSERT INTO images (user_id, origin_url, result_url, func_type, created_at) VALUES (?, ?, ?, ?, NOW())',
      [req.userId, origin, result, funcType]
    );
    res.json({ code: 0, data: { id: row.insertId } });
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
