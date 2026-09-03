const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const redis = require('../utils/redis');
const { authMiddleware } = require('../middleware/auth');
const doubao = require('../services/doubao-image');
const { toAbsoluteUrl } = require('../utils/url');

const router = express.Router();
router.use(authMiddleware);

// ════════════════════════════════════════════════════════════════
// 老照片修复提示词
//
// 设计要点：老照片修复的目标是「还原」而不是「重新创作」。
// 生成式模型天然倾向于 reimagine（重画）输入图，若不显式约束，
// 用户上传的亲人旧照可能被改脸、改姿态、换背景——这是不可接受的。
// 因此提示词用大量 negative / 保持性约束把模型锁在「只修复画质」的范围内。
// ════════════════════════════════════════════════════════════════
const REPAIR_PROMPT = [
  'Restore this old, damaged photograph into a clean, high-quality modern photo.',
  'STRICT PRESERVATION RULES (highest priority):',
  '- Keep the EXACT same person, face, facial features, identity, expression, age and gaze.',
  '- Keep the EXACT same pose, body, hands, clothing, hairstyle, objects, background and composition.',
  '- Do NOT reimagine, restyle, beautify, slim, cartoonize, or change any content.',
  '- Do NOT add or remove any person, object, text, watermark or decorative element.',
  'RESTORATION TASKS:',
  '- Remove film grain, noise, dust spots, scratches, creases, tears, water stains and foxing.',
  '- Reconstruct missing or damaged areas plausibly and seamlessly.',
  '- Sharpen blurred details, especially faces, eyes, hair and fabric texture.',
  '- Correct faded, yellowed or washed-out color; restore natural realistic skin tones.',
  '- Improve dynamic range and clarity while keeping the original mood and era.',
  'OUTPUT: a sharp, clean, high-resolution photograph of the original moment, faithfully restored.'
].join('\n');

// 黑白上色附加约束（仅当 options.colorize 为真时追加）
const COLORIZE_SUFFIX = [
  '',
  'ADDITIONAL: the input is a black-and-white / sepia photograph.',
  '- Add natural, realistic, historically plausible color.',
  '- Keep skin tones, lighting and materials believable; avoid oversaturated or neon colors.',
  '- Everything else stays identical to the original.'
].join('\n');

const TASK_TTL = 3600; // 1 小时

/**
 * 把公网图片 URL 转成 base64 data URL，供豆包图生图接口消费。
 * 豆包 img2img 接受完整 data URL（带 data:image/...;base64, 前缀）。
 */
async function urlToDataURL(imageUrl) {
  const dl = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const buf = Buffer.from(dl.data);
  let mime = 'jpeg';
  if (buf.length > 8) {
    if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'png';
    else if (buf.toString('ascii', 0, 4) === 'RIFF') mime = 'webp';
  }
  return `data:image/${mime};base64,${buf.toString('base64')}`;
}

/**
 * 后台执行修复任务。成功/失败都写回 Redis，前端轮询取结果。
 * 注意：这里是 fire-and-forget，所有异常必须内部消化，不能抛到请求线程。
 */
async function processRepair(taskId, userId, image, imageUrl, options) {
  const baseTask = { userId, createdAt: new Date().toISOString() };
  try {
    // 优先用直传的 base64；只有给了 URL 才去回源下载
    let inputImage = image;
    if (!inputImage && imageUrl) {
      inputImage = await urlToDataURL(imageUrl);
    }
    if (!inputImage) {
      throw new Error('缺少输入图片（image 或 imageUrl 至少提供一个）');
    }

    const prompt = options.colorize ? REPAIR_PROMPT + COLORIZE_SUFFIX : REPAIR_PROMPT;

    const result = await doubao.generate(prompt, {
      // doubao-image 会根据 category 走默认分支；修复场景不属于 baby/pet，
      // 传 'baby' 只是为了满足服务层的枚举，prompt 才是决定性的。
      category: 'baby',
      n: 1,
      image: inputImage
    });

    const resultUrl = result.images && result.images[0];
    if (!resultUrl) {
      throw new Error('AI 未返回修复结果');
    }

    await redis.set(
      'repair:' + taskId,
      Object.assign({}, baseTask, {
        status: 'completed',
        resultUrl,
        model: result.model,
        costUsd: result.costUsd,
        completedAt: new Date().toISOString()
      }),
      TASK_TTL
    );
  } catch (err) {
    console.error('[Repair] task', taskId, 'failed:', err && err.message);
    await redis.set(
      'repair:' + taskId,
      Object.assign({}, baseTask, {
        status: 'failed',
        error: err && err.message ? err.message : 'AI 修复失败',
        failedAt: new Date().toISOString()
      }),
      TASK_TTL
    ).catch((e) => console.error('[Repair] failed to persist error state:', e && e.message));
  }
}

/**
 * POST /api/repair/submit
 * Body: { image?: string(base64 data URL), imageUrl?: string, options?: { colorize?: boolean } }
 * 返回 { taskId, status:'processing' }，前端再轮询 /api/repair/status。
 *
 * 设计说明：之所以不让前端先调 /api/upload 再提交，是为了省掉一次往返——
 * 老照片修复是一次性任务，图片不需要长期留存到用户素材库。
 */
router.post('/submit', async (req, res) => {
  try {
    const { image, imageUrl, options = {} } = req.body || {};

    if (!image && !imageUrl) {
      return res.status(400).json({ code: 400, message: 'image 或 imageUrl 至少提供一个' });
    }

    const taskId = crypto.randomUUID();

    await redis.set(
      'repair:' + taskId,
      {
        userId: req.userId,
        status: 'processing',
        hasImage: !!image,
        imageUrl: imageUrl || null,
        options,
        createdAt: new Date().toISOString()
      },
      TASK_TTL
    );

    // fire-and-forget：不 await，避免 HTTP 请求被 20~60s 的 AI 调用拖住
    processRepair(taskId, req.userId, image, imageUrl, options);

    res.json({ code: 0, data: { taskId, status: 'processing' } });
  } catch (err) {
    console.error('[Repair] submit failed:', err && err.message);
    res.status(500).json({ code: 500, message: err.message || '提交修复任务失败' });
  }
});

/**
 * GET /api/repair/status?taskId=xxx
 * 返回 { status, resultUrl, error, model, costUsd }
 */
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

    // 只允许任务发起者查看结果，避免 taskId 被枚举盗取他人照片
    if (task.userId && req.userId && task.userId !== req.userId) {
      return res.status(403).json({ code: 403, message: '无权访问该任务' });
    }

    res.json({
      code: 0,
      data: {
        status: task.status,
        // 未配置 COS 时结果图是本服务静态目录的相对路径，必须拼绝对地址，
        // 否则小程序拿去下载/展示会失败（<image> 不认相对路径）。
        resultUrl: toAbsoluteUrl(task.resultUrl || null, req),
        error: task.error || null,
        model: task.model || null,
        costUsd: task.costUsd || null
      }
    });
  } catch (err) {
    console.error('[Repair] status failed:', err && err.message);
    res.status(500).json({ code: 500, message: err.message || '查询任务状态失败' });
  }
});

module.exports = router;
