/**
 * 微信支付 v3（Native 实现，无第三方 SDK 依赖）
 * 仅使用 Node 内置 crypto + 已引入的 axios。
 *
 * 启用条件（config.wxpay.enabled）：
 *   WX_APPID / WXPAY_MCHID / WXPAY_API_V3_KEY / WXPAY_SERIAL_NO
 *   以及 商户私钥（WXPAY_PRIVATE_KEY 内联 或 WXPAY_PRIVATE_KEY_PATH 文件）
 * 全部就绪时，下单与回调走真实微信支付；否则相关路由回退到开发态（mock/dev）。
 */
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');

const WECHAT_API_BASE = 'https://api.mch.weixin.qq.com';

let privateKeyObj = null;
let privateKeyLoaded = false;

function getPrivateKey() {
  if (privateKeyLoaded) return privateKeyObj;
  privateKeyLoaded = true;
  let pem = '';
  if (process.env.WXPAY_PRIVATE_KEY) {
    pem = process.env.WXPAY_PRIVATE_KEY;
  } else if (config.wxpay.privateKeyPath && fs.existsSync(config.wxpay.privateKeyPath)) {
    pem = fs.readFileSync(config.wxpay.privateKeyPath, 'utf8');
  }
  if (!pem) return null;
  try {
    privateKeyObj = crypto.createPrivateKey(pem);
  } catch (e) {
    console.error('[wxpay] 商户私钥加载失败：', e.message);
    privateKeyObj = null;
  }
  return privateKeyObj;
}

function randomString(len = 32) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

/** SHA256-RSA 签名，输出 base64 */
function sign(message) {
  const key = getPrivateKey();
  if (!key) throw new Error('微信支付商户私钥未加载');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(message), key);
  return sig.toString('base64');
}

/** 生成请求用的 Authorization 头（WECHATPAY2-SHA256-RSA2048） */
function buildAuthorization(method, urlPath, bodyStr) {
  const mchId = config.wxpay.mchId;
  const serialNo = config.wxpay.serialNo;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomString(32);
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${bodyStr}\n`;
  const signature = sign(message);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`;
}

/** AES-256-GCM 解密（apiV3Key 为 32 字节字符串） */
function decryptAesGcm(apiV3Key, nonce, associatedData, ciphertextB64) {
  const key = Buffer.from(apiV3Key, 'utf8');
  const data = Buffer.from(ciphertextB64, 'base64');
  const authTag = data.subarray(data.length - 16);
  const cipherBytes = data.subarray(0, data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  if (associatedData) decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  let decrypted = decipher.update(cipherBytes, 'binary', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ---- 平台证书缓存（用于回调验签） ----
let certCache = null; // Map<serial_no, publicKey>
let certCacheTime = 0;
const CERT_TTL = 12 * 3600 * 1000;

async function fetchPlatformCerts() {
  const urlPath = '/v3/certificates';
  const auth = buildAuthorization('GET', urlPath, '');
  const resp = await axios.get(WECHAT_API_BASE + urlPath, {
    headers: {
      Authorization: auth,
      Accept: 'application/json',
      'User-Agent': 'photo-studio/1.0'
    },
    timeout: 10000
  });
  const map = new Map();
  for (const item of (resp.data.data || [])) {
    const enc = item.encrypt_certificate;
    try {
      const pem = decryptAesGcm(config.wxpay.apiV3Key, enc.nonce, enc.associated_data, enc.ciphertext);
      map.set(item.serial_no, crypto.createPublicKey(pem));
    } catch (e) {
      console.error('[wxpay] 平台证书解密失败：', e.message);
    }
  }
  certCache = map;
  certCacheTime = Date.now();
  return map;
}

async function getPlatformCerts(force = false) {
  const now = Date.now();
  if (certCache && !force && now - certCacheTime < CERT_TTL) return certCache;
  return fetchPlatformCerts();
}

/**
 * 校验回调签名并解密 resource。
 * @param {object} headers 回调请求头
 * @param {string} rawBody 原始请求体字符串
 * @returns {object} 解密后的明文 JSON（含 out_trade_no / transaction_id / trade_state / amount 等）
 */
async function verifyCallback(headers, rawBody) {
  const signature = headers['wechatpay-signature'];
  const timestamp = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const serial = headers['wechatpay-serial'];
  if (!signature || !timestamp || !nonce || !serial) {
    throw new Error('缺少微信支付回调请求头');
  }

  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  let certs = await getPlatformCerts();
  let pub = certs.get(serial);
  if (!pub) {
    // 证书序列未知，强制刷新后再试一次
    certs = await getPlatformCerts(true);
    pub = certs.get(serial);
  }
  if (!pub) throw new Error('未知的微信支付平台证书序列号：' + serial);

  const ok = crypto.verify('RSA-SHA256', Buffer.from(message), pub, Buffer.from(signature, 'base64'));
  if (!ok) throw new Error('微信支付回调签名校验失败');

  const body = JSON.parse(rawBody);
  const resource = body.resource;
  if (!resource || !resource.ciphertext) throw new Error('回调 resource 缺失');

  const decrypted = decryptAesGcm(
    config.wxpay.apiV3Key,
    resource.nonce,
    resource.associated_data,
    resource.ciphertext
  );
  return JSON.parse(decrypted);
}

/**
 * 创建 JSAPI 支付订单。
 * @returns {string} prepay_id
 */
async function createJsapiOrder({ description, outTradeNo, total, openid }) {
  const urlPath = '/v3/pay/transactions/jsapi';
  const body = {
    appid: config.wechat.appId,
    mchid: config.wxpay.mchId,
    description,
    out_trade_no: outTradeNo,
    notify_url: config.wxpay.notifyUrl,
    amount: { total, currency: 'CNY' },
    payer: { openid }
  };
  const bodyStr = JSON.stringify(body);
  const auth = buildAuthorization('POST', urlPath, bodyStr);
  const resp = await axios.post(WECHAT_API_BASE + urlPath, bodyStr, {
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'photo-studio/1.0'
    },
    timeout: 10000
  });
  const prepayId = resp.data.prepay_id;
  if (!prepayId) throw new Error('微信支付未返回 prepay_id');
  return prepayId;
}

/**
 * 构造小程序端 wx.requestPayment 所需的支付参数。
 */
function buildPayParams(prepayId) {
  const appId = config.wechat.appId;
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomString(32);
  const pkg = 'prepay_id=' + prepayId;
  const message = `${appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  const paySign = sign(message);
  return {
    appId,
    timeStamp,
    nonceStr,
    package: pkg,
    signType: 'RSA',
    paySign
  };
}

module.exports = {
  isEnabled: () => !!config.wxpay.enabled,
  createJsapiOrder,
  buildPayParams,
  verifyCallback
};
