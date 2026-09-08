'use strict';
/**
 * 虚拟支付路由（数字商品合规链路）
 *
 *   POST /api/vpay/order   下单：生成 outTradeNo + 签名后的 payData，前端拿去调 wx.requestVirtualPayment
 *   POST /api/vpay/notify  接收平台发货推送 xpay_goods_deliver_notify（公开接口，微信服务器回调）
 *   POST /api/vpay/query   查单 + 兜底发货（前端支付 success 后主动调一次；推送丢失时由此补发）
 *
 * 发货三原则（2026-09-08 按官方文档定型）：
 *   1. 前端 success 回调可能丢失，不作为发货依据；
 *   2. 发货以「发货推送」为主，推送丢失用 query_order 查单兜底；
 *   3. 发货前必向平台 query_order 二次确认，幂等以 orders.pay_status 原子更新为准
 *      （UPDATE ... WHERE pay_status <> 'paid' 抢占，抢不到就跳过发放，杜绝重复发权益）。
 */
const express = require('express');
const config = require('../config');
const db = require('../utils/db');
const redis = require('../utils/redis');
const { authMiddleware } = require('../middleware/auth');
const { applyMembership } = require('../utils/membership');
const vpay = require('../utils/vpay');

const router = express.Router();

const VALID_PAY_TYPES = ['single', 'trial', 'monthly', 'quarter', 'halfYear', 'yearly'];

const NOTIFY_OK = '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>';
const NOTIFY_RETRY = '<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[retry]]></ErrMsg></xml>';

/**
 * 发货（幂等）：标记订单已支付 + 按套餐发放会员权益。
 * 并发安全：pay_status 原子抢占，同一订单只有一次 UPDATE 会生效；
 * applyMembership 在同一事务内，保证「改单 + 发权益」原子性。
 */
async function deliverOrder(orderNo, wxOrderId) {
  const rows = await db.query(
    'SELECT user_id, pay_type, pay_status FROM orders WHERE order_no = ?',
    [orderNo]
  );
  if (rows.length === 0) {
    throw new Error('deliverOrder: order not found ' + orderNo);
  }
  const order = rows[0];
  if (order.pay_status === 'paid') {
    return { delivered: false, reason: 'already_paid' };
  }

  let claimed = false;
  await db.transaction(async (conn) => {
    const [result] = await conn.execute(
      "UPDATE orders SET pay_status = 'paid', transaction_id = ?, paid_at = NOW() WHERE order_no = ? AND pay_status <> 'paid'",
      [wxOrderId || '', orderNo]
    );
    // affectedRows === 0：并发下已被另一路径（notify/query）发货，跳过发放
    if (result.affectedRows > 0) {
      claimed = true;
      await applyMembership(order.user_id, order.pay_type, conn);
    }
  });

  if (claimed) {
    await redis.del('membership:' + order.user_id);
    console.log('[vpay] 发货完成:', orderNo, 'wx_order_id=', wxOrderId, 'payType=', order.pay_type);
  }
  return { delivered: claimed };
}

// ── 下单 ──────────────────────────────────────────────────────
router.post('/order', authMiddleware, async (req, res) => {
  try {
    if (!vpay.enabled()) {
      // 未开通：明确告知前端回退旧支付链路（HTTP 200 + enabled:false，不当作错误）
      return res.json({ code: 0, data: { enabled: false } });
    }

    const { payType } = req.body || {};
    if (!VALID_PAY_TYPES.includes(payType)) {
      return res.status(400).json({ code: 400, message: 'Invalid payType' });
    }
    const amountFen = config.pricing[payType];

    // sessionKey（用户态签名密钥）在登录时随 code2Session 存入 Redis；
    // 丢失（过期/被清）时返回 401，request.js 会自动重登（重登会刷新 session_key），前端再重试一次。
    const sessionKey = await redis.get('vpay_sessionkey:' + req.userId);
    if (!sessionKey) {
      return res.status(401).json({ code: 401, message: 'SESSION_KEY_MISSING' });
    }

    const outTradeNo = vpay.genOutTradeNo();
    const payData = vpay.buildOrderPayData({
      openid: req.openid,
      sessionKey,
      payType,
      outTradeNo
    });

    // 复用 orders 表（与微信支付同构：amount 元 DECIMAL / pay_status / transaction_id）
    await db.query(
      'INSERT INTO orders (user_id, order_no, amount, pay_type, pay_status, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [req.userId, outTradeNo, amountFen / 100, payType, 'pending']
    );
    await redis.set(
      'vpay_order:' + outTradeNo,
      { userId: req.userId, openid: req.openid, payType, amountFen },
      86400
    );

    return res.json({ code: 0, data: { enabled: true, orderNo: outTradeNo, payData } });
  } catch (err) {
    console.error('[vpay] 下单失败：', err.message);
    return res.status(500).json({ code: 500, message: '虚拟支付下单失败：' + err.message });
  }
});

// ── 发货推送（公开接口：微信服务器回调，XML 报文）────────────────
router.post('/notify', express.text({ type: () => true, limit: '256kb' }), async (req, res) => {
  try {
    const xml = typeof req.body === 'string' ? req.body : '';
    const notify = vpay.parseNotifyXml(xml);
    if (notify.event !== 'xpay_goods_deliver_notify') {
      // 非发货事件：直接确认，避免无意义重试
      return res.type('application/xml').send(NOTIFY_OK);
    }
    console.log('[vpay] 收到发货推送:', JSON.stringify(notify));

    const rows = await db.query('SELECT user_id FROM orders WHERE order_no = ?', [notify.outTradeNo]);
    if (rows.length === 0) {
      // 未知订单：重试也无济于事，确认接收并告警人工排查
      console.error('[vpay] 发货推送对应订单不存在:', notify.outTradeNo);
      return res.type('application/xml').send(NOTIFY_OK);
    }

    // 发货前向平台二次确认（query_order 结果为准）
    let confirmed = false;
    try {
      const q = await vpay.queryOrder(notify.openid, notify.outTradeNo);
      // errcode===0 且平台返回了订单 ⇒ 已支付。字段名以联调实测为准（见 utils/vpay.js 注释）。
      confirmed = q && q.errcode === 0 && q.order;
    } catch (e) {
      console.error('[vpay] query_order 确认失败，将重试:', e.message);
    }
    if (!confirmed) {
      return res.type('application/xml').send(NOTIFY_RETRY);
    }

    await deliverOrder(notify.outTradeNo, notify.wxOrderId);
    return res.type('application/xml').send(NOTIFY_OK);
  } catch (err) {
    console.error('[vpay] 发货推送处理异常：', err.message);
    return res.type('application/xml').send(NOTIFY_RETRY);
  }
});

// ── 查单 + 兜底发货（登录态：前端支付成功后主动调一次；也供定时兜底）──
router.post('/query', authMiddleware, async (req, res) => {
  try {
    if (!vpay.enabled()) {
      return res.status(400).json({ code: 400, message: '虚拟支付未开通' });
    }
    const { orderNo } = req.body || {};
    if (!orderNo) {
      return res.status(400).json({ code: 400, message: 'orderNo is required' });
    }

    const rows = await db.query('SELECT user_id, openid, pay_status FROM orders WHERE order_no = ?', [orderNo]);
    if (rows.length === 0 || rows[0].user_id !== req.userId) {
      return res.status(404).json({ code: 404, message: 'Order not found' });
    }
    if (rows[0].pay_status === 'paid') {
      return res.json({ code: 0, data: { paid: true } });
    }

    const q = await vpay.queryOrder(req.openid, orderNo);
    if (!q || q.errcode !== 0 || !q.order) {
      // 平台侧未查到/未支付：如实返回，不算错误
      return res.json({ code: 0, data: { paid: false, platformErrcode: q ? q.errcode : -1 } });
    }

    const wxOrderId =
      (q.order && (q.order.mch_order_no || q.order.wx_order_id || q.order.order_id)) ||
      'query_' + orderNo;
    await deliverOrder(orderNo, wxOrderId);
    return res.json({ code: 0, data: { paid: true } });
  } catch (err) {
    console.error('[vpay] 查单失败：', err.message);
    return res.status(500).json({ code: 500, message: '查单失败：' + err.message });
  }
});

module.exports = router;
