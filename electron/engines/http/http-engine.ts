import { createHash } from 'node:crypto';
import { resolveAdaptiveDownloadConfig, type AdaptiveDownloadConfig } from './adaptive-config.ts';
import { RangeScheduler, type ByteRange, type RangeLease } from './range-scheduler.ts';
import { ConcurrencyController, type ConcurrencyDecision } from './concurrency-controller.ts';
import { fetch as undiciFetch, Headers as UndiciHeaders, ProxyAgent, Socks5ProxyAgent, type Dispatcher, type Response as UndiciResponse } from 'undici';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { normalizeDownloadSegmentCount, type AddDownloadInput, type DownloadMetadata, type DownloadSegment } from '../../../src/shared/contracts.ts';

export interface HttpAdaptiveTelemetry {
  concurrency: number;
  activeWorkers: number;
  totalSpeedBytesPerSecond: number;
  workerSpeeds: Array<{ workerId: number; speedBytesPerSecond: number }>;
  steals: number;
  hedges: number;
  evictions: number;
  retries: number;
}
export interface HttpAdaptiveEvent extends ConcurrencyDecision {
  telemetry: HttpAdaptiveTelemetry;
}
export interface HttpTransferSettings {
  connectTimeoutSeconds: number;
  maxRetries: number;
  speedLimitBytesSec: number;
  /** Fixed number of HTTP ranges; optional for compatibility with existing callers. */
  segmentsPerDownload?: number;
  /** @deprecated Use segmentsPerDownload. */
  autoSegmentDownloads: boolean;
  adaptiveConfig?: Partial<AdaptiveDownloadConfig>;
  debugAdaptive?: boolean;
  onAdaptiveEvent?: (event: HttpAdaptiveEvent) => void;
  maxGlobalConnections?: number;
  virusScannerPath?: string | null;
  virusScannerArguments?: string[];
  proxyMode: 'system' | 'custom' | 'disabled';
  proxyUrl: string | null;
  proxyUsername?: string | null;
  proxyPassword?: string | null;
  allowInsecureProxyAuth?: boolean;
}
export interface HttpInspection extends DownloadMetadata {
  finalUrl: string;
  etag: string | null;
  lastModified: string | null;
}
export interface HttpTaskState {
  id: string;
  url: string;
  fileName: string;
  directory: string;
  totalBytes: number | null;
  downloadedBytes: number;
  segments: DownloadSegment[];
  etag: string | null;
  lastModified: string | null;
  expectedChecksum: string | null;
  checksumAlgorithm: string;
  speedLimitBytesSec?: number | null;
}
export interface HttpProgress {
  totalBytes: number | null;
  downloadedBytes: number;
  segments: DownloadSegment[];
  etag: string | null;
  lastModified: string | null;
  adaptive?: HttpAdaptiveTelemetry;
}
interface ResumeRecordV1 {
  version: 1;
  url: string;
  finalUrl: string;
  totalBytes: number | null;
  supportsRanges: boolean;
  etag: string | null;
  lastModified: string | null;
  segments: DownloadSegment[];
}
interface ResumeRecordV2 {
  version: 2;
  url: string;
  finalUrl: string;
  totalBytes: number;
  supportsRanges: true;
  etag: string | null;
  lastModified: string | null;
  completedRanges: ByteRange[];
}
type ResumeRecord = ResumeRecordV1 | ResumeRecordV2;
const RESERVED_HEADERS = new Set(['range', 'host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding']);

interface HttpConnectionWaiter {
  host: string;
  globalLimit: number;
  domainLimit: number;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  abort: () => void;
}

/** Process-wide connection budget, with a fair host-specific sub-limit. */
class HttpConnectionLimiter {
  private active = 0;
  private readonly activeByHost = new Map<string, number>();
  private readonly waiters: HttpConnectionWaiter[] = [];

  async acquireSlot(host: string, globalLimit: number, domainLimit: number, signal: AbortSignal): Promise<() => void> {
    const normalizedHost = host.toLowerCase();
    const safeGlobal = Math.max(1, Math.min(256, Math.floor(globalLimit) || 64));
    const safeDomain = Math.max(1, Math.min(256, Math.floor(domainLimit) || 8));
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('下载已取消');
    if (this.waiters.length === 0 && this.canAcquire(normalizedHost, safeGlobal, safeDomain)) {
      this.take(normalizedHost);
      return this.releaseFor(normalizedHost);
    }
    return new Promise((resolveWait, rejectWait) => {
      const waiter: HttpConnectionWaiter = {
        host: normalizedHost,
        globalLimit: safeGlobal,
        domainLimit: safeDomain,
        signal,
        resolve: release => { signal.removeEventListener('abort', waiter.abort); resolveWait(release); },
        reject: error => { signal.removeEventListener('abort', waiter.abort); rejectWait(error); },
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter.reject(signal.reason instanceof Error ? signal.reason : new Error('下载已取消'));
          this.dispatch();
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  private canAcquire(host: string, globalLimit: number, domainLimit: number): boolean {
    return this.active < globalLimit && (this.activeByHost.get(host) || 0) < domainLimit;
  }

  private take(host: string): void {
    this.active++;
    this.activeByHost.set(host, (this.activeByHost.get(host) || 0) + 1);
  }

  private releaseFor(host: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const count = Math.max(0, (this.activeByHost.get(host) || 0) - 1);
      if (count) this.activeByHost.set(host, count);
      else this.activeByHost.delete(host);
      this.dispatch();
    };
  }

  private dispatch(): void {
    let index = 0;
    while (index < this.waiters.length) {
      const waiter = this.waiters[index]!;
      if (waiter.signal.aborted) {
        this.waiters.splice(index, 1);
        waiter.reject(new Error('下载已取消'));
        continue;
      }
      if (!this.canAcquire(waiter.host, waiter.globalLimit, waiter.domainLimit)) {
        index++;
        continue;
      }
      this.waiters.splice(index, 1);
      this.take(waiter.host);
      waiter.resolve(this.releaseFor(waiter.host));
    }
  }
}

function createProxyDispatcher(settings: Pick<HttpTransferSettings, 'proxyMode' | 'proxyUrl' | 'proxyUsername' | 'proxyPassword' | 'allowInsecureProxyAuth'>): Dispatcher | undefined {
  if (settings.proxyMode === 'disabled') return undefined;
  if (settings.proxyMode === 'system') return undefined;
  if (settings.proxyMode !== 'custom') throw new Error('代理模式无效');
  if (!settings.proxyUrl || settings.proxyUrl.length > 2048) throw new Error('请填写有效的代理地址');
  let url: URL;
  try { url = new URL(settings.proxyUrl); } catch { throw new Error('代理地址格式无效'); }
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/' && url.pathname !== '') {
    throw new Error('代理地址仅支持不含路径、查询、凭据的 HTTP、HTTPS 或 SOCKS5 地址');
  }
  const username = settings.proxyUsername?.trim() || '';
  const password = settings.proxyPassword || '';
  if (username && !password) throw new Error('已填写代理用户名，但没有保存代理密码');
  if (username && url.protocol === 'http:' && !settings.allowInsecureProxyAuth) throw new Error('HTTP 代理会以明文传输代理认证；请启用对应选项或改用 HTTPS/SOCKS5 代理');
  if (url.protocol === 'socks5:') {
    return new Socks5ProxyAgent(url, username ? { username, password } : {});
  }
  const options: ConstructorParameters<typeof ProxyAgent>[0] = { uri: url.href };
  if (username) options.token = 'Basic ' + Buffer.from(username + ':' + password, 'utf8').toString('base64');
  return new ProxyAgent(options);
}

async function requestWithProxy(
  url: string | URL,
  init: Parameters<typeof undiciFetch>[1],
  settings: Pick<HttpTransferSettings, 'proxyMode'> | undefined,
  dispatcher?: Dispatcher,
): Promise<UndiciResponse> {
  if (settings?.proxyMode === 'system') {
    const { net } = await import('electron');
    return await net.fetch(url.toString(), { ...init, cache: 'no-store' } as unknown as Parameters<typeof net.fetch>[1]) as unknown as UndiciResponse;
  }
  return undiciFetch(url, { ...init, ...(dispatcher ? { dispatcher } : {}) });
}

const httpConnections = new HttpConnectionLimiter();

function createTokenBucket(): (limit: number, size: number) => Promise<void> {
  let configuredLimit = 0, tokens = 0, updatedAt = Date.now();
  let queue = Promise.resolve();
  return (limit, size) => {
    if (!limit) return Promise.resolve();
    const operation = queue.catch(() => undefined).then(async () => {
      const now = Date.now();
      if (configuredLimit !== limit) { configuredLimit = limit; tokens = limit; updatedAt = now; }
      tokens = Math.min(limit, tokens + (now - updatedAt) * limit / 1000);
      updatedAt = now; tokens -= size;
      if (tokens < 0) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, Math.ceil(-tokens * 1000 / limit)));
        tokens = 0; updatedAt = Date.now();
      }
    });
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  };
}

const sharedTaskThrottle = createTokenBucket();

async function throttleShared(limit: number, size: number): Promise<void> {
  return sharedTaskThrottle(limit, size);
}

export function createDownloadThrottle(): (globalLimit: number, taskLimit: number, size: number) => Promise<void> {
  const taskThrottle = createTokenBucket();
  return async (globalLimit, taskLimit, size) => {
    await throttleShared(globalLimit, size);
    await taskThrottle(taskLimit, size);
  };
}

function assertHttpUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 16_384) throw new Error('下载地址为空或超过长度限制');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('下载地址格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('普通下载只接受不含内嵌凭据的 HTTP 或 HTTPS 地址');
  return url;
}

export function sanitizeDownloadFileName(value: string): string {
  let name = value.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.\.+/g, '_').trim().replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') name = 'download';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  if (name.length > 240) {
    const extension = parse(name).ext.slice(0, 32);
    name = parse(name).name.slice(0, 240 - extension.length) + extension;
  }
  return name;
}

function makeHeaders(input: Partial<AddDownloadInput>, url: string): UndiciHeaders {
  const headers = new UndiciHeaders();
  const custom = input.headers ?? {};
  if (typeof custom !== 'object' || Array.isArray(custom) || Object.keys(custom).length > 64) throw new Error('自定义请求头数量无效');
  for (const [key, value] of Object.entries(custom)) {
    if (RESERVED_HEADERS.has(key.toLowerCase()) || typeof value !== 'string' || key.length > 256 || value.length > 16_384) throw new Error('自定义请求头包含无效或受保护字段');
    try { headers.set(key, value); } catch { throw new Error('自定义请求头格式无效'); }
  }
  if (input.cookie) headers.set('cookie', input.cookie.slice(0, 16_384));
  if (input.referer) headers.set('referer', input.referer.slice(0, 16_384));
  if (input.userAgent) headers.set('user-agent', input.userAgent.slice(0, 1024));
  if (input.authUsername || input.authPassword) {
    if ((input.authScheme || 'Basic').toLowerCase() !== 'basic') throw new Error('目前只支持 HTTP Basic 基础认证');
    if (new URL(url).protocol === 'http:' && !input.allowInsecureAuth) throw new Error('HTTP 明文链接上的 Basic 认证需要明确允许');
    headers.set('authorization', 'Basic ' + Buffer.from((input.authUsername || '') + ':' + (input.authPassword || '')).toString('base64'));
  }
  return headers;
}

function dispositionName(value: string | null): string | null {
  if (!value) return null;
  const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value)?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (encoded) { try { return decodeURIComponent(encoded); } catch { /* Fall back to filename. */ } }
  const match = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|([^;]+))/i.exec(value);
  return match?.[1]?.replace(/\\(.)/g, '$1') ?? match?.[2] ?? match?.[3]?.trim() ?? null;
}
function urlName(url: string): string {
  let name = new URL(url).pathname.split('/').filter(Boolean).pop() || 'download';
  try { name = decodeURIComponent(name); } catch { /* Keep literal URL segment. */ }
  return name;
}
function totalFromRange(value: string | null): number | null {
  const match = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(value || '');
  const size = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}
function timeoutSignal(parent: AbortSignal, seconds: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(Math.max(1, seconds) * 1000)]);
}
async function discard(response: UndiciResponse): Promise<void> { await response.body?.cancel().catch(() => undefined); }
function responseError(status: number, url: string): Error {
  const label: Record<number, string> = { 401: '需要身份验证', 403: '服务器拒绝访问', 404: '文件不存在', 416: '服务器拒绝当前 Range 范围', 429: '服务器限制了请求频率' };
  const error = new Error((label[status] || (status >= 500 ? '服务器暂时不可用' : 'HTTP 请求失败')) + '（HTTP ' + status + '）: ' + url);
  (error as Error & { retryable?: boolean }).retryable = status === 408 || status === 429 || status >= 500;
  return error;
}

export async function inspectHttpUrl(
  input: Pick<AddDownloadInput, 'url' | 'fileName' | 'headers' | 'cookie' | 'referer' | 'userAgent' | 'authScheme' | 'authUsername' | 'authPassword' | 'allowInsecureAuth'>,
  timeoutSeconds = 30,
  signal: AbortSignal = new AbortController().signal,
  proxySettings?: HttpTransferSettings,
  dispatcher?: Dispatcher,
): Promise<HttpInspection> {
  const ownedDispatcher = proxySettings && !dispatcher ? createProxyDispatcher(proxySettings) : undefined;
  const activeDispatcher = dispatcher ?? ownedDispatcher;
  try {
  const url = assertHttpUrl(input.url);
  const headers = makeHeaders(input, url.href);
  let head: UndiciResponse | null = null;
  try { head = await requestWithProxy(url, { method: 'HEAD', headers, redirect: 'follow', signal: timeoutSignal(signal, timeoutSeconds) }, proxySettings, activeDispatcher); }
  catch (error) { if (signal.aborted) throw error; }
  if (head && !head.ok && ![405, 501].includes(head.status)) {
    const error = responseError(head.status, url.href); await discard(head); throw error;
  }
  const headLength = head?.headers.get('content-length') || '';
  const headSize = /^\d+$/.test(headLength) ? Number(headLength) : null;
  const rangeHeaders = new UndiciHeaders(headers);
  rangeHeaders.set('range', 'bytes=0-0');
  const probe = await requestWithProxy(head?.url || url, { method: 'GET', headers: rangeHeaders, redirect: 'follow', signal: timeoutSignal(signal, timeoutSeconds) }, proxySettings, activeDispatcher);
  if (!probe.ok && probe.status !== 206) { const error = responseError(probe.status, probe.url || url.href); await discard(probe); throw error; }
  const supportsRanges = probe.status === 206;
  const contentLength = probe.headers.get('content-length') || '';
  const totalBytes = supportsRanges ? totalFromRange(probe.headers.get('content-range')) : headSize ?? (/^\d+$/.test(contentLength) ? Number(contentLength) : null);
  const finalUrl = probe.url || url.href;
  const fallback = dispositionName(probe.headers.get('content-disposition')) || dispositionName(head?.headers.get('content-disposition') || null) || urlName(finalUrl);
  const result: HttpInspection = {
    fileName: sanitizeDownloadFileName(input.fileName?.trim() || fallback),
    contentType: probe.headers.get('content-type') || head?.headers.get('content-type') || null,
    totalBytes: totalBytes !== null && Number.isSafeInteger(totalBytes) ? totalBytes : null,
    supportsRanges,
    finalUrl,
    etag: probe.headers.get('etag') || head?.headers.get('etag') || null,
    lastModified: probe.headers.get('last-modified') || head?.headers.get('last-modified') || null,
  };
  await discard(probe); if (head) await discard(head);
  return result;
  } finally { if (ownedDispatcher) await ownedDispatcher.close().catch(() => undefined); }
}

async function saveJson(path: string, value: unknown): Promise<void> {
  const temp = path + '.' + process.pid + '.tmp';
  await rm(temp, { force: true }).catch(() => undefined);
  await writeFile(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  await rm(path, { force: true }).catch(() => undefined);
  await rename(temp, path);
}

async function fileHash(path: string, algorithm: string): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function validateHash(algorithm: string, expected: string): void {
  const lengths: Record<string, number> = { md5: 32, sha1: 40, sha256: 64 };
  if (!lengths[algorithm] || expected.length !== lengths[algorithm] || !/^[a-f0-9]+$/i.test(expected)) {
    throw new Error('校验值必须是有效的 MD5、SHA1 或 SHA256 十六进制字符串');
  }
}

const REMOTE_CHANGED = 'REMOTE_VERSION_CHANGED';
const UNSUPPORTED_RANGES = 'HTTP_RANGE_UNSUPPORTED';
const SCRATCH_COPY_BYTES = 1024 * 1024;

interface WorkerSpeedState {
  ewma: number;
  sampleBytes: number;
  sampleAt: number;
}
interface ActiveRange {
  lease: RangeLease;
  controller: AbortController;
  workerId: number;
  scratchPath: string;
  scratch: Awaited<ReturnType<typeof open>> | null;
  copyFailed: boolean;
  rangeSpeed: number;
  lastProgressAt: number;
  slowSinceAt: number;
  yieldReason: 'steal' | 'eviction' | null;
  settled: Promise<void>;
  settle: () => void;
}
function parseRetryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400_000, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date) || date < now - 1000) return 0;
  // HTTP-date has one-second precision. Add that precision window so a date
  // generated with fractional seconds is never honored too early.
  return Math.min(86_400_000, Math.max(0, date - now + 1000));
}
function isTransientNetworkError(value: unknown): boolean {
  const error = value as (Error & { code?: string; cause?: { code?: string } }) | null;
  return /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i.test(String(error?.code || error?.cause?.code || '')) ||
    /socket|terminated|connection reset|timed out|timeout|网络连接中断/i.test(error?.message || '');
}
function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('下载已取消'));
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolveDelay();
    }, Math.max(0, milliseconds));
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      rejectDelay(signal.reason instanceof Error ? signal.reason : new Error('下载已取消'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
function retryDelay(config: AdaptiveDownloadConfig, attempt: number): number {
  const base = Math.min(config.retryMaxMs, config.retryInitialMs * 2 ** Math.max(0, attempt));
  const jitter = base * config.retryJitterRatio;
  return Math.max(0, Math.round(base - jitter + Math.random() * jitter * 2));
}
function sumRanges(ranges: ByteRange[]): number {
  return ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
}

function makeLogicalSegments(totalBytes: number, segmentCount: number): ByteRange[] {
  if (totalBytes <= 0) return [];
  const count = Math.max(1, Math.min(segmentCount, totalBytes));
  // Keep the user-selected number of visible/base segments stable. BigInt
  // avoids rounding or overflow when splitting large files near safe limits.
  return Array.from({ length: count }, (_, index) => ({
    start: Number(BigInt(totalBytes) * BigInt(index) / BigInt(count)),
    end: Number(BigInt(totalBytes) * BigInt(index + 1) / BigInt(count)) - 1,
  }));
}

function overlapBytes(left: ByteRange, right: ByteRange): number {
  return Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start) + 1);
}
function validatorsMatch(record: ResumeRecord, inspection: HttpInspection): boolean {
  return record.etag === inspection.etag && record.lastModified === inspection.lastModified;
}
function legacyCompletedRanges(record: ResumeRecordV1, totalBytes: number): ByteRange[] {
  const ranges: ByteRange[] = [];
  for (const segment of record.segments || []) {
    const start = segment.rangeStart ?? 0;
    const received = Math.max(0, Math.floor(segment.downloadedBytes || 0));
    if (!received) continue;
    const end = Math.min(totalBytes - 1, start + received - 1);
    if (Number.isSafeInteger(start) && start >= 0 && end >= start) ranges.push({ start, end });
  }
  return ranges;
}
function completedFromRecord(record: ResumeRecord, totalBytes: number): ByteRange[] {
  return record.version === 2 ? record.completedRanges : legacyCompletedRanges(record, totalBytes);
}
async function writeSequential(
  file: Awaited<ReturnType<typeof open>>, chunk: Buffer, position: number,
): Promise<void> {
  let written = 0;
  while (written < chunk.length) {
    const result = await file.write(chunk, written, chunk.length - written, position + written);
    if (!result.bytesWritten) throw new Error('磁盘写入未取得进展');
    written += result.bytesWritten;
  }
}
async function copyRange(
  source: Awaited<ReturnType<typeof open>>,
  destination: Awaited<ReturnType<typeof open>>,
  sourceOffset: number,
  destinationOffset: number,
  count: number,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(SCRATCH_COPY_BYTES, Math.max(1, count)));
  let copied = 0;
  while (copied < count) {
    const read = await source.read(buffer, 0, Math.min(buffer.length, count - copied), sourceOffset + copied);
    if (!read.bytesRead) throw new Error('临时区间文件数据不完整');
    let written = 0;
    while (written < read.bytesRead) {
      const result = await destination.write(buffer, written, read.bytesRead - written, destinationOffset + copied + written);
      if (!result.bytesWritten) throw new Error('磁盘写入未取得进展');
      written += result.bytesWritten;
    }
    copied += read.bytesRead;
  }
}

async function downloadSequential(
  task: HttpTaskState & Partial<AddDownloadInput>,
  settings: HttpTransferSettings,
  config: AdaptiveDownloadConfig,
  inspection: HttpInspection,
  part: string,
  sidecar: string,
  signal: AbortSignal,
  onProgress: (progress: HttpProgress) => void,
  dispatcher: Dispatcher | undefined,
): Promise<void> {
  // With no stable byte ranges, a partial response cannot be resumed safely.
  await rm(sidecar, { force: true }).catch(() => undefined);
  const file = await open(part, 'w+');
  const throttleTask = createTokenBucket();
  const maximumRetries = Math.max(0, Math.min(20, Math.floor(settings.maxRetries) || 0));
  let downloadedBytes = 0;
  let retryCount = 0;
  let sampleBytes = 0;
  let sampleAt = Date.now();
  let speedBytesPerSecond = 0;
  let lastPublishAt = 0;
  const publish = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPublishAt < config.progressEmitIntervalMs) return;
    lastPublishAt = now;
    onProgress({
      totalBytes: inspection.totalBytes,
      downloadedBytes,
      segments: [{
        index: 0, downloadedBytes,
        totalBytes: inspection.totalBytes ?? downloadedBytes,
        rangeStart: 0,
        rangeEnd: inspection.totalBytes === null ? null : Math.max(0, inspection.totalBytes - 1),
        active: !signal.aborted,
      }],
      etag: inspection.etag, lastModified: inspection.lastModified,
      adaptive: {
        concurrency: 1, activeWorkers: signal.aborted ? 0 : 1,
        totalSpeedBytesPerSecond: speedBytesPerSecond, workerSpeeds: [{ workerId: 0, speedBytesPerSecond }],
        steals: 0, hedges: 0, evictions: 0, retries: retryCount,
      },
    });
  };

  try {
    for (let attempt = 0; attempt <= maximumRetries; attempt++) {
      if (signal.aborted) throw signal.reason || new Error('下载已暂停');
      downloadedBytes = 0;
      sampleBytes = 0; sampleAt = Date.now(); speedBytesPerSecond = 0;
      await file.truncate(0);
      if (inspection.totalBytes !== null) await file.truncate(inspection.totalBytes);
      let releaseConnection: (() => void) | null = null;
      try {
        releaseConnection = await httpConnections.acquireSlot(new URL(inspection.finalUrl).hostname, Math.max(1, settings.maxGlobalConnections || 64), config.maxConnectionsPerDomain, signal);
        const headers = makeHeaders(task, task.url);
        const response = await requestWithProxy(inspection.finalUrl, {
          headers, redirect: 'follow', signal: timeoutSignal(signal, settings.connectTimeoutSeconds),
        }, settings, dispatcher);
        if (!response.ok) {
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
          const error = responseError(response.status, inspection.finalUrl);
          await discard(response);
          releaseConnection();
          if ((error as Error & { retryable?: boolean }).retryable && attempt < maximumRetries) {
            retryCount++;
            await abortableDelay(Math.max(retryAfter, retryDelay(config, attempt)), signal);
            continue;
          }
          throw error;
        }
        const responseEtag = response.headers.get('etag');
        const responseModified = response.headers.get('last-modified');
        if ((inspection.etag && responseEtag && inspection.etag !== responseEtag) ||
            (inspection.lastModified && responseModified && inspection.lastModified !== responseModified)) {
          await discard(response);
          const changed = new Error('远端文件校验标识发生变化，准备重新下载');
          (changed as Error & { code?: string }).code = REMOTE_CHANGED;
          throw changed;
        }
        if (!response.body) throw new Error('HTTP 响应没有文件内容');
        const reader = response.body.getReader();
        let position = 0;
        try {
          while (true) {
            if (signal.aborted) throw signal.reason || new Error('下载已暂停');
            const item = await reader.read();
            if (item.done) break;
            const chunk = Buffer.from(item.value);
            if (inspection.totalBytes !== null && position + chunk.length > inspection.totalBytes) {
              throw new Error('服务器发送的数据超出文件大小');
            }
            await writeSequential(file, chunk, position);
            position += chunk.length;
            downloadedBytes = position;
            sampleBytes += chunk.length;
            const now = Date.now();
            if (now - sampleAt >= 250 || speedBytesPerSecond === 0) {
              const instant = sampleBytes * 1000 / Math.max(1, now - sampleAt);
              speedBytesPerSecond = speedBytesPerSecond === 0 ? instant : config.workerEwmaAlpha * instant + (1 - config.workerEwmaAlpha) * speedBytesPerSecond;
              sampleBytes = 0; sampleAt = now;
            }
            await throttleShared(settings.speedLimitBytesSec, chunk.length);
            await throttleTask(task.speedLimitBytesSec ?? 0, chunk.length);
            publish();
          }
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          throw error;
        } finally { reader.releaseLock(); }
        if (inspection.totalBytes !== null && position !== inspection.totalBytes) {
          throw new Error('网络连接中断，响应长度与文件大小不一致');
        }
        await file.truncate(position);
        await file.sync();
        publish(true);
        return;
      } catch (error) {
        releaseConnection?.();
        if ((error as Error & { code?: string })?.code === REMOTE_CHANGED || signal.aborted || attempt >= maximumRetries) throw error;
        if (!isTransientNetworkError(error) && !(error as Error & { retryable?: boolean })?.retryable) throw error;
        retryCount++;
        await abortableDelay(retryDelay(config, attempt), signal);
      } finally { releaseConnection?.(); }
    }
    throw new Error('普通下载重试次数已耗尽');
  } finally { await file.close(); }
}

async function downloadHttpTaskInternal(
  task: HttpTaskState & Partial<AddDownloadInput>,
  settings: HttpTransferSettings,
  signal: AbortSignal,
  onProgress: (progress: HttpProgress) => void,
  forceSingleConnection = false,
  beforeFinalize?: (partialPath: string) => Promise<void>,
  dispatcher?: Dispatcher,
  remoteRestarted = false,
): Promise<{ fileName: string; metadata: HttpInspection }> {
  const config = resolveAdaptiveDownloadConfig({
    ...(settings.adaptiveConfig || {}),
    ...(settings.debugAdaptive === undefined ? {} : { debug: settings.debugAdaptive }),
  });
  const inspection = await inspectHttpUrl(task, settings.connectTimeoutSeconds, signal, settings, dispatcher);
  const fileName = sanitizeDownloadFileName(task.fileName || inspection.fileName);
  const output = resolve(task.directory, fileName);
  if (await lstat(output).then(() => true, () => false)) throw new Error('目标文件已存在，请更改保存名称');
  const part = output + '.part';
  const sidecar = output + '.ldl';
  const scratchDirectory = part + '.chunks';
  await mkdir(dirname(output), { recursive: true });
  const oldPart = await lstat(part).catch(() => null);
  const oldSidecar = await lstat(sidecar).catch(() => null);
  if (oldPart && (oldPart.isSymbolicLink() || !oldPart.isFile())) throw new Error('临时下载文件不是普通文件');
  if (oldSidecar && (oldSidecar.isSymbolicLink() || !oldSidecar.isFile())) throw new Error('断点元数据不是普通文件');

  const ranged = inspection.supportsRanges && inspection.totalBytes !== null && !forceSingleConnection;
  if (!ranged) {
    try {
      await downloadSequential(task, settings, config, inspection, part, sidecar, signal, onProgress, dispatcher);
    } catch (error) {
      if ((error as Error & { code?: string })?.code === REMOTE_CHANGED && !remoteRestarted) {
        await rm(part, { force: true });
        await rm(sidecar, { force: true });
        await rm(scratchDirectory, { recursive: true, force: true });
        return downloadHttpTaskInternal(task, settings, signal, onProgress, false, beforeFinalize, dispatcher, true);
      }
      throw error;
    }
  } else {
    const totalBytes = inspection.totalBytes!;
    // The selected count defines the primary partitions and initial workers.
    // Keep the old boolean as a compatibility fallback for existing callers.
    const requestedConnections = settings.autoSegmentDownloads === false
      ? 1
      : normalizeDownloadSegmentCount(settings.segmentsPerDownload, 8);
    const globalLimit = Math.max(1, Math.min(256, Math.floor(settings.maxGlobalConnections || 64)));
    const domainLimit = config.maxConnectionsPerDomain;
    const configuredCeiling = Math.min(requestedConnections, config.maxConcurrency, domainLimit, globalLimit);
    const initialCeiling = totalBytes < config.smallFileThresholdBytes
      ? 1
      : Math.max(1, Math.min(configuredCeiling, Math.floor(totalBytes / config.minChunkBytes)));
    let restored: ByteRange[] = [];
    let resumable = false;

    // Validators are compared exactly below. When both probes lack ETag and
    // Last-Modified, URL + final URL + length still allow resuming servers
    // that support ranges but do not publish validators (common on CDNs).
    if (oldPart && oldSidecar) {
      try {
        const saved = JSON.parse(await readFile(sidecar, 'utf8')) as ResumeRecord;
        const validBase = saved && (saved.version === 1 || saved.version === 2) &&
          saved.url === task.url && saved.finalUrl === inspection.finalUrl &&
          saved.totalBytes === totalBytes && saved.supportsRanges === true &&
          validatorsMatch(saved, inspection) && (await stat(part)).size === totalBytes;
        if (validBase) {
          const schedulerValidation = new RangeScheduler(totalBytes, completedFromRecord(saved, totalBytes));
          restored = schedulerValidation.snapshot().done;
          resumable = true;
        }
      } catch { restored = []; resumable = false; }
    }

    const file = await open(part, resumable ? 'r+' : 'w+');
    if (!resumable) await file.truncate(totalBytes);
    await rm(scratchDirectory, { recursive: true, force: true });
    await mkdir(scratchDirectory, { recursive: true });
    const scheduler = new RangeScheduler(totalBytes, restored);
    scheduler.seedPending(initialCeiling);
    const logicalSegments = makeLogicalSegments(totalBytes, initialCeiling);
    const workerSpeeds = new Map<number, WorkerSpeedState>();
    const active = new Map<string, ActiveRange>();
    const maximumRetries = Math.max(0, Math.min(20, Math.floor(settings.maxRetries) || 0));
    let retries = 0;
    let totalSampleBytes = 0;
    let totalSampleAt = Date.now();
    let totalSpeedBytesPerSecond = 0;
    let steals = 0;
    let evictions = 0;
    let unsupportedRange = false;
    let remoteChanged = false;
    let lastPublishAt = 0;
    let saveChain: Promise<void> = Promise.resolve();
    let changeGeneration = 0;
    const changeWaiters = new Set<() => void>();
    const stopController = new AbortController();
    const poolSignal = AbortSignal.any([signal, stopController.signal]);
    let controller!: ConcurrencyController;

    const telemetry = (): HttpAdaptiveTelemetry => ({
      concurrency: controller.concurrency,
      activeWorkers: controller.activeWorkers,
      totalSpeedBytesPerSecond,
      workerSpeeds: controller.currentWorkerSpeeds,
      steals, hedges: 0, evictions, retries,
    });
    const notifyWork = () => {
      changeGeneration++;
      for (const wake of [...changeWaiters]) wake();
      changeWaiters.clear();
    };
    const waitForWork = async (observed: number): Promise<void> => {
      if (changeGeneration !== observed || scheduler.isComplete || poolSignal.aborted) return;
      await new Promise<void>(resolveWait => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          changeWaiters.delete(finish);
          poolSignal.removeEventListener('abort', finish);
          resolveWait();
        };
        const timer = setTimeout(finish, 200);
        changeWaiters.add(finish);
        poolSignal.addEventListener('abort', finish, { once: true });
      });
    };
    const writeSidecar = () => {
      const snapshot: ResumeRecordV2 = {
        version: 2, url: task.url, finalUrl: inspection.finalUrl, totalBytes,
        supportsRanges: true, etag: inspection.etag, lastModified: inspection.lastModified,
        completedRanges: scheduler.snapshot().done,
      };
      saveChain = saveChain.catch(() => undefined).then(async () => {
        await file.sync();
        await saveJson(sidecar, snapshot);
      });
      return saveChain;
    };
    const buildSegments = (): DownloadSegment[] => {
      const snapshot = scheduler.snapshot();
      return logicalSegments.map((range, index) => {
        let downloadedBytes = snapshot.done.reduce((sum, done) => sum + overlapBytes(range, done), 0);
        let active = false;
        for (const lease of snapshot.active) {
          if (lease.kind !== 'primary' || lease.start > range.end || lease.end < range.start) continue;
          active = true;
          if (lease.receivedBytes > 0) {
            downloadedBytes += overlapBytes(range, {
              start: lease.start,
              end: lease.start + lease.receivedBytes - 1,
            });
          }
        }
        return {
          index, downloadedBytes,
          totalBytes: range.end - range.start + 1,
          rangeStart: range.start, rangeEnd: range.end, active,
        };
      });
    };
    const publish = (force = false) => {
      const now = Date.now();
      if (!force && now - lastPublishAt < config.progressEmitIntervalMs) return;
      lastPublishAt = now;
      const snapshot = scheduler.snapshot();
      const downloadedBytes = sumRanges(snapshot.done) +
        snapshot.active.filter(lease => lease.kind === 'primary').reduce((sum, lease) => sum + lease.receivedBytes, 0);
      onProgress({
        totalBytes, downloadedBytes, segments: buildSegments(),
        etag: inspection.etag, lastModified: inspection.lastModified, adaptive: telemetry(),
      });
    };
    const writeEvent = (decision: ConcurrencyDecision) => {
      const event: HttpAdaptiveEvent = { ...decision, telemetry: telemetry() };
      if (config.debug) console.info('[LDownload HTTP adaptive]', JSON.stringify(event));
      try { settings.onAdaptiveEvent?.(event); } catch { /* Observability must not affect transfer. */ }
    };
    // The selected segment count is the initial parallelism, not a slow-start
    // target. Congestion responses may still back it off temporarily.
    controller = new ConcurrencyController({
      ...config, manualConcurrency: true, initialConcurrency: initialCeiling,
    }, initialCeiling, writeEvent);
    // Publish the stable logical layout immediately. This also replaces stale
    // per-lease progress from a paused task as soon as it is resumed.
    publish(true);
    const updateWorkerSpeed = (workerId: number, bytes: number): number => {
      const now = Date.now();
      let state = workerSpeeds.get(workerId);
      if (!state) {
        state = { ewma: 0, sampleBytes: 0, sampleAt: now };
        workerSpeeds.set(workerId, state);
      }
      state.sampleBytes += bytes;
      const elapsed = now - state.sampleAt;
      if (elapsed >= 250 || state.ewma === 0) {
        const instant = state.sampleBytes * 1000 / Math.max(1, elapsed);
        state.ewma = state.ewma === 0 ? instant : config.workerEwmaAlpha * instant + (1 - config.workerEwmaAlpha) * state.ewma;
        state.sampleBytes = 0;
        state.sampleAt = now;
        controller.reportWorkerSpeed(workerId, state.ewma);
      }
      return state.ewma;
    };
    const delayForRetry = async (attempt: number, leaseSignal: AbortSignal, status: number | null, retryAfterMs = 0, error?: unknown) => {
      retries++;
      const congested = status === 429 || status === 503 || status === 408 ||
        (status === null && isTransientNetworkError(error));
      if (congested) {
        const reason = status === 429 ? 'HTTP 429：服务器限流。'
          : status === 503 ? 'HTTP 503：服务暂不可用。'
          : status === 408 ? 'HTTP 408：请求超时。'
          : '连接重置或网络超时，减少并发并退避。';
        controller.onCongestion(reason, retryAfterMs);
        await controller.waitForCooldown(leaseSignal);
      }
      await abortableDelay(retryDelay(config, attempt), leaseSignal);
    };

    const runLease = async (lease: RangeLease, workerController: AbortController): Promise<void> => {
      const scratchPath = join(scratchDirectory, lease.id + '.chunk');
      const context: ActiveRange = {
        lease, controller: workerController, workerId: lease.workerId,
        scratchPath, scratch: null, copyFailed: false,
        rangeSpeed: 0, lastProgressAt: Date.now(), slowSinceAt: 0, yieldReason: null,
        settled: Promise.resolve(), settle: () => undefined,
      };
      context.settled = new Promise<void>(resolveSettled => { context.settle = resolveSettled; });
      active.set(lease.id, context);
      const leaseSignal = AbortSignal.any([poolSignal, workerController.signal]);
      const rangeLength = lease.end - lease.start + 1;
      const throttleTask = createTokenBucket();
      let localRetries = 0;
      let scratch: Awaited<ReturnType<typeof open>> | null = null;
      // Keep the range ETA separate from a worker's historical EWMA. A fast
      // worker can receive a slow next range; its old speed must not hide that
      // connection from tail stealing, hedging, or eviction decisions.
      let rangeSpeed = 0;
      let rangeSampleBytes = 0;
      let rangeSampleAt = Date.now();
      const updateRangeSpeed = (bytes: number): number => {
        rangeSampleBytes += bytes;
        const now = Date.now();
        if (now - rangeSampleAt >= 250 || rangeSpeed === 0) {
          const instant = rangeSampleBytes * 1000 / Math.max(1, now - rangeSampleAt);
          rangeSpeed = rangeSpeed === 0 ? instant
            : config.workerEwmaAlpha * instant + (1 - config.workerEwmaAlpha) * rangeSpeed;
          rangeSampleBytes = 0;
          rangeSampleAt = now;
        }
        context.rangeSpeed = rangeSpeed;
        context.lastProgressAt = now;
        return rangeSpeed;
      };

      const finishPartial = async (commitBytes: number, splitRemainder = false) => {
        if (scratch) {
          await scratch.sync().catch(() => undefined);
          if (lease.kind === 'primary' && commitBytes > 0) {
            try {
              await copyRange(scratch, file, 0, lease.start, commitBytes);
              await file.sync();
            } catch (error) {
              context.copyFailed = true;
              scheduler.finishPartial(lease.id, 0);
              active.delete(lease.id);
              await scratch.close().catch(() => undefined);
              await rm(scratchPath, { force: true }).catch(() => undefined);
              notifyWork();
              publish();
              throw error;
            }
          }
        }
        // A lease owns an exclusive interval. Only its contiguous received
        // prefix can be committed; the suffix is atomically returned to pending.
        const result = scheduler.finishPartial(lease.id, context.copyFailed ? 0 : commitBytes, splitRemainder);
        if (context.yieldReason === 'steal' && splitRemainder && result.requeued.length === 2) steals++;
        if (context.yieldReason === 'eviction') evictions++;
        active.delete(lease.id);
        scheduler.assertPartitionCoverage();
        if (scratch) await scratch.close().catch(() => undefined);
        await rm(scratchPath, { force: true }).catch(() => undefined);
        if (result.committedPrefix) await writeSidecar();
        notifyWork();
        publish();
      };

      try {
        scratch = await open(scratchPath, 'w+');
        context.scratch = scratch;
        while (lease.receivedBytes < rangeLength) {
          if (leaseSignal.aborted) throw leaseSignal.reason || new Error('下载已暂停');
          const offset = lease.start + lease.receivedBytes;
          const headers = makeHeaders(task, task.url);
          headers.set('range', 'bytes=' + offset + '-' + lease.end);
          const validator = inspection.etag || inspection.lastModified;
          if (validator) headers.set('if-range', validator);
          let releaseConnection: (() => void) | null = null;
          let response: UndiciResponse;
          try {
            releaseConnection = await httpConnections.acquireSlot(
              new URL(inspection.finalUrl).hostname, globalLimit, domainLimit, leaseSignal,
            );
            response = await requestWithProxy(inspection.finalUrl, {
              headers, redirect: 'follow', signal: timeoutSignal(leaseSignal, settings.connectTimeoutSeconds),
            }, settings, dispatcher);
          } catch (error) {
            releaseConnection?.();
            if (poolSignal.aborted || remoteChanged || unsupportedRange) throw error;
            if (workerController.signal.aborted) throw workerController.signal.reason || error;
            if (localRetries >= maximumRetries) throw error;
            await delayForRetry(localRetries++, leaseSignal, null, 0, error);
            continue;
          }

          const responseEtag = response.headers.get('etag');
          const responseModified = response.headers.get('last-modified');
          const changedValidator = (inspection.etag && responseEtag && inspection.etag !== responseEtag) ||
            (inspection.lastModified && responseModified && inspection.lastModified !== responseModified);
          if (changedValidator) {
            await discard(response);
            releaseConnection();
            remoteChanged = true;
            const changed = new Error('远端文件校验标识发生变化，放弃旧断点后重新下载');
            (changed as Error & { code?: string }).code = REMOTE_CHANGED;
            changed.message = '远端文件已变化，放弃旧断点后重新下载';
            for (const item of active.values()) if (item !== context) item.controller.abort(changed);
            throw changed;
          }
          if (response.status === 200) {
            await discard(response);
            releaseConnection();
            unsupportedRange = true;
            const unsupported = new Error('服务器在探测后停止支持 Range 请求');
            (unsupported as Error & { code?: string }).code = UNSUPPORTED_RANGES;
            for (const item of active.values()) if (item !== context) item.controller.abort(unsupported);
            throw unsupported;
          }
          if (response.status === 429 || response.status === 503 || response.status === 408 ||
              response.status < 200 || response.status >= 300) {
            const status = response.status;
            const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
            const error = responseError(status, inspection.finalUrl);
            await discard(response);
            releaseConnection();
            if ((error as Error & { retryable?: boolean }).retryable && localRetries < maximumRetries) {
              await delayForRetry(localRetries++, leaseSignal, status, retryAfterMs, error);
              continue;
            }
            if ([429, 503, 408].includes(status)) controller.onCongestion(error.message, retryAfterMs);
            throw error;
          }
          if (response.status !== 206) {
            await discard(response);
            releaseConnection();
            throw responseError(response.status, inspection.finalUrl);
          }
          const contentRange = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '');
          if (!contentRange || Number(contentRange[1]) !== offset ||
              Number(contentRange[2]) < offset || Number(contentRange[2]) > lease.end ||
              Number(contentRange[3]) !== totalBytes) {
            await discard(response);
            releaseConnection();
            throw new Error('服务器返回的 Content-Range 与请求不匹配');
          }
          if (!response.body) {
            releaseConnection();
            throw new Error('HTTP 响应没有文件内容');
          }

          const responseEnd = Number(contentRange[2]);
          const expectedBodyBytes = responseEnd - offset + 1;
          const reader = response.body.getReader();
          let responseReceived = 0;
          try {
            while (true) {
              if (leaseSignal.aborted) throw leaseSignal.reason || new Error('下载已暂停');
              const item = await reader.read();
              if (item.done) break;
              const chunk = Buffer.from(item.value);
              if (responseReceived + chunk.length > expectedBodyBytes ||
                  lease.receivedBytes + chunk.length > rangeLength) {
                throw new Error('服务器发送的数据超出 Range 范围');
              }
              await writeSequential(scratch, chunk, lease.receivedBytes);
              lease.receivedBytes += chunk.length;
              responseReceived += chunk.length;
              updateWorkerSpeed(lease.workerId, chunk.length);
              totalSampleBytes += chunk.length;
              scheduler.updateProgress(lease.id, lease.receivedBytes, updateRangeSpeed(chunk.length));
              await throttleShared(settings.speedLimitBytesSec, chunk.length);
              await throttleTask(task.speedLimitBytesSec ?? 0, chunk.length);
              publish();
              notifyWork();
            }
          } catch (error) {
            await reader.cancel().catch(() => undefined);
            if (poolSignal.aborted) throw error;
            if (workerController.signal.aborted) throw workerController.signal.reason || error;
            if (localRetries >= maximumRetries || !isTransientNetworkError(error)) throw error;
            await delayForRetry(localRetries++, leaseSignal, null, 0, error);
            continue;
          } finally {
            reader.releaseLock();
            releaseConnection();
          }
          if (responseReceived !== expectedBodyBytes) {
            const interrupted = new Error('网络连接中断，Range 响应长度不完整');
            (interrupted as Error & { code?: string }).code = 'UND_ERR_SOCKET';
            if (localRetries >= maximumRetries) throw interrupted;
            await delayForRetry(localRetries++, leaseSignal, null, 0, interrupted);
            continue;
          }
          localRetries = 0;
        }

        await scratch.sync();
        if (!scheduler.beginCommit(lease.id)) throw new Error('下载区间提交权已被其他 worker 占用');
        try {
          await copyRange(scratch, file, 0, lease.start, rangeLength);
          await file.sync();
          scheduler.complete(lease.id);
          scheduler.assertPartitionCoverage();
        } catch (error) {
          scheduler.cancelCommit(lease.id);
          context.copyFailed = true;
          throw error;
        }
        active.delete(lease.id);
        await scratch.close();
        await rm(scratchPath, { force: true }).catch(() => undefined);
        notifyWork();
        publish();
        await writeSidecar();
      } catch (error) {
        const yieldedForHelp = context.yieldReason !== null && workerController.signal.aborted && !poolSignal.aborted;
        const preservePrefix = !context.copyFailed && lease.kind === 'primary' && lease.receivedBytes > 0;
        if (active.has(lease.id)) {
          const remainingBytes = rangeLength - (preservePrefix ? lease.receivedBytes : 0);
          const splitRemainder = yieldedForHelp && remainingBytes >= config.minChunkBytes * 2;
          await finishPartial(preservePrefix ? lease.receivedBytes : 0, splitRemainder);
        }
        if (yieldedForHelp && !context.copyFailed) return;
        if (!poolSignal.aborted) throw error;
        if (signal.aborted) throw signal.reason || error;
        if (poolSignal.aborted && !remoteChanged && !unsupportedRange) throw poolSignal.reason || error;
      } finally {
        if (active.has(lease.id)) active.delete(lease.id);
        if (scratch) await scratch.close().catch(() => undefined);
        context.settle();
      }
    };

    const requestYield = async (context: ActiveRange, reason: 'steal' | 'eviction'): Promise<void> => {
      context.yieldReason = reason;
      const error = new Error(reason === 'steal' ? '区间已拆分给空闲连接' : '慢连接已淘汰并回收剩余区间');
      (error as Error & { code?: string }).code = reason === 'steal' ? 'HTTP_RANGE_YIELDED' : 'HTTP_RANGE_EVICTED';
      context.controller.abort(error);
      await context.settled;
    };

    const askIdleWorkerToHelp = async (): Promise<boolean> => {
      const now = Date.now();
      const candidates = [...active.values()]
        .filter(context => context.yieldReason === null && !context.copyFailed)
        .map(context => {
          const remainingBytes = context.lease.end - context.lease.start + 1 - context.lease.receivedBytes;
          const stalledFor = now - context.lastProgressAt;
          const estimatedSeconds = context.rangeSpeed > 0
            ? remainingBytes / context.rangeSpeed
            : stalledFor >= config.slowWorkerDurationMs ? Number.POSITIVE_INFINITY : 0;
          return { context, remainingBytes, estimatedSeconds };
        })
        .filter(candidate => candidate.remainingBytes >= config.minChunkBytes * 2 &&
          candidate.estimatedSeconds > config.tailConnectionOverheadSeconds)
        .sort((left, right) => right.estimatedSeconds - left.estimatedSeconds || right.remainingBytes - left.remainingBytes);
      const candidate = candidates[0];
      if (!candidate) return false;

      // Stop one lease at a safe point. runLease commits only its received
      // prefix, then the scheduler atomically returns the two disjoint halves
      // of the suffix. The original worker and helper race only to claim those
      // separate halves; neither can write bytes owned by the other.
      await requestYield(candidate.context, 'steal');
      if (!scheduler.pendingCount) return false;
      const event: HttpAdaptiveEvent = {
        type: 'steal',
        reason: '空闲连接帮助预计剩余时间最长的区间，未完成部分已二分转交。',
        timestamp: Date.now(), concurrency: controller.concurrency,
        activeWorkers: controller.activeWorkers,
        totalSpeedBytesPerSecond,
        telemetry: telemetry(),
      };
      if (config.debug) console.info('[LDownload HTTP adaptive]', JSON.stringify(event));
      try { settings.onAdaptiveEvent?.(event); } catch { /* Observability must not affect transfer. */ }
      return true;
    };

    const evictSlowWorker = async (): Promise<boolean> => {
      const candidate = [...active.values()]
        .filter(context => context.yieldReason === null && context.slowSinceAt > 0 && !context.copyFailed)
        .sort((left, right) => left.rangeSpeed - right.rangeSpeed)[0];
      if (!candidate) return false;
      const previousEvictions = evictions;
      await requestYield(candidate, 'eviction');
      if (evictions === previousEvictions) return false;
      const event: HttpAdaptiveEvent = {
        type: 'evict', reason: '连接持续低于活跃连接速度中位数，已断开并回收未完成区间。',
        timestamp: Date.now(), concurrency: controller.concurrency,
        activeWorkers: controller.activeWorkers, totalSpeedBytesPerSecond, telemetry: telemetry(),
      };
      if (config.debug) console.info('[LDownload HTTP adaptive]', JSON.stringify(event));
      try { settings.onAdaptiveEvent?.(event); } catch { /* Observability must not affect transfer. */ }
      return scheduler.pendingCount > 0;
    };

    const sampleTimer = setInterval(() => {
      // Smooth aggregate throughput for telemetry and congestion recovery.
      const now = Date.now();
      const elapsed = Math.max(1, now - totalSampleAt);
      const instant = totalSampleBytes * 1000 / elapsed;
      totalSampleBytes = 0;
      totalSampleAt = now;
      totalSpeedBytesPerSecond = totalSpeedBytesPerSecond === 0
        ? instant
        : config.throughputEwmaAlpha * instant + (1 - config.throughputEwmaAlpha) * totalSpeedBytesPerSecond;
      const remainingCeiling = Math.max(1, Math.floor(scheduler.remainingBytes / config.minChunkBytes));
      controller.setCeiling(Math.min(configuredCeiling, remainingCeiling), now);
      const activeSpeeds = [...active.values()].map(context => context.rangeSpeed).filter(speed => speed > 0).sort((a, b) => a - b);
      const middle = Math.floor(activeSpeeds.length / 2);
      const medianSpeed = activeSpeeds.length === 0 ? 0 : activeSpeeds.length % 2
        ? activeSpeeds[middle]!
        : (activeSpeeds[middle - 1]! + activeSpeeds[middle]!) / 2;
      for (const context of active.values()) {
        const slow = medianSpeed > 0 && context.rangeSpeed > 0 &&
          context.rangeSpeed < medianSpeed * config.slowWorkerRatio;
        if (slow) context.slowSinceAt ||= now;
        else if (now - context.lastProgressAt < config.slowWorkerDurationMs) context.slowSinceAt = 0;
        if (!slow && now - context.lastProgressAt >= config.slowWorkerDurationMs) {
          context.slowSinceAt ||= context.lastProgressAt + config.slowWorkerDurationMs;
        }
      }
      controller.observeThroughput(totalSpeedBytesPerSecond, now);
      controller.recoverManualConcurrency(now);
      publish();
    }, config.sampleIntervalMs);
    const checkpointTimer = setInterval(() => { void writeSidecar().catch(() => undefined); }, config.checkpointIntervalMs);

    const workerLoop = async (workerId: number): Promise<void> => {
      while (true) {
        const releaseSlot = await controller.acquire(poolSignal);
        let released = false;
        const release = () => { if (!released) { released = true; releaseSlot(); } };
        try {
          if (poolSignal.aborted) throw poolSignal.reason || new Error('下载已暂停');
          if (scheduler.isComplete && scheduler.activeCount === 0) return;
          // Claim a complete seeded range. Tiny EWMA-sized leases fragment the
          // visible segments, add request overhead, and defeat the configured
          // fixed partition count. A finished worker joins the slowest range
          // by yielding and splitting only its uncommitted suffix below.
          const chunkBytes = totalBytes;
          const evictedSlowWorker = await evictSlowWorker();
          let lease = scheduler.claim(workerId, chunkBytes, Date.now());
          if (!lease && !scheduler.isComplete) {
            const stoleWork = evictedSlowWorker || await askIdleWorkerToHelp();
            if (stoleWork) lease = scheduler.claim(workerId, chunkBytes, Date.now());
          }
          if (lease) {
            const workerController = new AbortController();
            notifyWork();
            await runLease(lease, workerController);
            continue;
          }

          const observed = changeGeneration;
          if (scheduler.isComplete && scheduler.activeCount === 0) return;
          release();
          await waitForWork(observed);
        } finally { release(); }
      }
    };

    const waiterWaker = () => { for (const wake of [...changeWaiters]) wake(); };
    const cancellationWake = () => waiterWaker();
    poolSignal.addEventListener('abort', cancellationWake, { once: true });
    const poolSize = initialCeiling;
    const workers = Array.from({ length: poolSize }, (_, index) => workerLoop(index));
    try {
      await Promise.all(workers);
      if (!scheduler.isComplete) throw new Error('下载队列已结束但仍有未完成区间');
      scheduler.assertCompleteCoverage();
      await file.sync();
      await writeSidecar();
    } catch (error) {
      if (!poolSignal.aborted) stopController.abort(error);
      for (const context of active.values()) context.controller.abort(error);
      notifyWork();
      await Promise.allSettled(workers);
      await file.sync().catch(() => undefined);
      await writeSidecar().catch(() => undefined);
      if (unsupportedRange && !signal.aborted) {
        await file.close();
        await rm(part, { force: true });
        await rm(sidecar, { force: true });
        await rm(scratchDirectory, { recursive: true, force: true });
        return downloadHttpTaskInternal(task, settings, signal, onProgress, true, beforeFinalize, dispatcher, remoteRestarted);
      }
      if (remoteChanged && !signal.aborted && !remoteRestarted) {
        await file.close();
        await rm(part, { force: true });
        await rm(sidecar, { force: true });
        await rm(scratchDirectory, { recursive: true, force: true });
        return downloadHttpTaskInternal(task, settings, signal, onProgress, false, beforeFinalize, dispatcher, true);
      }
      throw error;
    } finally {
      clearInterval(sampleTimer);
      clearInterval(checkpointTimer);
      poolSignal.removeEventListener('abort', cancellationWake);
      waiterWaker();
      changeWaiters.clear();
      await file.close().catch(() => undefined);
    }
  }

  if (task.expectedChecksum) {
    const algorithm = task.checksumAlgorithm || 'sha256';
    validateHash(algorithm, task.expectedChecksum);
    if ((await fileHash(part, algorithm)).toLowerCase() !== task.expectedChecksum.toLowerCase()) {
      await rm(part, { force: true });
      await rm(sidecar, { force: true });
      throw new Error('文件校验失败：下载内容的校验值与预期不一致');
    }
  }
  if (beforeFinalize) await beforeFinalize(part);
  if (await lstat(output).then(() => true, () => false)) throw new Error('目标文件已存在，请更改保存名称');
  await rename(part, output);
  await rm(sidecar, { force: true }).catch(() => undefined);
  await rm(part + '.chunks', { recursive: true, force: true }).catch(() => undefined);
  return { fileName, metadata: inspection };
}

export async function downloadHttpTask(
  task: HttpTaskState & Partial<AddDownloadInput>,
  settings: HttpTransferSettings,
  signal: AbortSignal,
  onProgress: (progress: HttpProgress) => void,
  forceSingleConnection = false,
  beforeFinalize?: (partialPath: string) => Promise<void>,
): Promise<{ fileName: string; metadata: HttpInspection }> {
  const dispatcher = createProxyDispatcher(settings);
  try {
    return await downloadHttpTaskInternal(task, settings, signal, onProgress, forceSingleConnection, beforeFinalize, dispatcher);
  } finally { if (dispatcher) await dispatcher.close().catch(() => undefined); }
}
