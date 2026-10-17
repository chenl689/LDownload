import { createHash } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client } from 'basic-ftp';
import type { AddDownloadInput, DownloadMetadata, DownloadSegment } from '../../src/shared/contracts';
import { createDownloadThrottle, sanitizeDownloadFileName } from './http/http-engine.ts';

export interface FtpTransferSettings {
  connectTimeoutSeconds: number;
  maxRetries: number;
  speedLimitBytesSec: number;
  proxyMode: 'system' | 'custom' | 'disabled';
}

export interface FtpInspection extends DownloadMetadata {
  finalUrl: string;
  etag: null;
  lastModified: string | null;
}

export interface FtpProgress {
  totalBytes: number | null;
  downloadedBytes: number;
  segments: DownloadSegment[];
  etag: null;
  lastModified: string | null;
}

interface FtpResumeRecord {
  version: 1;
  url: string;
  remotePath: string;
  totalBytes: number | null;
  lastModified: string | null;
}

function parseFtpUrl(value: string): { url: URL; remotePath: string; secure: boolean; port: number } {
  if (typeof value !== 'string' || value.length > 16_384) throw new Error('下载地址为空或超过长度限制');
  const url = new URL(value);
  if (!['ftp:', 'ftps:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('普通下载只接受不含内嵌凭据的 FTP 或 FTPS 地址');
  }
  if (url.search) throw new Error('FTP 下载地址不能包含查询参数');
  let remotePath: string;
  try { remotePath = decodeURIComponent(url.pathname); }
  catch { throw new Error('FTP 下载地址中的文件路径编码无效'); }
  if (!remotePath || remotePath === '/' || /[\0-\x1f\x7f]/.test(remotePath)) throw new Error('FTP 下载地址必须指向一个有效文件');
  const secure = url.protocol === 'ftps:';
  return { url, remotePath, secure, port: url.port ? Number(url.port) : secure ? 990 : 21 };
}

function remoteFileName(remotePath: string): string {
  const leaf = remotePath.split('/').filter(Boolean).at(-1) || 'download';
  return sanitizeDownloadFileName(leaf);
}

function ftpCredentials(input: Pick<AddDownloadInput, 'authScheme' | 'authUsername' | 'authPassword' | 'allowInsecureAuth'>, secure: boolean): { user: string; password: string } {
  const suppliedCredentials = Boolean(input.authUsername?.trim() || input.authPassword);
  const user = input.authUsername?.trim() || 'anonymous';
  const password = input.authPassword || (user === 'anonymous' ? 'guest' : '');
  if (input.authScheme === 'bearer') throw new Error('FTP 不支持 HTTP Bearer 认证');
  if (/[\0-\x1f\x7f]/.test(user) || /[\0-\x1f\x7f]/.test(password)) throw new Error('FTP 用户名或密码包含无效控制字符');
  if (!secure && suppliedCredentials && !input.allowInsecureAuth) throw new Error('普通 FTP 会明文发送登录凭据；请改用 FTPS 或明确允许未加密认证');
  return { user, password };
}

async function connectFtp(
  parsed: ReturnType<typeof parseFtpUrl>,
  input: Pick<AddDownloadInput, 'authScheme' | 'authUsername' | 'authPassword' | 'allowInsecureAuth'>,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<Client> {
  const client = new Client(Math.max(5, Math.min(300, timeoutSeconds)) * 1000);
  const credentials = ftpCredentials(input, parsed.secure);
  const abort = () => client.close();
  if (signal?.aborted) {
    client.close();
    throw signal.reason || new Error('下载已暂停');
  }
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await client.access({
      host: parsed.url.hostname,
      port: parsed.port,
      user: credentials.user,
      password: credentials.password,
      secure: parsed.secure ? (parsed.port === 990 ? 'implicit' : true) : false,
    });
    if (signal?.aborted) throw signal.reason || new Error('下载已暂停');
    return client;
  } catch (error) {
    client.close();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function remoteMetadata(client: Client, parsed: ReturnType<typeof parseFtpUrl>): Promise<FtpInspection> {
  let totalBytes: number | null = null;
  let lastModified: string | null = null;
  try {
    const size = await client.size(parsed.remotePath);
    if (Number.isSafeInteger(size) && size >= 0) totalBytes = size;
  } catch { /* SIZE is optional on older FTP servers. */ }
  try {
    const modified = await client.lastMod(parsed.remotePath);
    if (modified instanceof Date && Number.isFinite(modified.getTime())) lastModified = modified.toISOString();
  } catch { /* MDTM is optional; resume is disabled without a validator. */ }
  return {
    fileName: remoteFileName(parsed.remotePath),
    contentType: null,
    totalBytes,
    supportsRanges: false,
    finalUrl: parsed.url.href,
    etag: null,
    lastModified,
  };
}

export async function inspectFtpUrl(
  input: Pick<AddDownloadInput, 'url' | 'fileName' | 'headers' | 'cookie' | 'referer' | 'userAgent' | 'authScheme' | 'authUsername' | 'authPassword' | 'allowInsecureAuth'>,
  timeoutSeconds = 30,
): Promise<FtpInspection> {
  const parsed = parseFtpUrl(input.url);
  if ((input.headers && Object.keys(input.headers).length) || input.cookie || input.referer || input.userAgent) {
    throw new Error('FTP 不支持 HTTP 请求头、Cookie、Referer 或 User-Agent');
  }
  const client = await connectFtp(parsed, input, timeoutSeconds);
  try {
    const metadata = await remoteMetadata(client, parsed);
    if (input.fileName?.trim()) metadata.fileName = sanitizeDownloadFileName(input.fileName.trim());
    return metadata;
  } finally { client.close(); }
}

async function fileHash(path: string, algorithm: string): Promise<string> {
  if (!['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'].includes(algorithm)) throw new Error('校验算法必须是 MD5 或 SHA-1/224/256/384/512');
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

function isRetryable(error: unknown): boolean {
  const code = Number((error as { code?: unknown } | null)?.code);
  if (Number.isFinite(code)) return code >= 400 && code < 500;
  return /ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE|timeout|socket/i.test(String(error));
}

function waitBeforeRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('下载已暂停'));
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolveWait(); }, delayMs);
    const abort = () => { clearTimeout(timer); rejectWait(signal.reason || new Error('下载已暂停')); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function downloadFtpTask(
  task: { url: string; fileName: string; directory: string; expectedChecksum: string | null; checksumAlgorithm: string; speedLimitBytesSec?: number | null } & Partial<AddDownloadInput>,
  settings: FtpTransferSettings,
  signal: AbortSignal,
  onProgress: (progress: FtpProgress) => void,
  beforeFinalize?: (partialPath: string) => Promise<void>,
): Promise<{ fileName: string; metadata: FtpInspection }> {
  if (settings.proxyMode !== 'disabled') throw new Error('当前 FTP 引擎不支持代理；请将代理设置为直接连接');
  const parsed = parseFtpUrl(task.url);
  const outputName = sanitizeDownloadFileName(task.fileName || remoteFileName(parsed.remotePath));
  const output = resolve(task.directory, outputName);
  const part = output + '.part';
  const sidecar = output + '.ldl';
  if (await lstat(output).then(() => true, () => false)) throw new Error('目标文件已存在，请更改保存名称');
  await mkdir(dirname(output), { recursive: true });
  const oldPart = await lstat(part).catch(() => null);
  const oldSidecar = await lstat(sidecar).catch(() => null);
  if (oldPart && (oldPart.isSymbolicLink() || !oldPart.isFile())) throw new Error('临时下载文件不是普通文件');
  if (oldSidecar && (oldSidecar.isSymbolicLink() || !oldSidecar.isFile())) throw new Error('断点元数据不是普通文件');

  const throttle = createDownloadThrottle();
  const retries = Math.max(0, Math.min(10, Math.floor(settings.maxRetries)));
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal.aborted) throw signal.reason || new Error('下载已暂停');
    let client: Client | null = null;
    let abortClient: (() => void) | null = null;
    let metadata: FtpInspection | null = null;
    try {
      client = await connectFtp(parsed, task, settings.connectTimeoutSeconds, signal);
      if (signal.aborted) throw signal.reason || new Error('下载已暂停');
      abortClient = () => client?.close();
      signal.addEventListener('abort', abortClient, { once: true });
      metadata = await remoteMetadata(client, parsed);
      const inspection = metadata;
      const recordMatches = (record: FtpResumeRecord) => Boolean(inspection.lastModified) && record.version === 1 && record.url === task.url &&
        record.remotePath === parsed.remotePath && record.totalBytes === inspection.totalBytes && record.lastModified === inspection.lastModified;
      let offset = 0;
      const currentPart = await lstat(part).catch(() => null);
      if (currentPart && (currentPart.isSymbolicLink() || !currentPart.isFile())) throw new Error('临时下载文件不是普通文件');
      if (currentPart && inspection.lastModified && inspection.totalBytes !== null) {
        try {
          const record = JSON.parse(await readFile(sidecar, 'utf8')) as FtpResumeRecord;
          const currentSize = (await stat(part)).size;
          if (recordMatches(record) && currentSize <= inspection.totalBytes) offset = currentSize;
        } catch { /* A missing or corrupt record restarts safely. */ }
      }
      if (!inspection.lastModified || inspection.totalBytes === null || (offset === 0 && currentPart)) {
        await rm(part, { force: true });
        await rm(sidecar, { force: true });
        offset = 0;
      }
      if (inspection.totalBytes !== null && offset > inspection.totalBytes) {
        await rm(part, { force: true }); await rm(sidecar, { force: true }); offset = 0;
      }
      const record: FtpResumeRecord = { version: 1, url: task.url, remotePath: parsed.remotePath, totalBytes: inspection.totalBytes, lastModified: inspection.lastModified };
      await atomicJson(sidecar, record);
      let downloadedBytes = offset;
      let lastSaved = Date.now();
      let saveChain = Promise.resolve();
      const save = () => {
        saveChain = saveChain.catch(() => undefined).then(async () => {
          if (signal.aborted) downloadedBytes = await stat(part).then(info => info.size, () => downloadedBytes);
          await atomicJson(sidecar, record);
        });
        return saveChain;
      };
      const makeSegments = (active: boolean): DownloadSegment[] => [{
        index: 0,
        downloadedBytes,
        totalBytes: inspection.totalBytes ?? 0,
        rangeStart: 0,
        rangeEnd: inspection.totalBytes === null ? null : Math.max(0, inspection.totalBytes - 1),
        active,
      }];
      onProgress({ totalBytes: inspection.totalBytes, downloadedBytes, segments: makeSegments(false), etag: null, lastModified: inspection.lastModified });

      if (inspection.totalBytes === null || offset < inspection.totalBytes) {
        const handle = await open(part, offset > 0 ? 'r+' : 'w+', 0o600);
        const fileStream = createWriteStream(part, { fd: handle.fd, start: offset, autoClose: false });
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            const bytes = chunk.length;
            void throttle(settings.speedLimitBytesSec, task.speedLimitBytesSec ?? 0, bytes)
              .then(() => callback(null, chunk), error => callback(error instanceof Error ? error : new Error(String(error))));
          },
        });
        const outputDone = pipeline(limiter, fileStream);
        client.trackProgress(progress => {
          if (progress.type !== 'download') return;
          downloadedBytes = Math.min(inspection.totalBytes ?? Number.MAX_SAFE_INTEGER, offset + progress.bytes);
          const now = Date.now();
          onProgress({ totalBytes: inspection.totalBytes, downloadedBytes, segments: makeSegments(true), etag: null, lastModified: inspection.lastModified });
          if (now - lastSaved >= 1000) { lastSaved = now; void save().catch(() => undefined); }
        });
        try {
          await Promise.all([client.downloadTo(limiter, parsed.remotePath, offset), outputDone]);
          await handle.sync();
        } catch (error) {
          limiter.destroy(error instanceof Error ? error : new Error(String(error)));
          await outputDone.catch(() => undefined);
          await handle.sync().catch(() => undefined);
          throw error;
        } finally {
          await handle.close().catch(() => undefined);
        }
        downloadedBytes = await stat(part).then(info => info.size);
      }
      await save();
      if (inspection.totalBytes !== null && downloadedBytes !== inspection.totalBytes) throw new Error('FTP 传输长度与远端文件大小不一致');
      if (signal.aborted) throw signal.reason || new Error('下载已暂停');
      if (task.expectedChecksum) {
        const expected = task.expectedChecksum.trim();
        const lengths: Record<string, number> = { md5: 32, sha1: 40, sha224: 56, sha256: 64, sha384: 96, sha512: 128 };
        const algorithm = task.checksumAlgorithm || 'sha256';
        if (!lengths[algorithm] || expected.length !== lengths[algorithm] || !/^[a-f0-9]+$/i.test(expected)) throw new Error('校验值必须是有效的 MD5、SHA1 或 SHA256 十六进制字符串');
        if ((await fileHash(part, algorithm)).toLowerCase() !== expected.toLowerCase()) {
          await rm(part, { force: true }); await rm(sidecar, { force: true });
          throw new Error('文件校验失败：下载内容的校验值与预期不一致');
        }
      }
      if (beforeFinalize) await beforeFinalize(part);
      if (await lstat(output).then(() => true, () => false)) throw new Error('目标文件已存在，请更改保存名称');
      await rename(part, output);
      await rm(sidecar, { force: true }).catch(() => undefined);
      onProgress({ totalBytes: inspection.totalBytes, downloadedBytes, segments: makeSegments(false), etag: null, lastModified: inspection.lastModified });
      return { fileName: outputName, metadata: inspection };
    } catch (error) {
      if (signal.aborted) {
        const size = await stat(part).then(info => info.size, () => 0);
        if (metadata) {
          const record: FtpResumeRecord = { version: 1, url: task.url, remotePath: parsed.remotePath, totalBytes: metadata.totalBytes, lastModified: metadata.lastModified };
          if (metadata.lastModified && metadata.totalBytes !== null) await atomicJson(sidecar, record).catch(() => undefined);
          onProgress({ totalBytes: metadata.totalBytes, downloadedBytes: size, segments: [{ index: 0, downloadedBytes: size, totalBytes: metadata.totalBytes ?? 0, rangeStart: 0, rangeEnd: metadata.totalBytes === null ? null : Math.max(0, metadata.totalBytes - 1), active: false }], etag: null, lastModified: metadata.lastModified });
        }
        throw signal.reason || error;
      }
      if (attempt >= retries || !isRetryable(error)) throw error;
      await waitBeforeRetry(Math.min(15_000, 500 * 2 ** attempt), signal);
    } finally {
      if (abortClient) signal.removeEventListener('abort', abortClient);
      client?.close();
    }
  }
  throw new Error('FTP 下载失败');
}