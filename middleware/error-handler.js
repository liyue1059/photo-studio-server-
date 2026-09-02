/**
 * 全局错误处理器
 * ────────────────────────────────────────────────────────────
 * 拆成独立模块而非写在 app.js 里，是为了能直接对真实代码做单元测试
 * （若在 app.js 内联，测试就必须启动服务器，或把逻辑复制一份到测试里 ——
 *   后者会在源码改动后依然显示"通过"，是假测试）。
 *
 * 最关键的职责：把「请求体解析失败」从 500 降级为 400。
 * 背景：express.json 默认 strict:true，拒绝顶层非对象的 JSON（如字符串 "null"），
 *       抛 type='entity.parse.failed'。若不单独处理，会落进 500 分支，
 *       把"客户端发错数据"误报成"服务器崩溃"，排查时极易带偏方向。
 */
const config = require('../config');

function errorHandler(err, req, res, next) {
  // 请求体解析失败：客户端发错了 body（null / 非对象 / 畸形 JSON），属于 400。
  // 典型触发：微信开发者工具模拟器的 wx.login() 偶发返回异常值，前端把 body
  // 发成了字符串 "null"，导致登录接口整片报 500。
  // 降级为 400 并把原始 body 打进日志，下次一眼就能看出是谁发的怪数据。
  if (err && err.type === 'entity.parse.failed') {
    console.warn(
      '[body-parse] 请求体格式错误 | path =',
      req && req.originalUrl,
      '| rawBody =',
      JSON.stringify(req && req.rawBody)
    );
    return res.status(400).json({
      code: 400,
      message: '请求体格式错误：必须是合法的 JSON 对象'
    });
  }

  console.error('Unhandled error:', err);
  // err 可能为 null/undefined（防御：错误处理器自己崩了会让请求挂死，比原错误更糟）。
  // 开发态回显 err.message 便于调试；取不到就给兜底文案，绝不在这里再抛一次。
  const detail = err && err.message ? err.message : '未知错误';
  res.status(500).json({
    code: 500,
    message: config.env === 'production' ? 'Internal server error' : detail
  });
}

module.exports = errorHandler;
