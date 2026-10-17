import type { AddDownloadInput } from '../../src/shared/contracts';
import { validateDownloadSchedule } from './scheduling.ts';

export function validateDownloadInputShape(input: unknown): AddDownloadInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('下载请求格式无效');
  const value = input as Record<string, unknown>;
  if (typeof value.url !== 'string' || value.url.length > 16_384) throw new Error('下载地址为空或超过长度限制');
  const url = new URL(value.url);
  if (!['http:', 'https:', 'ftp:', 'ftps:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('普通下载只接受不含内嵌凭据的 HTTP、HTTPS、FTP 或 FTPS 地址');
  }
  if (value.fileName != null && (typeof value.fileName !== 'string' || value.fileName.length > 4096)) throw new Error('文件名无效');
  if (value.directory != null && (typeof value.directory !== 'string' || value.directory.length > 4096)) throw new Error('保存目录无效');
  if (value.headers != null) {
    if (typeof value.headers !== 'object' || Array.isArray(value.headers) || Object.keys(value.headers).length > 64) {
      throw new Error('自定义请求头数量无效');
    }
    for (const [key, header] of Object.entries(value.headers)) {
      if (!key || key.length > 256 || typeof header !== 'string' || header.length > 16_384) {
        throw new Error('自定义请求头格式无效');
      }
    }
  }
  for (const key of ['cookie', 'referer', 'userAgent', 'authScheme', 'authUsername', 'authPassword']) {
    const item = value[key];
    if (item != null && (typeof item !== 'string' || item.length > 16_384)) throw new Error('请求凭据或头字段超过长度限制');
  }
  if (value.allowInsecureAuth != null && typeof value.allowInsecureAuth !== 'boolean') throw new Error('明文认证选项无效');
  if (value.expectedChecksum != null && (typeof value.expectedChecksum !== 'string' || value.expectedChecksum.length > 128)) throw new Error('校验值无效');
  validateDownloadSchedule(value.scheduledAt, value.repeatIntervalSeconds);
  if (value.speedLimitBytesSec != null &&
      (!Number.isFinite(value.speedLimitBytesSec) || Number(value.speedLimitBytesSec) < 0 || Number(value.speedLimitBytesSec) > 1024 * 1024 * 1024)) {
    throw new Error('单任务限速范围无效');
  }
  return value as unknown as AddDownloadInput;
}
