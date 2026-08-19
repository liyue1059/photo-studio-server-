const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const db = require('../utils/db');
const redis = require('../utils/redis');
const wxpay = require('../utils/wxpay');
const { applyMembership } = require('../utils/membership');

const router = express.Router();

/**
 * POST /api/pay/callback
 * 微信支付结果通知（公开接口，无 auth）
 */
router.post('/callback', async (req, res) => {
  try {
    // ===== 真实微信支付：验签 + 解密 =====
    if (wxpay.isEnabled()) {
      let decrypted;
      try {
        decrypted = await wxpay.verifyCallback(req.headers, req.rawBody || JSON.stringify(req.body));
      } catch (verifyErr) {
        console.error('[wxpay] 回调验签/解密失败：', verifyErr.message);
        return res.status(401).json({ code: 'FAIL', message: verifyErr.message });
      }

      const { out_trade_no: orderNo, transaction_id: transactionId, trade_state: tradeState } = decrypted;

      if (!orderNo) {
        return res.status(400).json({ code: 'FAIL', message: 'Missing out_trade_no' });
      }

      // transaction_id 缺失会使幂等键退化为 'pay_callback:undefined'，把不同订单串成同一把锁
      if (!transactionId) {
        return res.status(400).json({ code: 'FAIL', message: 'Missing transaction_id' });
      }

      // 去重：同一笔交易只处理一次
      const isNew = await redis.setnx('pay_callback:' + transactionId, '1', 86400);
      if (!isNew) {
        return res.json({ code: 'SUCCESS', message: '成功' });
      }

      // 取订单归属（Redis 缓存优先，失效则回查 DB）
      let orderData = await redis.get('order:' + orderNo);
      if (!orderData) {
        const rows = await db.query(
          'SELECT user_id, pay_type, pay_status FROM orders WHERE order_no = ?',
          [orderNo]
        );
        if (rows.length > 0) {
          orderData = {
            userId: rows[0].user_id,
            payType: rows[0].pay_type,
            status: rows[0].pay_status
          };
        }
      }

      if (!orderData) {
        return res.status(404).json({ code: 'FAIL', message: 'Order not found' });
      }

      // 仅当微信侧交易成功时才发放权益
      if (tradeState === 'SUCCESS') {
        // 事务保证「改单 + 发权益」原子性：中途异常回滚，避免已付款却未发会员
        await db.transaction(async (conn) => {
          await conn.execute(
            'UPDATE orders SET pay_status = ?, transaction_id = ?, paid_at = NOW() WHERE order_no = ?',
            ['paid', transactionId, orderNo]
          );
          await applyMembership(orderData.userId, orderData.payType, conn);
        });
      } else {
        // 非成功态（如已关闭）：标记失败，不发放权益，但返回 SUCCESS 让微信停止重试
        await db.query(
          'UPDATE orders SET pay_status = ? WHERE order_no = ?',
          [tradeState === 'REFUND' ? 'refunded' : 'failed', orderNo]
        );
      }

      await redis.del('order:' + orderNo);
      await redis.del('membership:' + orderData.userId);

      await db.query(
        'INSERT INTO payment_logs (order_id, event_type, raw_data, is_success, created_at) SELECT id, ?, ?, 1, NOW() FROM orders WHERE order_no = ?',
        ['callback', JSON.stringify(decrypted), orderNo]
      );

      return res.json({ code: 'SUCCESS', message: '成功' });
    }

    // ===== 开发态：信任回调体（仅本地测试用，真实支付不会走到这里） =====
    const { resource } = req.body;
    if (!resource) {
      return res.status(400).json({ code: 'FAIL', message: 'Invalid body' });
    }

    const orderNo = resource.out_trade_no;
    const transactionId = resource.transaction_id;

    if (!orderNo) {
      return res.status(400).json({ code: 'FAIL', message: 'Missing order_no' });
    }

    // 开发态可能不带 transaction_id：用 orderNo 兜底幂等键，避免退化为 'pay_callback:undefined'
    const idemKey = transactionId || ('dev_' + orderNo);
    const isNew = await redis.setnx('pay_callback:' + idemKey, '1', 86400);
    if (!isNew) {
      return res.json({ code: 'SUCCESS', message: 'Already processed' });
    }

    const orderData = await redis.get('order:' + orderNo);
    if (!orderData) {
      return res.status(404).json({ code: 'FAIL', message: 'Order not found' });
    }

    await db.query(
      'UPDATE orders SET pay_status = ?, transaction_id = ?, paid_at = NOW() WHERE order_no = ?',
      ['paid', transactionId, orderNo]
    );

    await applyMembership(orderData.userId, orderData.payType);

    await redis.del('order:' + orderNo);
    await redis.del('membership:' + orderData.userId);

    await db.query(
      'INSERT INTO payment_logs (order_id, event_type, raw_data, is_success, created_at) SELECT id, ?, ?, 1, NOW() FROM orders WHERE order_no = ?',
      ['callback', JSON.stringify(req.body), orderNo]
    );

    res.json({ code: 'SUCCESS', message: 'OK' });
  } catch (err) {
    console.error('Pay callback error:', err);
    res.status(500).json({ code: 'FAIL', message: err.message });
  }
});

module.exports = router;
