require('dotenv').config();

const isProd = (process.env.NODE_ENV || 'development') === 'production';

const config = {
  // CloudBase 容器默认注入 PORT=3000，但健康探针默认探 80，统一改为 80。
  // 本地开发保留 PORT=3000（或任意自定义）只需在 .env 里手写 PORT=3000。
  port: process.env.PORT || (isProd ? 80 : 3000),
  env: process.env.NODE_ENV || 'development',

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    // 生产环境空密码会在文件末尾校验中强制失败；本地联调允许空密码。
    password: process.env.DB_PASSWORD || '',
    // 云托管(CynosDB)为环境自动生成的默认库名（形如
    //   `photo-studio-prod-<随机串>`），需用 DB_NAME 显式指定——
    //   部署时务必填入控制台给出的真实库名，不要再用 photo_studio。
    //   本地开发保持默认 photo_studio（运行 database/schema.sql
    //   中保留的 CREATE DATABASE 段即可创建）。
    database: process.env.DB_NAME || 'photo_studio',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  },

  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || ''
  },

  jwt: {
    // ⚠️ 生产环境必须由 JWT_SECRET 提供（见文件末尾校验）。
    // 此默认值仅用于本地联调，绝不能用于生产——任何人都能用它伪造任意 userId。
    secret: process.env.JWT_SECRET || 'dev_insecure_secret_do_not_use_in_prod',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },

  wechat: {
    appId: process.env.WX_APPID,
    secret: process.env.WX_SECRET
  },

  wxpay: {
    mchId: process.env.WXPAY_MCHID,
    apiV3Key: process.env.WXPAY_API_V3_KEY,
    serialNo: process.env.WXPAY_SERIAL_NO,
    privateKeyPath: process.env.WXPAY_PRIVATE_KEY_PATH,
    notifyUrl: process.env.WXPAY_NOTIFY_URL,
    // 真实微信支付是否就绪：AppID + 商户号 + APIv3Key + 证书序列号 + 商户私钥 全部齐备才启用。
    // 未启用时，相关路由回退到开发态（mock / 信任回调体），避免无凭证时崩溃。
    enabled: !!(
      process.env.WX_APPID &&
      process.env.WXPAY_MCHID &&
      process.env.WXPAY_API_V3_KEY &&
      process.env.WXPAY_SERIAL_NO &&
      (process.env.WXPAY_PRIVATE_KEY || process.env.WXPAY_PRIVATE_KEY_PATH)
    )
  },

  cos: {
    secretId: process.env.COS_SECRET_ID,
    secretKey: process.env.COS_SECRET_KEY,
    bucket: process.env.COS_BUCKET,
    region: process.env.COS_REGION,
    cdnDomain: process.env.COS_CDN_DOMAIN
  },

  ai: {
    serviceUrl: process.env.AI_SERVICE_URL,
    apiKey: process.env.AI_SERVICE_API_KEY
  },

  // 豆包（火山方舟）文生图大模型
  doubao: {
    apiKey: process.env.DOUBAO_API_KEY || '',
    model: process.env.DOUBAO_MODEL || 'doubao-seedream-4-0-250828',
    baseUrl: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    // 单张估算费用（美元），仅用于额度展示，实际以火山方舟账单为准
    estCostUsdPerImage: parseFloat(process.env.DOUBAO_EST_COST || '0.01')
  },

  // 商品定价（单位：分，避免浮点误差；写入 orders.amount 时再除以 100 转为元）
  pricing: {
    single: 199,        // ¥1.99 按次
    trial: 990,         // ¥9.9 试用包月
    monthly: 990,       // ¥9.9（trial 的兼容别名）
    quarter: 4390,      // ¥43.9 包季（3 个月）
    halfYear: 7490,     // ¥74.9 包半年（6 个月）
    yearly: 11990       // ¥119.9 包年（12 个月）
  },

  // 会员权益：新用户免费试用次数。
  // 与 miniprogram/config/brand.js 的 `freeTrials` 保持一致（品牌侧是展示用常量，
  // 这里是服务端真正消费的唯一真相源）。改数量只需改这一处 + brand.js 同步。
  membership: {
    freeTrials: parseInt(process.env.FREE_TRIALS || '2', 10)
  }
};

// ════════════════════════════════════════════════════════════════
// 启动期配置校验（fail-fast）
// 仅在「生产环境」强制校验必备配置，缺失即抛出使进程无法启动，
// 避免带病运行后在处理首个请求时才崩溃，也避免用默认密钥签发 token。
// ════════════════════════════════════════════════════════════════
if (isProd) {
  const missing = [];
  ['JWT_SECRET', 'DB_HOST', 'DB_USER', 'DB_NAME', 'WX_APPID', 'WX_SECRET'].forEach((k) => {
    if (!process.env[k]) missing.push(k);
  });
  if (!process.env.DB_PASSWORD) missing.push('DB_PASSWORD');
  if (!process.env.REDIS_PASSWORD) missing.push('REDIS_PASSWORD');
  if (missing.length) {
    throw new Error(
      '[config] 生产环境缺少必需配置: ' + missing.join(', ') +
      '。请在环境变量 / 云托管控制台补齐后重启服务。'
    );
  }
}

// ════════════════════════════════════════════════════════════════
// 豆包接入点校验（仅告警，不阻断启动）
// 火山方舟的 model 字段要传「推理接入点 ID」（ep- 开头），不是模型名。
// 传模型名会在用户发起第一次生成时才报 InvalidParameter，排查链路很长，
// 因此在启动期就打一条明确告警，让问题在部署日志里直接暴露。
// 这里刻意不阻断启动：AI 有降级路径，且未来方舟若支持直接传模型名也不会误伤。
// ════════════════════════════════════════════════════════════════
if (config.doubao.apiKey && !/^ep-/i.test(config.doubao.model || '')) {
  console.warn(
    '[config] ⚠️ DOUBAO_MODEL 不是以 ep- 开头的推理接入点 ID（当前值: ' +
    (config.doubao.model || '(空)') + '）。\n' +
    '       火山方舟要求传「推理接入点 ID」而非模型名，否则调用会报 InvalidParameter。\n' +
    '       请在控制台「在线推理 → 接入点列表」复制 ep- 开头的 ID 并设为 DOUBAO_MODEL。'
  );
}

module.exports = config;
