const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const orderRoutes = require('./routes/order');
const imageRoutes = require('./routes/image');
const repairRoutes = require('./routes/repair');
const membershipRoutes = require('./routes/membership');
const uploadRoutes = require('./routes/upload');
const payRoutes = require('./routes/pay');
const aiRoutes = require('./routes/ai');

// 全局错误处理器（单独成模块，便于直接单元测试；见 middleware/error-handler.js）
const errorHandler = require('./middleware/error-handler');

const app = express();

// CloudBase 容器前置网关（CLB / API 网关）会注入
//   X-Forwarded-For: <client_ip>, <internal_ip>
// 多 IP 形式。express-rate-limit 默认只期望单个 IP，看到逗号分隔会抛
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR（fail-fast），结果每个进站请求都会
// 触发 500，导致前端报"需要重新登录"。
//
// CloudBase 是受控环境：trust proxy 全开是安全的——Express 会取 X-Forwarded-For
// 链的第一个 IP 作为 req.ip（真实客户端 IP），rate-limit 用它做 key 就稳了。
//
// ⚠️ express-rate-limit@7.x 新增了 ERR_ERL_PERMISSIVE_TRUST_PROXY 校验——
// 它认为 `true` 太宽松（允许任何人伪造 XFF 头绕过 IP 限流）。
// 在两个 rateLimit 实例里通过 `validate: { trustProxy: false }` 显式 opt-out，
// 表明我们清楚 CloudBase 网关是受信任的（容器网络隔离、攻击者无法伪造 XFF）。
// 其它校验（xForwardedForHeader 等）仍然开启。
app.set('trust proxy', true);

// Security
// 注意：crossOriginResourcePolicy 必须设为 'cross-origin'（或关闭），
// 否则微信小程序（运行在 servicewechat.com）跨域请求会被拦截返回 502。
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS：小程序发起的请求通常不带 Origin，这里按配置放行已知域名。
// 未配置 ALLOWED_ORIGIN 时退化为放行 '*'（开发态）；生产建议显式设置以缩小盗刷面。
const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors(allowedOrigin
  ? { origin: allowedOrigin.split(',').map((s) => s.trim()), credentials: false }
  : {}));

// 全局限流（防刷）：每分钟每 IP 最多 100 次
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  // 微信支付回调是微信服务器公开调用，重试高峰可能触发 429 导致丢回调，跳过限流
  skip: (req) => req.originalUrl.startsWith('/api/pay/callback'),
  // trust proxy=true 与 express-rate-limit@7.x 的 ERR_ERL_PERMISSIVE_TRUST_PROXY 校验相冲突；
  // 此处显式 opt-out 该校验，理由见上方 trust proxy 注释（CloudBase 受控环境，XFF 来自受信网关）
  validate: { trustProxy: false },
  message: { code: 429, message: '请求过于频繁，请稍后再试' }
});
app.use('/api/', limiter);

// AI 生图限流更严格（上游为付费模型，防止被刷爆账单）：每分钟每 IP 最多 8 次
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { code: 429, message: 'AI 生成请求过于频繁，请稍后再试' }
});
app.use('/api/ai/generate', aiLimiter);

// 老照片修复同样走付费的豆包 img2img（且单次耗时可达数十秒），
// 限流比普通接口更严：每分钟每 IP 最多 5 次提交，防止被刷爆账单。
const repairLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { code: 429, message: '修复请求过于频繁，请稍后再试' }
});
app.use('/api/repair/submit', repairLimiter);

// Body parsing
// verify 回调会把原始请求体存到 req.rawBody，供微信支付回调验签使用（签名必须基于原始字节）
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    if (buf && buf.length) req.rawBody = buf.toString('utf8');
  }
}));
app.use(express.urlencoded({ extended: true }));

// Health check
// 附带各关键配置的「就绪状态」。只报布尔值与长度指纹，绝不返回任何密钥字符——
// 该端点无鉴权且暴露在公网，泄露哪怕片段也不可接受；长度指纹已足够判断
// 「环境变量有没有注入」「注入的是不是期望那把 key」（火山方舟 key 长度固定）。
app.get('/health', (req, res) => {
  const len = (v) => (v ? v.length : 0);
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    env: config.env,
    ready: {
      doubaoApiKey: !!config.doubao.apiKey,
      doubaoKeyLen: len(config.doubao.apiKey),
      doubaoModel: config.doubao.model,
      wxAppId: !!config.wechat.appId,
      wxPay: config.wxpay.enabled,
      cos: !!(config.cos.secretId && config.cos.secretKey && config.cos.bucket),
      dbName: config.db.database,
      jwtSecret: !!process.env.JWT_SECRET
    }
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/order', orderRoutes);
app.use('/api/image', imageRoutes);
app.use('/api/repair', repairRoutes);
app.use('/api/membership', membershipRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/pay', payRoutes);
app.use('/api/ai', aiRoutes);

// Static files (AI generated images, uploads, etc.)
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use(express.static(PUBLIC_DIR));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ code: 404, message: 'Not found' });
});

// Error handler
// 抽到 middleware/error-handler.js：请求体解析失败（entity.parse.failed）要降级为 400，
// 不能当服务器崩溃报 500。逻辑与单测见该模块。
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port} [${config.env}]`);
});

// ════════════════ 全局异常兜底（防单点 Promise 异常击垮进程） ════════════════
// 云托管 / 容器环境下不立即退出，交由健康检查与负载均衡决定是否重启实例；
// 若需更严格策略，可在此 process.exit(1)。
process.on('unhandledRejection', (reason, promise) => {
  console.error('[fatal] Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught Exception:', err);
});

module.exports = app;
