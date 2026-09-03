const express = require('express');
const config = require('../config');
const { optionalAuth } = require('../middleware/auth');
const doubao = require('../services/doubao-image');
const { toAbsoluteUrls } = require('../utils/url');

const router = express.Router();
router.use(optionalAuth);

/**
 * POST /api/ai/generate
 * Body: { prompt: string, category?: 'baby'|'pet', n?: number, size?: string, image?: string, aspectRatio?: string }
 *   image — 可选，base64 data URL (data:image/jpeg;base64,...) 或公网图片 URL。
 *         传入时执行图生图（img2img）：基于该参考图 + prompt 生成新图。
 *         不传时退化为纯文生图。
 *   aspectRatio — 可选，原图宽高比（如 "3:4"）。图生图时用于保持原图比例，避免被裁切为 1:1。
 * Returns: { code:0, data:{ prompt, images:[绝对 URL], model, costUsd }, message }
 *   images 一律是绝对 https URL（未配置 COS 时由 utils/url.js 把本地相对路径补全），
 *   禁止返回 /ai-generated/xxx.png 这类相对路径——小程序 <image> 会静默白图。
 */
router.post('/generate', async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = (body.prompt || '').toString().trim();
    if (!prompt) {
      return res.status(400).json({ code: 400, message: '缺少 prompt 描述文字' });
    }

    // 日志：记录关键参数便于排查（不打印完整 base64）
    const hasImage = !!(body.image && body.image.length > 50);
    // 生产环境脱敏：不打印用户 prompt 原文，仅记录结构化元信息，避免个人信息落日志
    if (config.env === 'production') {
      console.log('[AI] Request:', {
        category: body.category,
        n: body.n,
        hasImage,
        aspectRatio: body.aspectRatio
      });
    } else {
      console.log('[AI] Request:', {
        prompt: prompt.slice(0, 80),
        category: body.category,
        n: body.n,
        aspectRatio: body.aspectRatio,
        imageRatio: body.imageRatio,
        imageSize: hasImage ? body.image.length + ' chars' : 'none',
        imagePrefix: hasImage ? body.image.slice(0, 30) + '...' : null
      });
    }

    // 构造选项；n 限制在 1~4，防止上游计费意外（服务层也会 clamp，这里做路由层兜底）
    const opts = {
      category: body.category || 'baby',
      n: Math.min(4, Math.max(1, parseInt(body.n) || (hasImage ? 1 : 2))),
      size: body.size || '1024x1024',
      image: body.image || null,
      aspectRatio: body.aspectRatio || null,
      imageRatio: body.imageRatio || null
    };

    // 带重试的调用：如果因尺寸参数失败，降级为默认尺寸重试一次
    let result;
    try {
      result = await doubao.generate(prompt, opts);
    } catch (firstErr) {
      const errMsg = firstErr.message || '';
      // 如果是尺寸/比例相关的参数错误，去掉自定义尺寸重试
      if (/size|InvalidParameter|parameter.*not valid/i.test(errMsg) && opts.aspectRatio) {
        console.log('[AI] Size-param error, retrying with default 1024x1024...');
        delete opts.aspectRatio;
        opts.size = '1024x1024';
        result = await doubao.generate(prompt, opts);
      } else {
        throw firstErr;  // 非尺寸错误，直接抛出
      }
    }

    // 未配置 COS 时 cloud-storage 回退本地磁盘，返回的是 /ai-generated/xxx.png 相对路径。
    // 小程序 <image src> 不认相对路径 → 静默白图，故出参一律规范化成绝对 URL。
    const images = toAbsoluteUrls(result.images, req);

    res.json({
      code: 0,
      data: {
        prompt,
        images,
        model: result.model,
        costUsd: result.costUsd
      },
      message: body.image ? 'AI 图生图完成' : 'AI images generated'
    });
  } catch (err) {
    console.error('[AI] generate failed:', err.message);
    // 502 表示上游（豆包）不可用；其它仍按 500/业务错误处理
    const status = /未配置/.test(err.message) ? 500 : 502;
    // 错误码与 HTTP 状态一致（前端 request.js 仅认 code===0，其余均走 reject）
    res.status(status).json({ code: status, message: err.message || 'AI 生成失败，请稍后重试' });
  }
});

module.exports = router;
