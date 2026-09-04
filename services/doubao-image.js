const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const { uploadImage } = require('../utils/cloud-storage');

/**
 * 将宽高比（如 "3:4"）映射为豆包支持的像素尺寸（WIDTHxHEIGHT 格式）。
 * 豆包 seedream 仅接受像素尺寸或 '1k'/'2k'/'4k'，不支持比例字符串。
 * 注意：图片必须 ≥ 921600 像素（约 960×960）。
 */
function resolveSize(aspectRatio) {
  const map = {
    '1:1':   '1024x1024',
    '3:4':   '960x1280',
    '4:3':   '1280x960',
    '9:16':  '720x1280',
    '16:9':  '1280x720',
    '3:5':   '768x1280',
    '5:3':   '1280x768',
    '2:3':   '960x1440',
    '3:2':   '1440x960'
  };
  if (map[aspectRatio]) return map[aspectRatio];
  const parts = aspectRatio.split(':');
  if (parts.length === 2) {
    const w = parseFloat(parts[0]), h = parseFloat(parts[1]);
    if (w > 0 && h > 0) {
      const r = w / h;
      if (r < 0.65) return '720x1280';
      if (r < 0.85) return '960x1280';
      if (r <= 1.15) return '1024x1024';
      if (r < 1.5) return '1280x960';
      return '1280x720';
    }
  }
  return null;
}

/**
 * 从图片二进制（Node Buffer）头部解析真实宽高。
 * 支持 JPEG / PNG / WebP / GIF。解析失败返回 null。
 */
function getImageDimensions(buf) {
  try {
    const len = buf.length;
    if (len < 12) return null;

    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      if (len < 24) return null;
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }

    // JPEG
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2;
      while (i < len - 9) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          const h = buf.readUInt16BE(i + 5);
          const w = buf.readUInt16BE(i + 7);
          return { w, h };
        }
        const segLen = buf.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
      return null;
    }

    // GIF
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
      if (len < 10) return null;
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }

    // WebP
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourCC = buf.toString('ascii', 12, 16);
      if (fourCC === 'VP8 ' && len > 27) {
        const w = buf.readUInt16LE(24) & 0x3FFF;
        const h = buf.readUInt16LE(26) & 0x3FFF;
        return { w, h };
      }
      if (fourCC === 'VP8L' && len > 25) {
        const bits = buf.readUInt32LE(21);
        const w = (bits & 0x3FFF) + 1;
        const h = ((bits >> 14) & 0x3FFF) + 1;
        return { w, h };
      }
      if (fourCC === 'VP8X' && len > 30) {
        const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) & 0xFFFFFF;
        const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) & 0xFFFFFF;
        return { w, h };
      }
      return null;
    }
  } catch (e) { /* ignore */ }
  return null;
}

/** 将原图宽高映射为最接近的标准比例字符串 */
function calcRatio(w, h) {
  if (!w || !h) return null;
  const r = w / h;
  const presets = [
    { ratio: '1:1', val: 1 },
    { ratio: '3:4', val: 0.75 },
    { ratio: '4:3', val: 1.333 },
    { ratio: '9:16', val: 0.5625 },
    { ratio: '16:9', val: 1.778 },
    { ratio: '2:3', val: 0.667 },
    { ratio: '3:2', val: 1.5 }
  ];
  let best = '1:1', bestDiff = Infinity;
  for (const p of presets) {
    const diff = Math.abs(r - p.val);
    if (diff < bestDiff) { bestDiff = diff; best = p.ratio; }
  }
  return best;
}

/** 从上传图片（base64 data URL）解析真实比例 */
function deriveRatioFromImage(inputImage) {
  try {
    if (!inputImage || typeof inputImage !== 'string') return null;
    let buf;
    if (inputImage.startsWith('data:')) {
      const comma = inputImage.indexOf(',');
      if (comma < 0) return null;
      buf = Buffer.from(inputImage.slice(comma + 1), 'base64');
    } else {
      return null;
    }
    const dim = getImageDimensions(buf);
    if (dim && dim.w && dim.h) return calcRatio(dim.w, dim.h);
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * 构建最终提示词。
 * 图生图：保持原图风格，不加风格引导。纯文生图：追加写实风格。
 */
function buildPrompt(prompt, category, hasImage) {
  if (hasImage) return prompt;
  return `${prompt}, high quality photo, realistic, detailed`;
}

/**
 * 调用火山方舟（豆包）图片生成大模型。
 * @param {string} prompt  文字描述
 * @param {object} opts    { n, size, category, image, aspectRatio, imageRatio }
 * @returns {Promise<{images: string[], model: string, costUsd: number}>}
 */
async function generate(prompt, opts = {}) {
  const apiKey = config.doubao.apiKey;
  if (!apiKey) {
    throw new Error('DOUBAO_API_KEY 未配置，无法调用豆包图片生成（请在 server/.env 中填写）');
  }

  // editMode：老照片修复等「指令编辑」场景走 5.0-lite（见 config.doubao.editModel
  // 的选型说明）。实测 seedream 4.0 img2img 重绘强度极低，会把划痕当场景内容
  // 原样保留，无论提示词怎么写都删不掉损伤。
  const editMode = !!opts.editMode;
  const model = editMode
    ? (config.doubao.editModel || 'doubao-seedream-5-0-lite-260128')
    : (config.doubao.model || 'doubao-seedream-4-0-250828');
  const size = opts.size || '1024x1024';
  const n = Math.min(Math.max(parseInt(opts.n, 10) || 1, 1), 4);
  const inputImage = opts.image || null;
  const aspectRatio = opts.aspectRatio || null;
  const imageRatio = opts.imageRatio || null;
  const category = opts.category === 'pet' ? 'pet' : 'baby';
  const guidedPrompt = buildPrompt(prompt, category, !!inputImage);

  // 构造请求体
  const requestBody = {
    model,
    prompt: guidedPrompt,
    n,
    response_format: 'url'
  };

  // editMode（5.0-lite）：不使用上面的像素尺寸推导。
  // 5.0 系列只接受 '2K' / '3K' 档位，传 1024x1024 会 400 InvalidParameter；
  // 比例由模型跟随输入图自动决定，因此这里固定走 config.doubao.editSize。
  if (editMode) {
    requestBody.size = config.doubao.editSize || '2K';
  } else {
    // ═══════════════════ 尺寸策略（优先级从高到低）════════════════════
    //   1) 提示词显式指定比例（aspectRatio）→ 用户明确意图
    //   2) 从上传图片真实像素推导（服务端解析）
    //   3) 客户端回退比例（imageRatio）
    //   4) 默认 1024x1024
    let finalRatio = aspectRatio || null;
    if (!finalRatio && inputImage) {
      const derived = deriveRatioFromImage(inputImage);
      if (derived) finalRatio = derived;
    }
    if (!finalRatio && imageRatio) {
      finalRatio = imageRatio;
    }
    if (finalRatio) {
      const resolved = resolveSize(finalRatio);
      if (resolved) {
        requestBody.size = resolved;
      } else {
        console.warn('[AI] ratio not mappable:', finalRatio, '-> fallback', size);
        requestBody.size = size;
      }
    } else {
      requestBody.size = size;
    }
  }

  // 图生图模式：附加输入图像
  if (inputImage) {
    requestBody.image = inputImage;
  }

  console.log('[AI] mode =', editMode ? 'edit(repair)' : 'generate(seedream)',
    '| model =', model,
    '| size =', requestBody.size,
    editMode ? '(fixed editSize)' : '(ratio-derived)');

  // ═══════════════════ 调用豆包 API ═══════════════════
  let resp;
  try {
    resp = await axios.post(
      config.doubao.baseUrl,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 90000
      }
    );
  } catch (err) {
    if (err.response && err.response.data) {
      const detail = JSON.stringify(err.response.data).slice(0, 400);
      throw new Error('豆包接口调用失败: ' + detail);
    }
    throw new Error('豆包接口调用失败: ' + (err.message || '网络错误'));
  }

  const items = (resp.data && resp.data.data) ? resp.data.data : [];
  if (!items.length) {
    throw new Error('豆包未返回任何图片');
  }

  // ═══════════════════ 下载并保存结果图片 ═══════════════════
  const saved = [];
  for (const it of items) {
    const src = it.url || (it.b64_json ? `data:image/png;base64,${it.b64_json}` : null);
    if (!src) continue;
    let buf;
    let ext = 'png';
    if (src.startsWith('data:')) {
      buf = Buffer.from(src.split(',')[1], 'base64');
      const mime = src.match(/data:image\/([a-zA-Z0-9.+-]+);/);
      if (mime) ext = mime[1].replace('+xml', '').replace('jpeg', 'jpg');
    } else {
      const dl = await axios.get(src, { responseType: 'arraybuffer', timeout: 30000 });
      buf = Buffer.from(dl.data);
      const pathPart = src.split('?')[0];
      const m = pathPart.match(/\.([a-zA-Z0-9]+)(?:$|#)/);
      if (m) {
        ext = m[1].toLowerCase().replace('jpeg', 'jpg');
      } else if (dl.headers && dl.headers['content-type']) {
        const ct = dl.headers['content-type'];
        if (/png/.test(ct)) ext = 'png';
        else if (/jpe?g/.test(ct)) ext = 'jpg';
        else if (/webp/.test(ct)) ext = 'webp';
      }
    }
    // 上传到云存储（COS）；未配置时回退本地磁盘，返回可访问 URL / 相对路径
    const url = await uploadImage(buf, ext, 'ai-generated');
    saved.push(url);
  }

  if (!saved.length) {
    throw new Error('豆包返回了图片但下载失败');
  }

  return {
    images: saved,
    model,
    costUsd: config.doubao.estCostUsdPerImage * saved.length
  };
}

module.exports = { generate };
