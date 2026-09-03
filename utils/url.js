/**
 * URL 工具：把「服务端本地磁盘回退」产生的相对路径拼成小程序可直接访问的绝对 URL。
 *
 * 背景（2026-09-03 真机白图事故）：
 *   utils/cloud-storage.js 在未配置 COS 时会回退 localSave()，返回 `/ai-generated/xxx.png`
 *   这类**相对路径**。微信小程序 <image src> 不支持相对路径，会静默加载失败（白图），
 *   且不报任何错——排查成本极高。
 *
 * 因此需要一层「出参规范化」：所有返回给小程序的图片 URL 都必须是
 *   - https:// 绝对地址（COS/CDN 或本服务静态目录），或
 *   - data: 内联（一般不用，体积太大）
 *
 * 注意 host 取值：CloudBase Run 等网关后面，容器内是 http，对外是 https，
 * 必须优先信任 X-Forwarded-*（app.js 已 app.set('trust proxy', true)）。
 */
'use strict';

const config = require('../config');

/** 已经是绝对 / 内联的协议前缀，无需处理 */
const ABSOLUTE_RE = /^(?:https?:|data:|wxfile:|blob:)/i;

/**
 * 单个 URL → 绝对 URL。无法安全拼接时原样返回（宁可不改，也不要拼出非法 URL）。
 * @param {string} url
 * @param {import('express').Request} [req]
 * @returns {string}
 */
function toAbsoluteUrl(url, req) {
  if (typeof url !== 'string' || url.length === 0) return url;
  if (ABSOLUTE_RE.test(url)) return url;
  if (url.charAt(0) !== '/') return url; // 非路径形态（异常输入）不动

  const headers = (req && req.headers) || {};
  // X-Forwarded-Host 优先（多层代理时 host 可能是内网地址）
  const rawHost = headers['x-forwarded-host'] || headers.host;
  if (!rawHost) return url;

  const host = rawHost.split(',')[0].trim();
  // X-Forwarded-Proto 优先；可能是 "https, http" 逗号列表，取第一个
  const rawProto = headers['x-forwarded-proto'] || (req && req.protocol) || 'https';
  let proto = rawProto.toString().split(',')[0].trim() || 'https';

  // 生产环境兜底：若网关没透传 X-Forwarded-Proto，req.protocol 会退化成 'http'，
  // 拼出的 http URL 在小程序端必然被拒（小程序 request/downloadFile 强制 https）。
  // 宁可猜 https 也不要退化成 http；本地开发（非 production）保留 http 以便联调。
  if (config.env === 'production' && proto === 'http') {
    proto = 'https';
  }

  return `${proto}://${host}${url}`;
}

/**
 * 数组批量转换（非数组原样返回）。
 * @param {string[]} list
 * @param {import('express').Request} [req]
 * @returns {string[]}
 */
function toAbsoluteUrls(list, req) {
  if (!Array.isArray(list)) return list;
  return list.map((u) => toAbsoluteUrl(u, req));
}

module.exports = { toAbsoluteUrl, toAbsoluteUrls };
