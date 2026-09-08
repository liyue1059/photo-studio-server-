'use strict';
/**
 * 云存储适配层（v2：CloudBase 文件管理优先）
 *
 * 为什么改（2026-09-07，callContainer 改造）：
 *   旧版直写容器本地盘 public/，在云托管里有两大致命问题：
 *     1) 容器重启 / 重新部署后本地盘清空 → AI 生图、修复结果全部丢失（P1）。
 *     2) 回退路径返回 /ai-generated/xxx.png 相对路径 → 小程序 <image> 不认，
 *        静默白图，极难排查。
 *   改用 CloudBase 文件管理（@cloudbase/node-sdk）后：
 *     - 图片落云存储，容器重启不丢；
 *     - 返回的 tempFileURL 是 https 绝对地址，小程序直接可用；
 *     - 配合 callContainer：前端先 wx.cloud.uploadFile 拿 fileID，再把极小的
 *       fileID 传给后端（绕开 callContainer 100KiB 请求体上限），后端再
 *       downloadFile → 处理 → uploadFile → getTempFileURL 回传绝对 URL。
 *
 * 降级顺序（任一层可用即用，全部不可用才报错）：
 *   CloudBase 文件管理（配置了 CLOUDBASE_ENV_ID）
 *     → 腾讯云 COS（配置了 COS_SECRET_ID/KEY/BUCKET/REGION）
 *     → 容器本地磁盘 public/（仅本地联调 / 兜底，生产不推荐）
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

// CloudBase 临时链接默认有效期：24 小时。结果图展示 / 下载都够用；
// 用户素材库（images 表）存的是 fileID，取时按需重新换链，不受此过期影响。
const DEFAULT_TEMP_URL_MAX_AGE = 24 * 3600;

// ──────────────────────────────────────────────────────
// 工具
// ──────────────────────────────────────────────────────
function sanitizeExt(ext) {
  return (ext || 'png').toString().replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
}
function randSuffix() {
  return Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}
function contentTypeOf(ext) {
  const e = sanitizeExt(ext);
  if (e === 'jpg') return 'image/jpeg';
  return 'image/' + e;
}
function isCloudFileId(v) {
  return typeof v === 'string' && v.startsWith('cloud://');
}

/** 从二进制头部嗅探真实 MIME（JPEG / PNG / WebP / GIF） */
function sniffMime(buf) {
  try {
    if (buf.length > 8) {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
      if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    }
  } catch (e) { /* ignore */ }
  return 'image/png';
}

/** 从公网 URL 路径猜扩展名 */
function extFromUrl(url) {
  try {
    const pathPart = String(url).split('?')[0];
    const m = pathPart.match(/\.([a-zA-Z0-9]+)(?:$|#)/);
    if (m) {
      const e = m[1].toLowerCase().replace('jpeg', 'jpg');
      if (['jpg', 'png', 'webp', 'gif'].includes(e)) return e;
    }
  } catch (e) { /* ignore */ }
  return 'jpg';
}

// ──────────────────────────────────────────────────────
// CloudBase 文件管理（@cloudbase/node-sdk，懒加载）
// ──────────────────────────────────────────────────────
let _tcbApp = null;
let _tcbInitTried = false;

function getTcbApp() {
  if (_tcbApp) return _tcbApp;
  if (_tcbInitTried) return null;
  _tcbInitTried = true;
  const envId = config.cloudbase.envId;
  if (!envId) return null;
  try {
    // 懒加载：未安装 SDK 或未配置 envId 时绝不阻塞模块加载（回退到 COS/本地）。
    const tcb = require('@cloudbase/node-sdk');
    // 2026-09-07 真机实测修复：云托管容器身份是「临时凭证三件套」。
    // 注意变量名坑：腾讯云容器注入的是 TENCENTCLOUD_SESSIONTOKEN（SESSION 与 TOKEN
    // 之间无下划线，SCF/CloudBase Run 官方文档实锤），曾误写 SESSION_TOKEN 导致
    // 拿不到 token → 签名缺 token → SIGN_PARAM_INVALID。两个名字都兼容。
    const secretId = config.cloudbase.secretId || process.env.TENCENTCLOUD_SECRETID;
    const secretKey = config.cloudbase.secretKey || process.env.TENCENTCLOUD_SECRETKEY;
    const sessionToken =
      process.env.TENCENTCLOUD_SESSIONTOKEN || process.env.TENCENTCLOUD_SESSION_TOKEN;
    // 正常情况不刷屏；只在凭证不齐（会回退/失败）时告警，方便线上排障。
    if (!secretId || !sessionToken) {
      console.warn(
        '[cloud-storage] tcb init:',
        'secretId?', !!secretId,
        'sessionToken?', !!sessionToken,
        'env=', envId
      );
    }
    _tcbApp = tcb.init({
      env: envId,
      // 显式传凭证时必须连 sessionToken 一起传（临时凭证签名必需）；
      // 都没有时才交给 SDK 自动探测（本地联调场景）。
      ...(secretId && secretKey
        ? { secretId, secretKey, ...(sessionToken ? { sessionToken } : {}) }
        : {}),
      timeout: 15000
    });
  } catch (e) {
    console.error('[cloud-storage] 初始化 CloudBase SDK 失败（回退 COS/本地）:', e && e.message);
    _tcbApp = null;
  }
  return _tcbApp;
}

function cloudStorageEnabled() {
  return !!getTcbApp();
}

async function uploadToCloudStorage(buffer, ext, prefix) {
  const app = getTcbApp();
  if (!app) return null;
  const safeExt = sanitizeExt(ext);
  const cloudPath = `${prefix}/${randSuffix()}.${safeExt}`;
  const up = await app.uploadFile({ cloudPath, fileContent: buffer });
  if (!up || !up.fileID) {
    throw new Error('CloudBase 上传未返回 fileID');
  }
  return up.fileID;
}

async function getTempUrl(fileID, maxAge) {
  const app = getTcbApp();
  if (!app) throw new Error('CloudBase 未初始化，无法换取临时链接');
  const res = await app.getTempFileURL({
    fileList: [{ fileID, maxAge: maxAge || DEFAULT_TEMP_URL_MAX_AGE }]
  });
  const item = res && res.fileList && res.fileList[0];
  if (!item || !item.tempFileURL) {
    throw new Error('CloudBase 换取临时链接失败: ' + ((res && res.message) || 'unknown'));
  }
  return item.tempFileURL;
}

async function downloadFromCloudStorage(fileID) {
  const app = getTcbApp();
  if (!app) throw new Error('CloudBase 未初始化，无法下载');
  const res = await app.downloadFile({ fileID });
  if (!res || !res.fileContent) {
    throw new Error('CloudBase 下载未返回内容');
  }
  return Buffer.from(res.fileContent);
}

// ──────────────────────────────────────────────────────
// COS 回退（保留旧实现，未配置 CloudBase 时可用）
// ──────────────────────────────────────────────────────
async function uploadToCos(buffer, key, contentType) {
  const cos = config.cos || {};
  if (!cos.secretId || !cos.secretKey || !cos.bucket || !cos.region) {
    return null; // 未配置 → 交由本地回退
  }
  try {
    const COS = require('cos-nodejs-sdk-v5');
    const client = new COS({ SecretId: cos.secretId, SecretKey: cos.secretKey });
    await new Promise((resolve, reject) => {
      client.putObject({ Bucket: cos.bucket, Region: cos.region, Key: key, Body: buffer, ContentType: contentType },
        (err) => (err ? reject(err) : resolve()));
    });
    const base = cos.cdnDomain
      ? `https://${cos.cdnDomain}`
      : `https://${cos.bucket}.cos.${cos.region}.myqcloud.com`;
    return `${base}/${key}`;
  } catch (e) {
    console.error('[cloud-storage] COS 上传失败，回退本地:', e && e.message);
    return null;
  }
}

function localSave(buffer, ext, prefix) {
  const dir = path.join(__dirname, '..', 'public', prefix);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${randSuffix()}.${ext}`;
  fs.writeFileSync(path.join(dir, fileName), buffer);
  return `/${prefix}/${fileName}`;
}

// ──────────────────────────────────────────────────────
// 公开 API
// ──────────────────────────────────────────────────────

/**
 * 上传图片 Buffer，返回小程序可直接访问（<image> / downloadFile）的绝对 URL。
 * 配置了 CloudBase → 返回 https 临时链接；否则 COS → 本地相对路径。
 * @param {Buffer} buffer 图片二进制
 * @param {string} ext 扩展名（不含点），如 'png' / 'jpg' / 'webp'
 * @param {string} prefix 存储路径前缀，对应 public 子目录，如 'ai-generated' / 'uploads' / 'repairs'
 * @returns {Promise<string>} 可访问 URL（CloudBase/COS 为绝对，本地为相对路径）
 */
async function uploadImage(buffer, ext = 'png', prefix = 'images') {
  if (cloudStorageEnabled()) {
    const fileID = await uploadToCloudStorage(buffer, ext, prefix);
    return await getTempUrl(fileID);
  }
  const safeExt = sanitizeExt(ext);
  const key = `${prefix}/${randSuffix()}.${safeExt}`;
  const cosUrl = await uploadToCos(buffer, key, contentTypeOf(safeExt));
  if (cosUrl) return cosUrl;
  return localSave(buffer, safeExt, prefix);
}

/**
 * 上传并返回 { fileID, url }。fileID 可持久化到 DB，后续用 getTempUrl 换长期可用链接。
 * 未配置 CloudBase 时 fileID 为 null（调用方应回退用 url）。
 */
async function uploadImageWithId(buffer, ext = 'png', prefix = 'images') {
  if (cloudStorageEnabled()) {
    const fileID = await uploadToCloudStorage(buffer, ext, prefix);
    const url = await getTempUrl(fileID);
    return { fileID, url };
  }
  const url = await uploadImage(buffer, ext, prefix);
  return { fileID: null, url };
}

/**
 * 把云端 fileID 解析为 base64 data URL，供豆包图生图（img2img）消费。
 * 传入的若是 data URL / 公网 http(s) URL（旧输入或跨域图），原样返回。
 * @param {string} input cloud:// fileID 或 data URL / 公网 URL
 * @returns {Promise<string>} data URL 或原始输入
 */
async function resolveInputToDataUrl(input) {
  if (isCloudFileId(input)) {
    const buf = await downloadFromCloudStorage(input);
    const mime = sniffMime(buf);
    return `data:${mime};base64,${buf.toString('base64')}`;
  }
  return input; // 已是 data URL 或公网 URL，直接返回
}

/**
 * 把 DB 中可能存储的 cloud:// fileID 解析为可访问 URL；非 fileID 原样返回。
 * 用于 images 表列表回读时按需换链（绕过临时链接过期）。
 * @param {string} v 存储值（fileID 或 URL）
 * @param {number} [maxAge] 临时链接有效期（秒）
 */
async function resolveStoredUrl(v, maxAge) {
  if (isCloudFileId(v)) return await getTempUrl(v, maxAge);
  return v;
}

/** 批量把 fileID 列表换为临时链接（一次 RPC，省开销） */
async function resolveStoredUrls(list, maxAge) {
  if (!Array.isArray(list) || !list.length) return list;
  const ids = list.filter((v) => isCloudFileId(v));
  if (!ids.length) return list;
  const app = getTcbApp();
  if (!app) return list;
  try {
    const res = await app.getTempFileURL({ fileList: ids.map((fileID) => ({ fileID, maxAge: maxAge || DEFAULT_TEMP_URL_MAX_AGE })) });
    const map = {};
    (res.fileList || []).forEach((it) => { if (it && it.fileID && it.tempFileURL) map[it.fileID] = it.tempFileURL; });
    return list.map((v) => (isCloudFileId(v) && map[v]) ? map[v] : v);
  } catch (e) {
    console.error('[cloud-storage] 批量换链失败，原样返回:', e && e.message);
    return list;
  }
}

module.exports = {
  DEFAULT_TEMP_URL_MAX_AGE,
  cloudStorageEnabled,
  isCloudFileId,
  uploadImage,
  uploadImageWithId,
  getTempUrl,
  downloadFromCloudStorage,
  resolveInputToDataUrl,
  resolveStoredUrl,
  resolveStoredUrls,
  extFromUrl
};
