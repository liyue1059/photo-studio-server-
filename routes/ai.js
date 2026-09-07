const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { optionalAuth } = require('../middleware/auth');
const doubao = require('../services/doubao-image');
const { toAbsoluteUrls } = require('../utils/url');
const cloudStorage = require('../utils/cloud-storage');
const redis = require('../utils/redis');
const { checkQuota, decrementQuota } = require('../utils/membership');

const router = express.Router();
router.use(optionalAuth);

const TASK_TTL = 3600; // 1 小时

/**
 * 真正执行一次生成（同步 awaits 豆包，30~90s）。同步 /generate 与异步 /submit 共用。
 * @returns {Promise<{images:string[], model:string, costUsd:number}>}
 *   images 一律是绝对 https URL（未配置 COS 时由 utils/url.js 把本地相对路径补全）。
 */
async function runGeneration({ prompt, category, n, inputImage, aspectRatio, imageRatio }) {
  const opts = {
    category: category || 'baby',
    n: Math.min(4, Math.max(1, parseInt(n) || (inputImage ? 1 : 2))),
    size: '1024x1024',
    image: inputImage || null,
    aspectRatio: aspectRatio || null,
    imageRatio: imageRatio || null
  };

  // 带重试：如果因尺寸参数失败，降级为默认尺寸重试一次
  let result;
  try {
    result = await doubao.generate(prompt, opts);
  } catch (firstErr) {
    const errMsg = firstErr.message || '';
    if (/size|InvalidParameter|parameter.*not valid/i.test(errMsg) && opts.aspectRatio) {
      console.log('[AI] Size-param error, retrying with default 1024x1024...');
      delete opts.aspectRatio;
      opts.size = '1024x1024';
      result = await doubao.generate(prompt, opts);
    } else {
      throw firstErr;
    }
  }
  return result;
}

/** 把请求体解析出图生图输入（fileId 优先，落云存储后下载转 data URL；否则旧 base64 / 公网 URL） */
async function resolveInputImage(body) {
  if (body.fileId) return await cloudStorage.resolveInputToDataUrl(body.fileId);
  return body.image || null;
}

// ──────────────────────────────────────────────────────
// 同步接口（旧链路 / 非 callContainer 通道用；callContainer 下会被 15s 超时掐断，故前端改走 /submit）
// ──────────────────────────────────────────────────────
/**
 * POST /api/ai/generate
 * Body: { prompt: string, category?: 'baby'|'pet', n?: number, size?: string,
 *         image?: string, fileId?: string(cloud://), aspectRatio?: string }
 *   image / fileId — 可选图生图输入。fileId 为 callContainer 改造首选（极小，绕开 100KiB 上限）。
 * Returns: { code:0, data:{ prompt, images:[绝对 URL], model, costUsd } }
 */
router.post('/generate', async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = (body.prompt || '').toString().trim();
    if (!prompt) {
      return res.status(400).json({ code: 400, message: '缺少 prompt 描述文字' });
    }

    const inputImage = await resolveInputImage(body);
    const hasImage = !!(inputImage && inputImage.length > 50);

    // 生产环境脱敏日志
    if (config.env === 'production') {
      console.log('[AI] Request:', { category: body.category, n: body.n, hasImage, hasFileId: !!body.fileId, aspectRatio: body.aspectRatio });
    } else {
      console.log('[AI] Request:', { prompt: prompt.slice(0, 80), category: body.category, n: body.n, aspectRatio: body.aspectRatio, imageSize: hasImage ? inputImage.length + ' chars' : 'none' });
    }

    // 免费额度校验：登录用户且额度耗尽时拦截（会员不受影响）。仅校验不扣减；扣减在成功后。
    if (req.userId) {
      const q = await checkQuota(req.userId);
      if (q === 'exhausted') {
        return res.json({ code: 1, message: '免费额度已用完，看广告或开通会员后继续使用', data: { needQuota: true } });
      }
    }

    const result = await runGeneration({
      prompt, category: body.category, n: body.n,
      inputImage, aspectRatio: body.aspectRatio, imageRatio: body.imageRatio
    });

    const images = toAbsoluteUrls(result.images, req);

    if (req.userId) {
      try { await decrementQuota(req.userId); } catch (e) { console.error('[AI] 扣减额度失败（已成功）:', e && e.message); }
    }

    res.json({
      code: 0,
      data: { prompt, images, model: result.model, costUsd: result.costUsd },
      message: inputImage ? 'AI 图生图完成' : 'AI images generated'
    });
  } catch (err) {
    console.error('[AI] generate failed:', err.message);
    const status = /未配置/.test(err.message) ? 500 : 502;
    res.status(status).json({ code: status, message: err.message || 'AI 生成失败，请稍后重试' });
  }
});

// ──────────────────────────────────────────────────────
// 异步接口（callContainer 改造首选：submit 极快返回 taskId，AI 调用在后台跑，前端轮询 /status）
//   —— 彻底规避 callContainer 15s timeout 上限（豆包同步要 30~90s）。
// ──────────────────────────────────────────────────────
/**
 * POST /api/ai/submit
 * Body: 同 /generate。返回 { taskId, status:'processing' }，前端轮询 /api/ai/status?taskId=。
 */
router.post('/submit', async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = (body.prompt || '').toString().trim();
    if (!prompt) {
      return res.status(400).json({ code: 400, message: '缺少 prompt 描述文字' });
    }

    // 免费额度校验（会员不受影响）。扣减在生成成功后进行。
    if (req.userId) {
      const q = await checkQuota(req.userId);
      if (q === 'exhausted') {
        return res.json({ code: 1, message: '免费额度已用完，看广告或开通会员后继续使用', data: { needQuota: true } });
      }
    }

    const taskId = crypto.randomUUID();
    await redis.set('ai:' + taskId, {
      userId: req.userId || null,
      status: 'processing',
      prompt: prompt.slice(0, 200),
      createdAt: new Date().toISOString()
    }, TASK_TTL);

    // fire-and-forget：不 await，避免请求被 30~90s 的 AI 调用拖住（callContainer 15s 必超时）
    processAi(taskId, req.userId, body);

    res.json({ code: 0, data: { taskId, status: 'processing' } });
  } catch (err) {
    console.error('[AI] submit failed:', err && err.message);
    res.status(500).json({ code: 500, message: err.message || '提交生成任务失败' });
  }
});

/**
 * 后台执行生成任务。所有异常内部消化，结果/错误写回 Redis。
 */
async function processAi(taskId, userId, body) {
  const baseTask = { userId: userId || null, createdAt: new Date().toISOString() };
  try {
    const inputImage = await resolveInputImage(body);
    const result = await runGeneration({
      prompt: (body.prompt || '').toString().trim(),
      category: body.category, n: body.n,
      inputImage, aspectRatio: body.aspectRatio, imageRatio: body.imageRatio
    });

    const images = result.images || [];
    if (!images.length) throw new Error('AI 未返回任何图片');

    // 生成成功 → 扣减 1 次免费额度（会员不受影响；守卫保证不会扣成负数）
    if (userId) {
      try { await decrementQuota(userId); } catch (e) { console.error('[AI] 扣减额度失败（任务已成功）:', e && e.message); }
    }

    await redis.set('ai:' + taskId, Object.assign({}, baseTask, {
      status: 'completed',
      images,
      model: result.model,
      costUsd: result.costUsd,
      completedAt: new Date().toISOString()
    }), TASK_TTL);
  } catch (err) {
    console.error('[AI] task', taskId, 'failed:', err && err.message);
    await redis.set('ai:' + taskId, Object.assign({}, baseTask, {
      status: 'failed',
      error: err && err.message ? err.message : 'AI 生成失败',
      failedAt: new Date().toISOString()
    }), TASK_TTL).catch((e) => console.error('[AI] failed to persist error state:', e && e.message));
  }
}

/**
 * GET /api/ai/status?taskId=xxx
 * 返回 { status, images, error, model, costUsd }
 */
router.get('/status', async (req, res) => {
  try {
    const { taskId } = req.query;
    if (!taskId) return res.status(400).json({ code: 400, message: 'taskId required' });

    const task = await redis.get('ai:' + taskId);
    if (!task) return res.status(404).json({ code: 404, message: 'Task not found' });

    // 仅发起者可查看（防 taskId 枚举盗图）
    if (task.userId && req.userId && task.userId !== req.userId) {
      return res.status(403).json({ code: 403, message: '无权访问该任务' });
    }

    res.json({
      code: 0,
      data: {
        status: task.status,
        images: toAbsoluteUrls(task.images || [], req),
        error: task.error || null,
        model: task.model || null,
        costUsd: task.costUsd || null
      }
    });
  } catch (err) {
    console.error('[AI] status failed:', err && err.message);
    res.status(500).json({ code: 500, message: err.message || '查询任务状态失败' });
  }
});

module.exports = router;
