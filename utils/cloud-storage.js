/**
 * 云存储适配层
 *
 * 作用：把内存中的图片 Buffer 持久化，并返回小程序可直接访问（<image> / downloadFile）的 URL。
 *
 * - 已配置腾讯云 COS 凭证（config.cos）：上传到 COS，返回 CDN / COS 访问域名下的永久 URL。
 *   生产环境（云托管 CloudBase Run）建议用 COS + CDN，并把该 CDN 域名加入小程序
 *   「开发管理 - 服务器域名 - downloadFile 合法域名」。
 *   （request 合法域名由云托管默认域名自动加白，但 downloadFile 需单独加。）
 * - 未配置 COS（本地开发 / 尚未接入）：回退到本地磁盘 public/<prefix>/，返回相对路径，
 *   由 Express 静态托管。便于本地联调，无需腾讯云资源。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

function localSave(buffer, ext, prefix) {
  const dir = path.join(__dirname, '..', 'public', prefix);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;
  fs.writeFileSync(path.join(dir, fileName), buffer);
  return `/${prefix}/${fileName}`;
}

async function uploadToCos(buffer, key, contentType) {
  const cos = config.cos || {};
  if (!cos.secretId || !cos.secretKey || !cos.bucket || !cos.region) {
    return null; // 未配置 → 交由本地回退
  }
  // 懒加载，避免本地未安装 cos-nodejs-sdk-v5 时崩溃
  const COS = require('cos-nodejs-sdk-v5');
  const client = new COS({
    SecretId: cos.secretId,
    SecretKey: cos.secretKey,
  });
  await new Promise((resolve, reject) => {
    client.putObject(
      {
        Bucket: cos.bucket,
        Region: cos.region,
        Key: key,
        Body: buffer,
        ContentType: contentType
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
  const base = cos.cdnDomain
    ? `https://${cos.cdnDomain}`
    : `https://${cos.bucket}.cos.${cos.region}.myqcloud.com`;
  return `${base}/${key}`;
}

/**
 * 上传图片 Buffer，返回可访问 URL。
 * @param {Buffer} buffer 图片二进制
 * @param {string} ext 扩展名，不含点，如 'png' / 'jpg' / 'webp'
 * @param {string} prefix 存储路径前缀，对应 public 子目录，如 'ai-generated' / 'uploads'
 */
async function uploadImage(buffer, ext = 'png', prefix = 'images') {
  const safeExt = (ext || 'png').toString().replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
  const key = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${safeExt}`;
  const contentType = `image/${safeExt === 'jpg' ? 'jpeg' : safeExt}`;

  const url = await uploadToCos(buffer, key, contentType);
  if (url) return url;

  // 回退：本地磁盘（开发 / 未配置 COS）
  return localSave(buffer, safeExt, prefix);
}

module.exports = { uploadImage };
