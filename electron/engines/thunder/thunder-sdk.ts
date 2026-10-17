import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { ThunderBridgeSession } from './thunder-session.ts';
import { parseThunderTorrent, type ThunderTorrentMetadata } from './torrent-metadata.ts';

const SDK_VERSION = '2.86.202.143';
const EXPECTED_HASHES = new Map([
  ['DownloadSDKProxy.dll', '8de0b2befdb8e439da90b39aee99b5576db2f74c26a1a23774207c9f6658fa19'],
  ['DownloadSDK.dll', 'e055afbca6dbb413e6db180507f0a3e6536f39008da38a3d761ef4168fa264c9'],
]);

export interface ThunderTaskProgress { totalBytes: number; downloadedBytes: number; speedBytesSec: number; phase: string }
export interface ThunderBridgeOptions { bundledSdkDirectory: string; stateDirectory: string; bridgeExecutable: string }
export interface MagnetIdentity { infoHash: string }
export interface ThunderTaskInput {
  id: string;
  infoHash: string;
  directory: string;
  fileName: string;
  torrentFilePath: string;
  selectedFileIndices: number[] | null;
  bundledSdkDirectory?: string | null;
  status?: string;
}

export function parseMagnetIdentity(magnet: string): MagnetIdentity {
  if (magnet.length > 8192) throw new Error('磁力链接超过 8 KiB');
  let parsed: URL;
  try { parsed = new URL(magnet); } catch { throw new Error('磁力链接格式无效'); }
  if (parsed.protocol.toLowerCase() !== 'magnet:') throw new Error('只接受 magnet: 链接');
  const topics = parsed.searchParams.getAll('xt');
  for (const topic of topics) {
    const match = /^urn:btih:(.+)$/i.exec(topic.trim());
    if (!match) continue;
    const value = match[1];
    if (!value) continue;
    if (/^[a-f0-9]{40}$/i.test(value)) return { infoHash: value.toLowerCase() };
    if (/^[a-z2-7]{32}$/i.test(value)) return { infoHash: decodeBase32(value) };
  }
  throw new Error('磁力链接没有有效的 BTIH 标识');
}

function decodeBase32(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let accumulator = 0, bits = 0;
  const output: number[] = [];
  for (const char of value.toUpperCase()) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('磁力链接的 BTIH 编码无效');
    accumulator = (accumulator << 5) | digit; bits += 5;
    if (bits >= 8) { bits -= 8; output.push((accumulator >> bits) & 0xff); }
  }
  if (output.length !== 20) throw new Error('磁力链接的 BTIH 长度无效');
  return Buffer.from(output).toString('hex');
}

function isInside(parent: string, child: string): boolean {
  const relative = resolve(child).slice(resolve(parent).length);
  return relative === '' || (relative.startsWith(sep) && !relative.startsWith(`${sep}..${sep}`));
}

async function hashFile(path: string): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); }
  catch { return null; }
}

export function sdkCandidates(bundledSdkDirectory: string): string[] {
  const root = bundledSdkDirectory.trim();
  if (!root || basename(root).toLowerCase() !== 'sdk') return [];
  return [resolve(root)];
}
export async function findVerifiedSdkDirectory(bundledSdkDirectory: string): Promise<string | null> {
  for (const candidate of sdkCandidates(bundledSdkDirectory)) {
    const hashes = await Promise.all([...EXPECTED_HASHES].map(async ([name, expected]) => (await hashFile(join(candidate, name))) === expected));
    if (hashes.every(Boolean) && await lstat(join(candidate, 'DownloadSDKServer.exe')).then(info => info.isFile(), () => false)) return candidate;
  }
  return null;
}

type DownloadSlotWaiter = { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: Error) => void; onAbort: () => void };

class DownloadConcurrencyLimiter {
  private active = 0;
  private readonly waiting: DownloadSlotWaiter[] = [];
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new DOMException('迅雷任务已暂停', 'AbortError'));
    if (this.active < this.limit) { this.active++; return Promise.resolve(this.releaseOnce()); }
    return new Promise((resolve, reject) => {
      const waiter: DownloadSlotWaiter = { signal, resolve, reject, onAbort: () => undefined };
      waiter.onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        signal.removeEventListener('abort', waiter.onAbort);
        reject(new DOMException('迅雷任务已暂停', 'AbortError'));
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort(); else this.waiting.push(waiter);
    });
  }
  private releaseOnce(): () => void {
    let released = false;
    return () => { if (!released) { released = true; this.release(); } };
  }
  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.waiting.length) {
      const waiter = this.waiting.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) { waiter.reject(new DOMException('迅雷任务已暂停', 'AbortError')); continue; }
      this.active++;
      waiter.resolve(this.releaseOnce());
      return;
    }
  }
}

async function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException('迅雷任务已暂停', 'AbortError');
  let remove: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new DOMException('迅雷任务已暂停', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    remove = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { remove?.(); }
}
export class ThunderSdkEngine {
  private readonly downloadLimiter = new DownloadConcurrencyLimiter(3);
  private session: ThunderBridgeSession | null = null;
  private sessionPromise: Promise<ThunderBridgeSession> | null = null;
  private sessionClosing: Promise<void> | null = null;
  private sessionIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: ThunderBridgeOptions;
  private readonly metainfoDirectory: string;
  private readonly runtimeDirectory: string;

  constructor(options: ThunderBridgeOptions) {
    this.options = options;
    this.metainfoDirectory = join(options.stateDirectory, 'metainfo');
    this.runtimeDirectory = join(options.stateDirectory, 'thunder-runtime');
  }

  async dispose(): Promise<void> {
    if (this.sessionIdleTimer) { clearTimeout(this.sessionIdleTimer); this.sessionIdleTimer = null; }
    if (this.sessionClosing) await this.sessionClosing.catch(() => undefined);
    const session = this.session;
    if (!session) return;
    const closing = session.close();
    this.sessionClosing = closing;
    try { await closing; }
    finally {
      if (this.session === session) { this.session = null; this.sessionPromise = null; }
      if (this.sessionClosing === closing) this.sessionClosing = null;
    }
  }
  async selfTest(signal: AbortSignal): Promise<void> {
    const session = await this.ensureBridgeSession(signal);
    this.scheduleBridgeClose(session);
  }
  async inspectMagnet(magnet: string, signal: AbortSignal): Promise<ThunderTorrentMetadata> {
    const identity = parseMagnetIdentity(magnet);
    const cachedPath = join(this.metainfoDirectory, identity.infoHash + '.torrent');
    const cached = await this.readAndVerifyTorrent(cachedPath, identity.infoHash).catch(() => null);
    if (cached) return cached;
    const session = await this.ensureBridgeSession(signal);
    const parent = join(this.options.stateDirectory, 'resolve');
    await this.ensureStateSubdirectory(parent);
    const workspace = join(parent, randomUUID());
    await mkdir(workspace, { recursive: false });
    const torrentPath = join(workspace, 'metadata.torrent');
    try {
      await session.runTask({
        taskId: randomUUID(), operation: 'resolve', magnet, torrentPath,
        saveDirectory: null, selection: null, timeoutSeconds: 600,
      }, signal);
      const torrent = await readFile(torrentPath);
      const metadata = parseThunderTorrent(torrent);
      if (metadata.infoHash !== identity.infoHash) throw new Error('迅雷返回的种子元数据与磁力链接的 BTIH 不一致');
      await this.saveMetainfo(identity.infoHash, torrent);
      return metadata;
    } finally {
      await this.removeOwnedWorkspace(workspace).catch(() => undefined);
      this.scheduleBridgeClose(session);
    }
  }
  async inspectTorrentFile(torrentPath: string): Promise<{ metadata: ThunderTorrentMetadata; torrentFilePath: string }> {
    if (extname(torrentPath).toLowerCase() !== '.torrent') throw new Error('请选择 .torrent 种子文件');
    const file = await lstat(torrentPath);
    if (!file.isFile() || file.isSymbolicLink() || file.size > 16 * 1024 * 1024) throw new Error('种子文件不是安全的普通文件或超过 16 MiB');
    const torrent = await readFile(torrentPath);
    const metadata = parseThunderTorrent(torrent);
    return { metadata, torrentFilePath: await this.saveMetainfo(metadata.infoHash, torrent) };
  }

  async loadTorrentFile(torrentPath: string, infoHash: string): Promise<ThunderTorrentMetadata> {
    return this.readAndVerifyTorrent(torrentPath, infoHash);
  }

  async retainSelectedFiles(task: ThunderTaskInput, selectedFileIndices: number[]): Promise<void> {
    const metadata = await this.loadTorrentFile(task.torrentFilePath, task.infoHash);
    const selected = new Set(selectedFileIndices);
    if (!selected.size || selected.size !== selectedFileIndices.length || [...selected].some(index => !Number.isInteger(index) || index < 0 || index >= metadata.files.length)) {
      throw new Error('磁力文件选择无效');
    }
    const stageDirectory = join(resolve(task.directory), `.ldownload-${task.id}-partial`);
    const stageInfo = await lstat(stageDirectory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!stageInfo) return;
    if (stageInfo.isSymbolicLink() || !stageInfo.isDirectory() || await readFile(join(stageDirectory, '.ldownload-owner'), 'utf8').catch(() => '') !== task.id) {
      throw new Error('迅雷临时下载目录未通过所有权校验');
    }
    await this.assertNoLinks(stageDirectory);
    const root = resolve(stageDirectory);
    const emptyDirectories = new Set<string>();
    for (const file of metadata.files) {
      if (selected.has(file.index)) continue;
      const components = metadata.isMultiFile ? [metadata.name, ...file.components] : file.components;
      let current = root;
      let missing = false;
      for (let index = 0; index < components.length; index++) {
        const component = components[index];
        if (!component) throw new Error('种子文件路径为空');
        current = join(current, component);
        if (!isInside(root, current)) throw new Error('种子文件路径超出迅雷临时目录');
        const details = await lstat(current).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (!details) { missing = true; break; }
        if (details.isSymbolicLink()) throw new Error('迅雷临时目录包含链接，保留现有文件');
        if (index < components.length - 1) {
          if (!details.isDirectory()) throw new Error('迅雷临时文件路径不是普通目录');
          emptyDirectories.add(current);
        } else {
          if (!details.isFile()) throw new Error('迅雷临时文件不是普通文件');
          await rm(current, { force: false });
        }
      }
      if (missing) continue;
    }
    for (const directory of [...emptyDirectories].sort((left, right) => right.length - left.length)) {
      try { await rmdir(directory); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error;
      }
    }
  }
  async removeTaskFiles(task: ThunderTaskInput, deleteFiles: boolean): Promise<void> {
    const statePath = join(this.options.stateDirectory, 'thunder-tasks', task.id);
    const owner = await readFile(join(statePath, 'owner'), 'utf8').catch(() => '');
    if (owner && owner !== task.id) throw new Error('Thunder task workspace owner mismatch');
    if (deleteFiles) {
      const stage = join(resolve(task.directory), `.ldownload-${task.id}-partial`);
      const stageInfo = await lstat(stage).catch(() => null);
      if (stageInfo) {
        if (stageInfo.isSymbolicLink() || !stageInfo.isDirectory() || await readFile(join(stage, '.ldownload-owner'), 'utf8').catch(() => '') !== task.id) {
          throw new Error('Refusing to remove a partial folder without a matching task ownership marker');
        }
        await this.assertNoLinks(stage);
        await rm(stage, { recursive: true, force: false });
      }
      if (task.status === 'completed') await this.removeCompletedFiles(task);
    }
    if (owner === task.id) await this.removeOwnedWorkspace(statePath);
  }

  async download(
    task: ThunderTaskInput,
    signal: AbortSignal,
    onProgress: (progress: ThunderTaskProgress) => void,
    beforeFinalize?: (files: string[]) => Promise<void>,
  ): Promise<{ metadata: ThunderTorrentMetadata; selectedBytes: number; outputPath: string }> {
    const releaseSlot = await this.downloadLimiter.acquire(signal);
    let session: ThunderBridgeSession | null = null;
    try {
      const metadata = await this.loadTorrentFile(task.torrentFilePath, task.infoHash);
      const indices = task.selectedFileIndices ?? metadata.files.map(file => file.index);
      if (!indices.length || new Set(indices).size !== indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= metadata.files.length)) {
        throw new Error('磁力文件选择无效');
      }
      const selected = new Set(indices);
      const mask = metadata.files.map(file => selected.has(file.index) ? '1' : '0').join('');
      const selectedBytes = metadata.files.reduce((sum, file) => sum + (selected.has(file.index) ? file.size : 0), 0);
      const workspace = join(this.options.stateDirectory, 'thunder-tasks', task.id);
      await this.prepareTaskWorkspace(workspace, task.id, await readFile(task.torrentFilePath));
      const destinationRoot = resolve(task.directory);
      await mkdir(destinationRoot, { recursive: true });
      const stageDirectory = join(destinationRoot, '.ldownload-' + task.id + '-partial');
      const outputPath = join(destinationRoot, task.fileName);
      if (!isInside(destinationRoot, stageDirectory) || !isInside(destinationRoot, outputPath)) throw new Error('下载路径超出选择的目标文件夹');
      if (await lstat(outputPath).then(() => true, () => false)) throw new Error('目标文件夹已存在；请先移动或重命名它');
      await this.prepareStage(stageDirectory, task.id);
      session = await this.ensureBridgeSession(signal);
      await session.runTask({
        taskId: task.id, operation: 'download', magnet: null,
        torrentPath: join(workspace, 'metadata.torrent'), saveDirectory: stageDirectory,
        selection: mask, timeoutSeconds: 0,
      }, signal, event => {
        const downloadedBytes = Math.max(0, Number(event.downloaded) || 0);
        const speedBytesSec = Math.max(0, Number(event.speed) || 0);
        onProgress({ totalBytes: selectedBytes, downloadedBytes, speedBytesSec, phase: 'downloading' });
      });
      const selectedPaths = await this.validateDownloadedFiles(stageDirectory, metadata, selected);
      await beforeFinalize?.(selectedPaths);
      await rm(join(stageDirectory, '.ldownload-owner'), { force: true });
      await rename(stageDirectory, outputPath);
      return { metadata, selectedBytes, outputPath };
    } finally {
      releaseSlot();
      if (session) this.scheduleBridgeClose(session);
    }
  }

  private async ensureBridgeSession(signal: AbortSignal): Promise<ThunderBridgeSession> {
    if (this.sessionIdleTimer) { clearTimeout(this.sessionIdleTimer); this.sessionIdleTimer = null; }
    if (this.sessionClosing) {
      await waitForSignal(this.sessionClosing, signal);
      return this.ensureBridgeSession(signal);
    }
    if (this.session && !this.session.isRunning) {
      this.session = null;
      this.sessionPromise = null;
    }
    if (!this.sessionPromise) {
      const starting = this.createBridgeSession();
      this.sessionPromise = starting;
      starting.catch(() => {
        if (this.sessionPromise === starting) {
          this.sessionPromise = null;
          this.session = null;
        }
      });
    }
    const session = await waitForSignal(this.sessionPromise, signal);
    if (!session.isRunning) {
      if (this.session === session) { this.session = null; this.sessionPromise = null; }
      return this.ensureBridgeSession(signal);
    }
    return session;
  }

  private async createBridgeSession(): Promise<ThunderBridgeSession> {
    const sdkDirectory = await this.prepareRuntime();
    const session = new ThunderBridgeSession();
    this.session = session;
    try {
      await session.start(this.options.bridgeExecutable, sdkDirectory, sdkDirectory, new AbortController().signal);
      return session;
    } catch (error) {
      if (this.session === session) this.session = null;
      throw error;
    }
  }

  private scheduleBridgeClose(session: ThunderBridgeSession): void {
    if (this.sessionIdleTimer) clearTimeout(this.sessionIdleTimer);
    this.sessionIdleTimer = setTimeout(() => {
      this.sessionIdleTimer = null;
      if (this.session !== session || session.activeTaskCount > 0 || this.sessionClosing) return;
      let closing: Promise<void>;
      closing = session.close().finally(() => {
        if (this.session === session) {
          this.session = null;
          this.sessionPromise = null;
        }
        if (this.sessionClosing === closing) this.sessionClosing = null;
      });
      this.sessionClosing = closing;
    }, 10_000);
  }
  private async prepareRuntime(): Promise<string> {
    const sourceDirectory = this.options.bundledSdkDirectory.trim();
    if (!sourceDirectory) throw new Error('没有配置随应用打包的迅雷 SDK');
    const source = await findVerifiedSdkDirectory(sourceDirectory);
    if (!source) throw new Error('未找到校验通过的随包迅雷 SDK：' + sourceDirectory);
    const fingerprint = [...EXPECTED_HASHES.values()].join('').slice(0, 20);
    const runtime = join(this.runtimeDirectory, `${SDK_VERSION}-${fingerprint}`);
    const markerPath = join(runtime, '.ldownload-sdk-version');
    if (await readFile(markerPath, 'utf8').then(value => value === SDK_VERSION, () => false)) return runtime;
    if (await lstat(runtime).then(info => info.isSymbolicLink() || !info.isDirectory(), () => false)) {
      throw new Error('迅雷运行时缓存路径不是普通目录');
    }
    const runtimeRootInfo = await lstat(this.runtimeDirectory).catch(() => null);
    if (runtimeRootInfo?.isSymbolicLink() || (runtimeRootInfo && !runtimeRootInfo.isDirectory())) throw new Error('迅雷运行时缓存根目录不是普通目录');
    await mkdir(this.runtimeDirectory, { recursive: true });
    const staging = join(this.runtimeDirectory, `.prepare-${randomUUID()}`);
    await mkdir(staging, { recursive: false });
    try {
      const entries = await readdir(source, { withFileTypes: true });
      for (const entry of entries) {
        const from = join(source, entry.name);
        const to = join(staging, entry.name);
        const details = await lstat(from);
        if (details.isSymbolicLink()) throw new Error(`迅雷 SDK 目录包含链接：${entry.name}`);
        if (details.isFile() && ['.dll', '.exe', '.manifest', '.cfg', '.xml'].includes(extname(entry.name).toLowerCase())) {
          await copyFile(from, to);
        } else if (details.isDirectory() && entry.name.toLowerCase() === 'xar') {
          await this.copySdkDirectory(from, to);
        }
      }
      for (const [name, expected] of EXPECTED_HASHES) {
        if (await hashFile(join(staging, name)) !== expected) throw new Error(`复制后的迅雷 SDK 文件校验失败：${name}`);
      }
      if (!await lstat(join(staging, 'DownloadSDKServer.exe')).then(info => info.isFile(), () => false)) throw new Error('迅雷 SDK 缺少 DownloadSDKServer.exe');
      await writeFile(join(staging, '.ldownload-sdk-version'), SDK_VERSION, { encoding: 'utf8', flag: 'wx' });
      await mkdir(this.runtimeDirectory, { recursive: true });
      if (await lstat(runtime).then(() => true, () => false)) {
        const existingVersion = await readFile(markerPath, 'utf8').catch(() => '');
        if (existingVersion !== SDK_VERSION) throw new Error('迅雷 SDK 缓存已存在但无法验证；为保护本地文件，未覆盖它');
        await this.removeOwnedWorkspace(staging);
      } else await rename(staging, runtime);
      return runtime;
    } catch (error) {
      await this.removeOwnedWorkspace(staging).catch(() => undefined);
      throw error;
    }
  }

  private async copySdkDirectory(source: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: false });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = join(source, entry.name), to = join(destination, entry.name);
      const details = await lstat(from);
      if (details.isSymbolicLink()) throw new Error('迅雷 SDK xar 资源包含链接文件');
      if (details.isDirectory()) await this.copySdkDirectory(from, to);
      else if (details.isFile()) await copyFile(from, to);
    }
  }

  private async prepareTaskWorkspace(workspace: string, taskId: string, torrent: Buffer): Promise<void> {
    await this.ensureStateSubdirectory(dirname(workspace));
    const ownerPath = join(workspace, 'owner');
    const existing = await lstat(workspace).catch(() => null);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('迅雷任务工作区不是普通目录');
      const owner = await readFile(ownerPath, 'utf8').catch(() => '');
      const oldTorrent = await readFile(join(workspace, 'metadata.torrent')).catch(() => Buffer.alloc(0));
      if (owner !== taskId || !oldTorrent.equals(torrent)) throw new Error('迅雷任务工作区所有权或种子元数据校验失败');
      return;
    }
    await mkdir(workspace, { recursive: false });
    await writeFile(ownerPath, taskId, { encoding: 'utf8', flag: 'wx' });
    await writeFile(join(workspace, 'metadata.torrent'), torrent, { flag: 'wx' });
  }

  private async prepareStage(stageDirectory: string, taskId: string): Promise<void> {
    if (await lstat(stageDirectory).then(() => true, () => false)) {
      const details = await lstat(stageDirectory);
      const owner = await readFile(join(stageDirectory, '.ldownload-owner'), 'utf8').catch(() => '');
      if (details.isSymbolicLink() || !details.isDirectory() || owner !== taskId) throw new Error('迅雷临时下载目录未通过所有权校验');
      return;
    }
    await mkdir(stageDirectory, { recursive: false });
    await writeFile(join(stageDirectory, '.ldownload-owner'), taskId, { encoding: 'utf8', flag: 'wx' });
  }

  private async validateDownloadedFiles(root: string, metadata: ThunderTorrentMetadata, selected: Set<number>): Promise<string[]> {
    const selectedPaths: string[] = [];
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('迅雷临时目录不是普通目录');
    const canonicalRoot = resolve(root);
    for (const file of metadata.files) {
      if (!selected.has(file.index)) continue;
      const components = metadata.isMultiFile ? [metadata.name, ...file.components] : file.components;
      let current = canonicalRoot;
      for (let index = 0; index < components.length; index++) {
        const component = components[index];
        if (!component) throw new Error('种子文件路径为空');
        current = join(current, component);
        if (!isInside(canonicalRoot, current)) throw new Error('种子文件路径超出迅雷临时目录');
        const details = await lstat(current);
        if (details.isSymbolicLink() || (index < components.length - 1 && !details.isDirectory()) || (index === components.length - 1 && (!details.isFile() || details.size !== file.size))) {
          throw new Error(`迅雷下载文件未通过路径或大小校验：${file.path}`);
        }
      }
      selectedPaths.push(current);
    }
    return selectedPaths;
  }

  private async removeCompletedFiles(task: ThunderTaskInput): Promise<void> {
    const metadata = await this.loadTorrentFile(task.torrentFilePath, task.infoHash);
    const output = resolve(task.directory, task.fileName);
    if (!isInside(resolve(task.directory), output)) throw new Error('Completed folder path escaped its destination');
    const rootInfo = await lstat(output).catch(() => null);
    if (!rootInfo) return;
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Completed torrent path is not a regular folder');
    const root = await realpath(output);
    const selected = new Set(task.selectedFileIndices ?? metadata.files.map(file => file.index));
    const directories = new Set<string>();
    const filesToRemove: string[] = [];
    for (const file of metadata.files) {
      if (!selected.has(file.index)) continue;
      const components = metadata.isMultiFile ? [metadata.name, ...file.components] : file.components;
      let current = root;
      for (let index = 0; index < components.length; index++) {
        const component = components[index];
        if (!component) throw new Error('Completed torrent file path is empty');
        current = join(current, component);
        if (!isInside(root, current)) throw new Error('Completed torrent file path escaped its folder');
        const details = await lstat(current);
        if (details.isSymbolicLink()) throw new Error('Completed torrent file path contains a link');
        if (index < components.length - 1) {
          if (!details.isDirectory()) throw new Error('Completed torrent path is not a regular folder');
          directories.add(current);
        } else {
          if (!details.isFile() || details.size !== file.size) throw new Error('Completed torrent file changed; preserving it');
          filesToRemove.push(current);
        }
      }
    }
    for (const path of filesToRemove) await rm(path, { force: false });
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      try { await rmdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; }
    }
    try { await rmdir(output); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; }
  }

  private async assertNoLinks(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      const details = await lstat(path);
      if (details.isSymbolicLink()) throw new Error('Task output contains a link; preserving it');
      if (details.isDirectory()) await this.assertNoLinks(path);
    }
  }

  private async saveMetainfo(infoHash: string, torrent: Buffer): Promise<string> {
    await mkdir(this.metainfoDirectory, { recursive: true });
    const destination = join(this.metainfoDirectory, `${infoHash}.torrent`);
    const temporary = join(this.metainfoDirectory, `${infoHash}.${randomUUID()}.tmp`);
    await writeFile(temporary, torrent, { flag: 'wx' });
    await rename(temporary, destination);
    return destination;
  }

  private async readAndVerifyTorrent(path: string, infoHash: string): Promise<ThunderTorrentMetadata> {
    const torrent = await readFile(path);
    const metadata = parseThunderTorrent(torrent);
    if (metadata.infoHash !== infoHash.toLowerCase()) throw new Error('种子元数据与任务 BTIH 不一致');
    return metadata;
  }

  private async ensureStateSubdirectory(directory: string): Promise<void> {
    const stateRoot = resolve(this.options.stateDirectory);
    const target = resolve(directory);
    if (!isInside(stateRoot, target)) throw new Error('迅雷工作目录超出应用数据目录');
    const stateInfo = await lstat(stateRoot).catch(() => null);
    if (stateInfo?.isSymbolicLink() || (stateInfo && !stateInfo.isDirectory())) throw new Error('迅雷应用数据目录不是普通目录');
    await mkdir(stateRoot, { recursive: true });
    let targetInfo = await lstat(target).catch(() => null);
    if (!targetInfo) {
      try { await mkdir(target, { recursive: false }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      targetInfo = await lstat(target).catch(() => null);
    }
    if (!targetInfo || targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) throw new Error('迅雷任务父目录不是普通目录');
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(stateRoot), realpath(target)]);
    if (!isInside(canonicalRoot, canonicalTarget)) throw new Error('迅雷任务父目录解析到应用数据目录之外');
  }

  private async removeOwnedWorkspace(path: string): Promise<void> {
    const resolved = resolve(path);
    if (!isInside(this.options.stateDirectory, resolved) || resolved === resolve(this.options.stateDirectory)) throw new Error('拒绝清理迅雷引擎目录之外的路径');
    const details = await lstat(resolved).catch(() => null);
    if (!details) return;
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('迅雷工作区不是普通目录');
    await rm(resolved, { recursive: true, force: false });
  }

}
