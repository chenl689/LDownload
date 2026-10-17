import { join } from 'node:path';
import { app, MessageChannelMain, session, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';
import type { TaskLogLevel, TaskSnapshot } from '../../src/shared/contracts';
import type { EngineMethod, EnginePort, EngineProcessState } from '../core/engine';
interface WorkerReply { id: number; ok: boolean; value?: unknown; error?: string }
interface WorkerEvent { type: 'ready' | 'snapshot' | 'log'; snapshot?: TaskSnapshot; message?: string; level?: TaskLogLevel; code?: string; taskId?: string }
interface PendingCall { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export class EngineSupervisor implements EnginePort {
  private worker: UtilityProcess | null = null;
  private port: MessagePortMain | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private stopping = false;
  private state: EngineProcessState = 'starting';
  private snapshot: TaskSnapshot = { revision: 0, downloads: [], magnets: [] };
  private readyWaiters = new Set<() => void>();

  constructor(
    private readonly onStatus: (state: EngineProcessState, message?: string) => void,
    private readonly onSnapshot: (snapshot: TaskSnapshot) => void,
    private readonly onWorkerReady?: () => Promise<void>,
    private readonly onWorkerLog?: (event: { level: TaskLogLevel; code: string; message: string; taskId?: string }) => void,
  ) {}

  start(): void {
    this.stopping = false;
    this.spawn();
  }

  waitUntilReady(timeoutMs = 15_000): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const onReady = () => { clearTimeout(timer); resolve(); };
      timer = setTimeout(() => {
        this.readyWaiters.delete(onReady);
        reject(new Error('下载引擎进程启动超时'));
      }, timeoutMs);
      this.readyWaiters.add(onReady);
    });
  }

  stop(): void {
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.port?.close(); this.port = null;
    this.worker?.kill(); this.worker = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('引擎进程已关闭'));
    }
    this.pending.clear();
  }

  async request<T>(method: EngineMethod, payload?: unknown): Promise<T> {
    if (!this.worker || !this.port || this.state !== 'ready') throw new Error('引擎进程尚未就绪');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('引擎请求超时'));
      }, 15_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.port?.postMessage({ id, method, payload });
    });
  }

  currentSnapshot(): TaskSnapshot { return this.snapshot; }

  private spawn(): void {
    if (this.stopping) return;
    this.setState(this.retries ? 'restarting' : 'starting', this.retries ? '下载引擎正在重新启动' : undefined);
    try {
      const { port1, port2 } = new MessageChannelMain();
      const workerPath = join(__dirname, 'engine-worker.cjs');
      const stateFile = join(app.getPath('userData'), 'engine', 'mock-state.json');
      const bridgeExecutable = app.isPackaged
        ? join(process.resourcesPath, 'thunder', 'ThunderBridge.exe')
        : join(app.getAppPath(), 'out', 'thunder', 'ThunderBridge.exe');
      const bundledSdkDirectory = app.isPackaged ? join(process.resourcesPath, 'thunder', 'sdk') : join(app.getAppPath(), 'vendor', 'thunder', 'sdk');
      const child = utilityProcess.fork(workerPath, [], {
        cwd: app.getPath('userData'),
        session: session.defaultSession,
        serviceName: 'LDownload engine process',
        env: {
          ...process.env,
          LDOWNLOAD_STATE_FILE: stateFile,
          LDOWNLOAD_DEFAULT_DIRECTORY: app.getPath('downloads'),
          LDOWNLOAD_THUNDER_BUNDLED_SDK_DIR: bundledSdkDirectory,
          LDOWNLOAD_THUNDER_BRIDGE_PATH: bridgeExecutable,
        },
      });
      this.worker = child;
      this.port = port1;
      port1.on('message', event => { void this.onMessage(event.data as WorkerReply | WorkerEvent); });
      port1.start();
      child.postMessage({ type: 'connect' }, [port2]);
      child.on('exit', code => this.onExit(code));
      child.on('error', () => this.setState('failed', '引擎 utility process 报错'));
    } catch (error) {
      this.scheduleRestart(error instanceof Error ? error.message : String(error));
    }
  }

  private async onMessage(message: WorkerReply | WorkerEvent): Promise<void> {
    if ('type' in message) {
      if (message.type === 'ready') {
        this.state = 'ready';
        if (message.snapshot) this.updateSnapshot(message.snapshot);
        try { await this.onWorkerReady?.(); } catch (error) {
          if (this.state === 'ready') this.setState('ready', '下载凭据恢复失败：' + (error instanceof Error ? error.message : String(error)));
          return;
        }
        if (this.state === 'ready') { this.retries = 0; this.setState('ready'); }
      } else if (message.type === 'snapshot' && message.snapshot) {
        this.updateSnapshot(message.snapshot);
      } else if (message.type === 'log' && message.message) {
        this.onWorkerLog?.({
          level: message.level ?? 'warn',
          code: message.code ?? 'ENGINE_WORKER_LOG',
          message: message.message,
          ...(message.taskId ? { taskId: message.taskId } : {}),
        });
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error || '引擎请求失败'));
  }

  private updateSnapshot(snapshot: TaskSnapshot): void {
    this.snapshot = snapshot;
    this.onSnapshot(snapshot);
  }

  private onExit(code: number): void {
    if (this.stopping) return;
    this.worker = null;
    this.port?.close(); this.port = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('引擎进程意外退出，任务状态已从本地快照保留'));
    }
    this.pending.clear();
    this.scheduleRestart(`引擎进程退出，代码 ${code}`);
  }

  private scheduleRestart(message: string): void {
    if (this.stopping) return;
    this.retries++;
    if (this.retries > 6) {
      this.setState('failed', `${message}；已达到重启次数上限`);
      return;
    }
    this.setState('restarting', message);
    const delay = Math.min(500 * 2 ** (this.retries - 1), 15_000);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.spawn(); }, delay);
  }

  private setState(state: EngineProcessState, message?: string): void {
    this.state = state;
    if (state === 'ready') {
      for (const resolve of this.readyWaiters) resolve();
      this.readyWaiters.clear();
    }
    this.onStatus(state, message);
  }
}
