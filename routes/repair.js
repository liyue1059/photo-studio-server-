const express = require('express');
const crypto = require('crypto');
const redis = require('../utils/redis');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Submit repair task
router.post('/submit', async (req, res) => {
  try {
    const { imageUrl, options = {} } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ code: 400, message: 'imageUrl required' });
    }

    const taskId = crypto.randomUUID();

    // Store task in Redis
    await redis.set('repair:' + taskId, {
      userId: req.userId,
      imageUrl,
      options,
      status: 'processing',
      createdAt: new Date().toISOString()
    }, 3600); // 1 hour TTL

    // TODO(上线前决策): 当前为【假实现】——仅做路径字符串替换模拟处理结果，
    // 并未调用任何真实 AI 修复服务；进程重启 / 多实例部署时任务将永久丢失。
    // 上线前二选一：① 接入真实 AI 修复服务（取消下方注释分支）并在前端隐藏/保留轮询；
    // ② 若不做老照片修复功能，直接下线本接口与前端入口。
    // 真实调用分支（待启用）：
    // const aiResult = await axios.post(config.ai.serviceUrl + '/repair', {
    //   image_url: imageUrl, options
    // }, { headers: { 'Authorization': 'Bearer ' + config.ai.apiKey } });

    // Mock: 仅本地开发联调用的占位实现，不可用于生产
    setTimeout(async () => {
      try {
        const mockResultUrl = imageUrl.replace('/uploads/', '/results/');
        await redis.set('repair:' + taskId, {
          userId: req.userId,
          imageUrl,
          options,
          status: 'completed',
          resultUrl: mockResultUrl,
          createdAt: new Date().toISOString()
        }, 3600);
      } catch (err) {
        console.error('Repair callback error:', err);
      }
    }, 2000);

    res.json({
      code: 0,
      data: { taskId, status: 'processing' }
    });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// Get repair task status
router.get('/status', async (req, res) => {
  try {
    const { taskId } = req.query;

    if (!taskId) {
      return res.status(400).json({ code: 400, message: 'taskId required' });
    }

    const task = await redis.get('repair:' + taskId);

    if (!task) {
      return res.status(404).json({ code: 404, message: 'Task not found' });
    }

    res.json({
      code: 0,
      data: {
        status: task.status,
        resultUrl: task.resultUrl || null,
        error: task.error || null
      }
    });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

module.exports = router;
