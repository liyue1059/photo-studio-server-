const express = require('express');
const multer = require('multer');
const path = require('path');
const { authMiddleware } = require('../middleware/auth');
const { uploadImageWithId } = require('../utils/cloud-storage');
const { toAbsoluteUrl } = require('../utils/url');

const router = express.Router();
router.use(authMiddleware);

// Configure multer for memory storage（兼容旧链路：非 callContainer 调用方走 multipart 上传）
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    cb(null, allowed.includes(file.mimetype));
  }
});

/**
 * POST /api/upload/image
 *
 * 两种入参（双端过渡期都支持）：
 *   1) multipart/form-data，字段名 file —— 旧公网链路（wx.uploadFile / HTTP 直传）。
 *   2) JSON body { fileId } —— callContainer 改造后的首选：
 *      前端先用 wx.cloud.uploadFile 把原图传上云存储拿到 cloud:// fileID，
 *      再随请求体带给后端（极小，绕开 callContainer 100KiB 请求体上限）。
 *
 * 无论哪种输入，最终都落云存储（配置了 CLOUDBASE_ENV_ID 时），返回：
 *   { url, fileID, size }
 *   - url：可立即展示/下载的 https 临时链接（云存储 tempFileURL）。
 *   - fileID：cloud:// 永久 ID，前端应把它存进 images 表，取列表时按需换链，
 *     绕开临时链接过期（根治「容器重启丢图」+「相对路径白图」两个 P1）。
 *   未配置云存储时 fileID 为 null，url 退化为 COS / 本地相对路径。
 */
router.post('/image', (req, res) => {
  // multer 包裹：有文件走这里，无文件（JSON 带 fileId）落到错误处理器再解析 body
  upload.single('file')(req, res, async (err) => {
    try {
      if (err) {
        // 不是 multipart（callContainer 走 JSON）→ 继续按 fileId 处理
        if (err.code !== 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ code: 400, message: err.message });
        }
      }

      let buffer = null;
      let ext = 'jpg';
      let size = 0;

      if (req.file) {
        buffer = req.file.buffer;
        ext = (path.extname(req.file.originalname) || '.jpg').replace(/^\./, '');
        size = req.file.size;
      } else {
        const fileId = req.body && req.body.fileId;
        if (!fileId) {
          return res.status(400).json({ code: 400, message: 'No file uploaded or fileId provided' });
        }
        const cloudStorage = require('../utils/cloud-storage');
        const buf = await cloudStorage.downloadFromCloudStorage(fileId);
        buffer = buf;
        size = buf.length;
        ext = cloudStorage.extFromUrl(fileId) || 'jpg';
      }

      if (!buffer) {
        return res.status(400).json({ code: 400, message: 'No file content' });
      }

      const { fileID, url } = await uploadImageWithId(buffer, ext, 'uploads');
      const absUrl = toAbsoluteUrl(url, req);

      res.json({
        code: 0,
        data: {
          url: absUrl,
          fileID: fileID || null,
          key: absUrl,
          size
        }
      });
    } catch (e) {
      console.error('[upload] failed:', e && e.message);
      res.status(500).json({ code: 500, message: e.message || 'upload failed' });
    }
  });
});

module.exports = router;
