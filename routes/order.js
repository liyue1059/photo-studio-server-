const express = require('express');
const crypto = require('crypto');
const db = require('../utils/db');
const config = require('../config');
const redis = require('../utils/redis');
const { authMiddleware } = require('../middleware/auth');
const wxpay = require('../utils/wxpay');
const { applyMembership } = require('../utils/membership');

const router = express.Router();
router.use(authMiddleware);

// 商品描述（微信要求 ≤127 字符）
const PAY_DESCRIPTIONS = {
  single: '时光照相馆-单次处理',
  trial: '时光照相馆-试用包月',
  monthly: '时光照相馆-月度会员',
  quarter: '时光照相馆-季度会员',
  halfYear: '时光照相馆-半年会员',
  yearly: '时光照相馆-年度会员'
};

function generateOrderNo() {
  // 时间戳 + 密码学安全随机串，避免 Math.random 可被预测枚举
  const ts = Date.now().toString();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return 'PS' + ts + rand;
}

// Create order
router.post('/create', async (req, res) => {
  try {
    const { payType } = req.body;
    const pricing = config.pricing;

    let amount;
    if (payType === 'single') amount = pricing.single;
    else if (payType === 'trial' || payType === 'monthly') amount = pricing.monthly;
    else if (payType === 'quarter') amount = pricing.quarter;
    else if (payType === 'halfYear') amount = pricing.halfYear;
    else if (payType === 'yearly') amount = pricing.yearly;
    else return res.status(400).json({ code: 400, message: 'Invalid payType' });

    const orderNo = generateOrderNo();

    await db.query(
      'INSERT INTO orders (user_id, order_no, amount, pay_type, pay_status, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      // amount 单位为「分」，除以 100 转为「元」入库（DECIMAL 列，避免浮点误差）
      [req.userId, orderNo, amount / 100, payType, 'pending']
    );

    // 真实微信支付已就绪：调用 JSAPI 下单并返回真实支付参数
    if (wxpay.isEnabled()) {
      try {
        const prepayId = await wxpay.createJsapiOrder({
          description: PAY_DESCRIPTIONS[payType] || '时光照相馆-会员开通',
          outTradeNo: orderNo,
          total: amount, // 单位：分
          openid: req.openid
        });
        const payParams = wxpay.buildPayParams(prepayId);

        // 缓存订单信息供回调校验（含 openid）
        await redis.set('order:' + orderNo, {
          userId: req.userId,
          openid: req.openid,
          amount,
          payType,
          status: 'pending'
        }, 3600);

        return res.json({ code: 0, data: { ...payParams, orderNo } });
      } catch (payErr) {
        console.error('[wxpay] 下单失败：', payErr.message);
        return res.status(500).json({ code: 500, message: '微信支付下单失败：' + payErr.message });
      }
    }

    // 开发态：返回 mock 支付参数（真实凭证就绪后上面的分支会自动接管）
    const payParams = {
      timeStamp: Math.floor(Date.now() / 1000).toString(),
      nonceStr: crypto.randomBytes(16).toString('hex'),
      package: 'prepay_id=' + crypto.randomBytes(16).toString('hex'),
      signType: 'RSA',
      paySign: 'mock_sign_for_development'
    };

    await redis.set('order:' + orderNo, { userId: req.userId, amount, payType, status: 'pending' }, 3600);

    res.json({ code: 0, data: { ...payParams, orderNo } });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// Verify order（仅开发态使用：真实支付以微信回调 /api/pay/callback 为准）
router.post('/verify', async (req, res) => {
  if (wxpay.isEnabled()) {
    return res.status(400).json({ code: 400, message: '真实支付请以微信支付回调为准，verify 接口已禁用' });
  }
  try {
    const { orderNo } = req.body;
    const orderData = await redis.get('order:' + orderNo);

    if (!orderData || orderData.status !== 'pending') {
      return res.status(400).json({ code: 400, message: 'Order not found or already processed' });
    }

    await db.query(
      'UPDATE orders SET pay_status = ?, paid_at = NOW() WHERE order_no = ?',
      ['paid', orderNo]
    );

    await applyMembership(req.userId, orderData.payType);

    await redis.del('order:' + orderNo);

    res.json({ code: 0, message: 'Payment verified' });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// Get order status
router.get('/status', async (req, res) => {
  try {
    const { orderNo } = req.query;
    if (!orderNo) {
      return res.status(400).json({ code: 400, message: 'orderNo is required' });
    }
    const rows = await db.query(
      'SELECT order_no, amount, pay_type, pay_status, created_at FROM orders WHERE order_no = ? AND user_id = ?',
      [orderNo, req.userId]
    );
    const row = rows[0];
    // 统一以驼峰返回，便于前端（orders / membership 页面）直接消费
    const data = row ? {
      orderNo: row.order_no,
      amount: row.amount,
      payType: row.pay_type,
      payStatus: row.pay_status,
      createdAt: row.created_at
    } : null;
    res.json({ code: 0, data });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// List orders
router.get('/list', async (req, res) => {
  try {
    // 边界防御：page 最小 1，limit 限制在 1~100，避免 offset 为负或一次拉取过多
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const rows = await db.query(
      'SELECT id, order_no, amount, pay_type, pay_status, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [req.userId, limit, offset]
    );
    // 统一以驼峰返回
    const list = rows.map((r) => ({
      id: r.id,
      orderNo: r.order_no,
      amount: r.amount,
      payType: r.pay_type,
      payStatus: r.pay_status,
      createdAt: r.created_at
    }));
    res.json({ code: 0, data: { list, page, limit } });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

module.exports = router;
