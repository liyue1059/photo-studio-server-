const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const redis = require('../utils/redis');
const { authMiddleware } = require('../middleware/auth');
const doubao = require('../services/doubao-image');
const { toAbsoluteUrl } = require('../utils/url');
const cloudStorage = require('../utils/cloud-storage');
const { checkQuota, decrementQuota } = require('../utils/membership');

const router = express.Router();
router.use(authMiddleware);

// ════════════════════════════════════════════════════════════════
// 老照片修复提示词（中文，走 seedream 5.0-lite）
//
// 设计要点（2026-09-04 实测定版）：
//   1) 修复目标是「还原」而不是「重新创作」，保真约束必须保留；
//   2) 但旧版英文长 prompt（大段 Do NOT...）在 seedream 4.0 img2img 上
//      实测会把划痕当场景内容原样保留——重绘强度天生极低，5 组提示词
//      变体（英文长/短、中文、损伤重解释）全部删不掉划痕；
//   3) 故改走 seedream 5.0-lite（见 config.doubao.editModel）——该模型指令
//      遵循显著更强，且是本账号已开通模型里单价最低的；提示词改为中文短句、
//      修复动作优先、保真约束收敛为一段。
// ════════════════════════════════════════════════════════════════
const REPAIR_PROMPT = [
  '修复这张受损的老照片。图中所有白色划痕、折痕、裂纹、斑渍、霉斑和噪点都是照片的物理损伤，不是场景内容，必须彻底去除，并无缝重建被它们覆盖的皮肤、衣物和背景。',
  '同时锐化模糊的面部、眼睛、发丝和衣物细节，恢复干净自然的影调与清晰度。',
  '严格保持不变：人物的长相、五官、表情、年龄、姿势、服装、发型以及背景构图完全相同，不得重新创作，不得改变、增删画面中的任何内容。',
  '输出：同一张照片的完好修复版——干净、清晰、高质量。'
].join('\n');

// 黑白上色附加约束（仅当 options.colorize 为真时追加）
const COLORIZE_SUFFIX = [
  '',
  '补充：这张照片是黑白或泛黄的旧照片。',
  '- 为其添加自然、真实、符合历史年代感的色彩。',
  '- 肤色、光照和材质要真实可信，避免过饱和或荧光色。',
  '- 其余内容保持与上述要求完全一致。'
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
 * 把公网图片 URL 下载为 Buffer（用于把豆包返回的临时图转存进云存储，避免外链过期）。
 */
async function downloadUrlToBuffer(imageUrl) {
  const dl = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(dl.data);
}

/**
 * 后台执行修复任务。成功/失败都写回 Redis，前端轮询取结果。
 * 注意：这里是 fire-and-forget，所有异常必须内部消化，不能抛到请求线程。
 *
 * @param {object} input { fileId?, image?(base64), imageUrl?, options? }
 *   fileId —— callContainer 改造后的首选输入（前端 wx.cloud.uploadFile 拿到的 cloud:// ID），
 *            体积极小，绕开 callContainer 100KiB 请求体上限。仍兼容旧 base64 / 公网 URL。
 */
async function processRepair(taskId, userId, input) {
  const { fileId, image, imageUrl, options = {} } = input || {};
  const baseTask = { userId, createdAt: new Date().toISOString() };
  try {
    // 输入优先级：cloud:// fileId（下载转 data URL）→ 直传 base64 → 回源公网 URL
    let inputImage = image;
    if (fileId) {
      inputImage = await cloudStorage.resolveInputToDataUrl(fileId);
    } else if (!inputImage && imageUrl) {
      inputImage = await urlToDataURL(imageUrl);
    }
    if (!inputImage) {
      throw new Error('缺少输入图片（fileId / image / imageUrl 至少提供一个）');
    }

    const prompt = options.colorize ? REPAIR_PROMPT + COLORIZE_SUFFIX : REPAIR_PROMPT;

    const result = await doubao.generate(prompt, {
      // 走 5.0-lite 修复模型（editMode）——seedream 4.0 img2img 实测删不掉划痕
      editMode: true,
      // 修复场景不属于 baby/pet，category 仅用于满足服务层枚举，prompt 才是决定性的
      category: 'baby',
      n: 1,
      image: inputImage
    });

    const rawUrl = result.images && result.images[0];
    if (!rawUrl) {
      throw new Error('AI 未返回修复结果');
    }

    // 结果图转存云存储（修复「容器重启丢图」+「相对路径白图」两个 P1）：
    // 豆包返回的是其临时 URL，可能过期；落云存储后拿稳定可访问的 https 链接。
    // 转存失败不致命——保留原始 URL 并打日志，前端仍可尝试直接展示。
    let resultUrl = rawUrl;
    try {
      const buf = await downloadUrlToBuffer(rawUrl);
      resultUrl = await cloudStorage.uploadImage(buf, cloudStorage.extFromUrl(rawUrl), 'repairs');
    } catch (e) {
      console.error('[Repair] 结果图转存云存储失败，回退原始 URL:', e && e.message);
    }

    // 修复成功 → 扣减 1 次免费额度；独立 try 避免扣减异常把「已成功」任务误标失败
    try {
      await decrementQuota(userId);
    } catch (e) {
      console.error('[Repair] 扣减额度失败（任务已成功）:', e && e.message);
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
 * Body: { fileId?: string(cloud://), image?: string(base64 data URL), imageUrl?: string,
 *         options?: { colorize?: boolean } }
 * 返回 { taskId, status:'processing' }，前端再轮询 /api/repair/status。
 *
 * 设计说明：
 *   - fileId 为 callContainer 改造后的首选输入：前端先用 wx.cloud.uploadFile 把图传上云存储，
 *     拿到极小的 cloud:// ID 再随请求体带给后端，绕开 callContainer 100KiB 请求体上限
 *     （旧方案直接传 500KB base64 会被网关拒）。
 *   - 仍兼容旧 base64 / 公网 URL 输入，便于过渡期双端不同步上线时不崩。
 *   - 老照片修复是一次性任务，图片不长期留存用户素材库，故不让前端先调 /api/upload。
 *   - submit 本身极快返回（AI 调用在 fire-and-forget 里跑），完全满足 callContainer 15s 超时。
 */
router.post('/submit', async (req, res) => {
  try {
    const { fileId, image, imageUrl, options = {} } = req.body || {};

    if (!fileId && !image && !imageUrl) {
      return res.status(400).json({ code: 400, message: 'fileId、image、imageUrl 至少提供一个' });
    }

    // 免费额度校验：额度耗尽时拦截（会员不受影响）。扣减在 AI 修复成功后进行。
    const q = await checkQuota(req.userId);
    if (q === 'exhausted') {
      return res.json({
        code: 1,
        message: '免费额度已用完，看广告或开通会员后继续使用',
        data: { needQuota: true }
      });
    }

    const taskId = crypto.randomUUID();

    await redis.set(
      'repair:' + taskId,
      {
        userId: req.userId,
        status: 'processing',
        hasImage: !!(fileId || image),
        imageUrl: imageUrl || null,
        options,
        createdAt: new Date().toISOString()
      },
      TASK_TTL
    );

    // fire-and-forget：不 await，避免 HTTP 请求被 20~60s 的 AI 调用拖住
    processRepair(taskId, req.userId, { fileId, image, imageUrl, options });

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
