const express = require('express');
const multer = require('multer');
const path = require('path');
const { authMiddleware } = require('../middleware/auth');
const { uploadImage } = require('../utils/cloud-storage');

const router = express.Router();
router.use(authMiddleware);

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    cb(null, allowed.includes(file.mimetype));
  }
});

router.post('/image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: 400, message: 'No file uploaded' });
    }

    const ext = (path.extname(req.file.originalname) || '.jpg').replace(/^\./, '');
    // 上传到云存储（COS）；未配置时回退本地磁盘，返回真实可访问 URL
    const url = await uploadImage(req.file.buffer, ext, 'uploads');

    res.json({
      code: 0,
      data: {
        url,
        key: url,
        size: req.file.size
      }
    });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

module.exports = router;
