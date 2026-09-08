'use strict';
/**
 * 微信小程序虚拟支付工具（数字商品合规链路）
 * 文档: https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/person.html
 *
 * 两套签名（缺一不可，2026-09-08 按官方 5.5 节实现）：
 *   paySig    = HMAC-SHA256(现网AppKey,  uri + '&' + postBody)   —— C 端下单 uri 固定 requestVirtualPayment；
 *                                                                  B 端 /xpay/* 接口 uri 为实际路径
 *   signature = HMAC-SHA256(sessionKey, signData)                —— 用户态（sessionKey 来自 code2Session，
 *                                                                  登录时由 routes/auth.js 存 Redis）
 *
 * 铁律：post_body / signData 必须与实际发出去的字符串完全一致（不格式化、不改键顺序），否则验签必败。
 */
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const redis = require('./redis');

const XPAY_BASE = 'https://api.weixin.qq.com/xpay';

function enabled() {
  return config.vpay.enabled();
}

/** 支付签名 paySig（服务端算，AppKey 是密钥） */
function calcPaySig(uri, postBody) {
  return crypto
    .createHmac('sha256', config.vpay.appKey)
    .update(uri + '&' + postBody)
    .digest('hex');
}

/** 用户态签名 signature（服务端算，sessionKey 是密钥） */
function calcSignature(signData, sessionKey) {
  return crypto
    .createHmac('sha256', sessionKey)
    .update(signData)
    .digest('hex');
}

/**
 * 获取小程序全局 access_token（/xpay/* B 端接口需要）。
 * Redis 缓存 7000s（官方 7200s，留余量避免边界过期）。
 */
async function getAccessToken() {
  const cached = await redis.get('wx_access_token');
  if (cached) return cached;

  const res = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
    params: {
      grant_type: 'client_credential',
      appid: config.wechat.appId,
      secret: config.wechat.secret
    },
    timeout: 10000
  });
  if (!res.data || !res.data.access_token) {
    throw new Error('获取 access_token 失败: ' + JSON.stringify(res.data));
  }
  await redis.set('wx_access_token', res.data.access_token, 7000);
  return res.data.access_token;
}

/**
 * 平台查单（兜底发货依据）：POST /xpay/query_order
 * @returns {object} 平台原始响应（errcode/errmsg/order...）。
 *   注意：order 内部字段名以首次真单实测为准，联调时把原始返回打进日志核对。
 */
async function queryOrder(openid, outTradeNo) {
  const token = await getAccessToken();
  const uri = '/xpay/query_order';
  const body = JSON.stringify({ openid, env: 0, order_id: outTradeNo });
  const paySig = calcPaySig(uri, body);
  const url =
    XPAY_BASE + '/query_order?access_token=' + encodeURIComponent(token) +
    '&pay_sig=' + encodeURIComponent(paySig);

  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  });
  // 首次联调务必看一眼原始结构，确认支付状态字段名后再收紧判断逻辑
  console.log('[vpay] query_order 原始返回:', JSON.stringify(res.data));
  return res.data;
}

/**
 * 解析发货推送 XML（xpay_goods_deliver_notify）。
 * 只做字段提取，不在这里做信任判断——发货前必须再走 queryOrder 向平台二次确认。
 */
function parseNotifyXml(xml) {
  const text = String(xml || '');
  function pick(tag) {
    const m = text.match(
      new RegExp('<' + tag + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</' + tag + '>')
    );
    return m ? m[1].trim() : '';
  }
  return {
    event: pick('Event'),
    openid: pick('OpenId'),
    outTradeNo: pick('OutTradeNo'),
    // 平台单号 wx_order_id 在 WeChatPayInfo.MchOrderNo 里，幂等去重/对账以此为准
    wxOrderId: pick('MchOrderNo'),
    productId: pick('ProductId'),
    quantity: parseInt(pick('Quantity'), 10) || 1
  };
}

/**
 * 组装下单 payData（wx.requestVirtualPayment 的入参）。
 * @param {object} p - { openid, sessionKey, payType, outTradeNo }
 */
function buildOrderPayData({ openid, sessionKey, payType, outTradeNo }) {
  if (!openid) throw new Error('buildOrderPayData: openid 缺失');
  if (!sessionKey) throw new Error('buildOrderPayData: sessionKey 缺失');
  const productId = config.vpay.productIds[payType] || payType;
  const goodsPrice = config.pricing[payType]; // 单位：分，须与后台道具价格一致，全程不换算
  if (!goodsPrice) throw new Error('buildOrderPayData: 未知 payType ' + payType);

  // signData 的键顺序即最终字符串顺序，签好名后前端原样透传，不可改动
  const signData = JSON.stringify({
    offerId: config.vpay.offerId,
    buyQuantity: 1,
    env: 0, // 固定 0 = 正式环境/现网
    currencyType: 'CNY',
    productId,
    goodsPrice,
    outTradeNo,
    attach: payType // 必填，发货推送时原样透传回来，直接映射 payType
  });

  return {
    signData,
    mode: 'short_series_goods', // 道具直购
    paySig: calcPaySig('requestVirtualPayment', signData),
    signature: calcSignature(signData, sessionKey)
  };
}

/** 业务单号：8-32 位、唯一、不以下划线开头（官方硬性要求） */
function genOutTradeNo() {
  return 'VP' + Date.now().toString() + crypto.randomBytes(4).toString('hex').toUpperCase();
}

module.exports = {
  enabled,
  calcPaySig,
  calcSignature,
  getAccessToken,
  queryOrder,
  parseNotifyXml,
  buildOrderPayData,
  genOutTradeNo
};
