const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../utils/db');
const redis = require('../utils/redis');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/auth/login
 * WeChat code for session
 */
router.post('/login', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ code: 400, message: 'code is required' });
    }

    // Exchange code for openid（带超时，避免微信接口卡住占满连接）
    const wxRes = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: {
        appid: config.wechat.appId,
        secret: config.wechat.secret,
        js_code: code,
        grant_type: 'authorization_code'
      },
      timeout: 5000
    });

    const { openid, unionid, errcode, errmsg } = wxRes.data;

    if (errcode) {
      console.error('WeChat login error:', errmsg);
      return res.status(400).json({ code: 400, message: 'WeChat login failed: ' + errmsg });
    }

    // 微信偶发返回既无 errcode 也无 openid —— 必须以 undefined 查库，
    // 否则会新建一条 openid=NULL 的脏用户。此处直接拦截。
    if (!openid) {
      console.error('WeChat login error: no openid returned');
      return res.status(400).json({ code: 400, message: '微信登录失败：未获取到 openid' });
    }

    // Find or create user（并发首登的唯一键冲突已做回退处理）
    let userId;
    const existing = await db.query('SELECT id FROM users WHERE openid = ?', [openid]);
    if (existing.length === 0) {
      try {
        const result = await db.query(
          'INSERT INTO users (openid, unionid, created_at, updated_at) VALUES (?, ?, NOW(), NOW())',
          [openid, unionid || '']
        );
        userId = result.insertId;
      } catch (insertErr) {
        // 并发首登触发唯一键冲突：回退查询已存在记录
        const rows = await db.query('SELECT id FROM users WHERE openid = ?', [openid]);
        if (rows.length === 0) throw insertErr;
        userId = rows[0].id;
      }
    } else {
      userId = existing[0].id;
      // Update unionid if provided
      if (unionid) {
        await db.query('UPDATE users SET unionid = ?, updated_at = NOW() WHERE id = ?', [unionid, userId]);
      }
    }

    // Generate JWT
    const token = jwt.sign(
      { userId, openid },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    // Get user profile
    const profile = await db.query(
      'SELECT id, openid, nickname, avatar_url, phone, created_at FROM users WHERE id = ?',
      [userId]
    );

    res.json({
      code: 0,
      data: {
        token,
        userInfo: profile[0]
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ code: 500, message: 'Server error' });
  }
});

module.exports = router;
