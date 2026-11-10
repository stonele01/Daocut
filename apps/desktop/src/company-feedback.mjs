/** Explicit feedback attachments only; never read project files or model settings here. */
import { redact } from 'daocut/problems';

export function feedbackExtras(input = {}) {
  const extras = {};
  if (input.diagnostics != null) {
    const value = input.diagnostics;
    if (!value || typeof value !== 'object' || typeof value.report !== 'string'
      || Buffer.byteLength(value.report) > 64 * 1024
      || (value.details != null && (typeof value.details !== 'string' || Buffer.byteLength(value.details) > 256 * 1024))) {
      throw new Error('诊断内容过大或格式不正确，请重新生成。');
    }
    extras.diagnostics = { report: redact(value.report), ...(value.details ? { details: redact(value.details) } : {}) };
  }
  if (input.attachments != null) {
    if (!Array.isArray(input.attachments) || input.attachments.length > 3) throw new Error('最多添加 3 张截图。');
    extras.attachments = input.attachments.map((item) => {
      if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120
        || !['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType)
        || typeof item.data !== 'string' || item.data.length > 2_796_204 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) {
        throw new Error('请使用 PNG、JPG 或 WebP 截图，每张不超过 2 MB。');
      }
      const bytes = Buffer.from(item.data, 'base64');
      if (!bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== item.data) throw new Error('截图文件无效或超过 2 MB。');
      return { name: item.name.replace(/[\\/]/g, '_'), mimeType: item.mimeType, data: item.data };
    });
  }
  return extras;
}
