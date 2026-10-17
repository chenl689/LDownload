import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

export interface ThunderBridgeEvent {
  event: string;
  task_id?: string;
  downloaded?: number;
  total?: number;
  speed?: number;
  message?: string;
  [key: string]: unknown;
}

export interface ThunderSessionTaskRequest {
  taskId: string;
  operation: 'resolve' | 'download';
  magnet: string | null;
  torrentPath: string;
  saveDirectory: string | null;
  selection: string | null;
  timeoutSeconds: number;
}

type SessionChild = ChildProcessByStdio<Writable, Readable, null>;

interface PendingTask {
  signal: AbortSignal;
  onProgress?: (event: ThunderBridgeEvent) => void;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

export class ThunderBridgeSession {
  private child: SessionChild | null = null;
  private lines: ReadlineInterface | null = null;
  private ready: Promise<void> | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readonly tasks = new Map<string, PendingTask>();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  get activeTaskCount(): number { return this.tasks.size; }
  get isRunning(): boolean { return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null); }

  async start(executable: string, sdkDirectory: string, workspace: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException('Thunder SDK operation cancelled', 'AbortError');
    if (!this.ready) {
      this.closing = false;
      this.ready = new Promise<void>((resolve, reject) => {
        this.rejectReady = reject;
        const child = spawn(executable, [], {
          cwd: workspace,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        this.child = child;
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        this.lines = lines;
        const startupTimer = setTimeout(() => { const error = new Error('迅雷 SDK 会话初始化超时'); this.failSession(error); child.kill(); }, 30_000);
        const finishReady = (error?: Error) => {
          clearTimeout(startupTimer);
          this.rejectReady = null;
          if (error) reject(error); else resolve();
        };
        lines.on('line', line => {
          if (Buffer.byteLength(line, 'utf8') > 16 * 1024) {
            this.failSession(new Error('迅雷桥接程序返回了超长状态消息'));
            child.kill();
            return;
          }
          let event: ThunderBridgeEvent;
          try { event = JSON.parse(line) as ThunderBridgeEvent; }
          catch {
            this.failSession(new Error('迅雷桥接程序返回了无效状态消息'));
            child.kill();
            return;
          }
          if (!event || typeof event.event !== 'string') {
            this.failSession(new Error('迅雷桥接程序状态消息缺少事件名'));
            child.kill();
            return;
          }
          if (event.event === 'session_ready') {
            finishReady();
            return;
          }
          if (event.event === 'error' || event.event === 'session_command_error') {
            const error = new Error(typeof event.message === 'string' ? event.message : '迅雷 SDK 会话失败');
            finishReady(error);
            this.failSession(error);
            return;
          }
          this.handleEvent(event);
        });
        child.once('error', error => {
          finishReady(error);
          this.failSession(error);
        });
        child.once('close', (code, processSignal) => {
          clearTimeout(startupTimer);
          lines.close();
          this.lines = null;
          this.child = null;
          const failure = new Error('迅雷 SDK 会话已退出（' + String(code ?? processSignal) + '）');
          finishReady(failure);
          if (!this.closing) this.failSession(failure);
        });
        child.stdin.write(JSON.stringify({
          operation: 'session',
          sdkDirectory,
          workspace,
          magnet: null,
          torrentPath: '',
          saveDirectory: null,
          selection: null,
          timeoutSeconds: 0,
        }) + '\n');
      }).catch(error => {
        this.ready = null;
        throw error;
      });
    }
    await this.waitWithAbort(this.ready, signal);
  }

  async runTask(
    request: ThunderSessionTaskRequest,
    signal: AbortSignal,
    onProgress?: (event: ThunderBridgeEvent) => void,
  ): Promise<void> {
    if (signal.aborted) throw new DOMException('Thunder SDK operation cancelled', 'AbortError');
    if (!this.child || !this.ready) throw new Error('迅雷 SDK 会话尚未启动');
    await this.ready;
    if (signal.aborted) throw new DOMException('Thunder SDK operation cancelled', 'AbortError');
    if (this.tasks.has(request.taskId)) throw new Error('迅雷任务编号重复');
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        try { this.send({ command: 'stop', task_id: request.taskId }); }
        catch { reject(new DOMException('Thunder SDK operation cancelled', 'AbortError')); }
      };
      this.tasks.set(request.taskId, { signal, ...(onProgress ? { onProgress } : {}), resolve, reject, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        this.send({
          command: 'add',
          task_id: request.taskId,
          operation: request.operation,
          magnet: request.magnet,
          torrentPath: request.torrentPath,
          saveDirectory: request.saveDirectory,
          selection: request.selection,
          timeoutSeconds: request.timeoutSeconds,
        });
        if (signal.aborted) onAbort();
      } catch (error) {
        this.finishTask(request.taskId, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const child = this.child;
    if (!child) {
      this.failTasks(new Error('迅雷 SDK 会话已关闭'));
      this.ready = null;
      return;
    }
    this.closing = true;
    this.closePromise = new Promise<void>(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      child.once('close', done);
      const timer = setTimeout(() => { child.kill(); done(); }, 5000);
      try {
        this.send({ command: 'shutdown' });
        child.stdin.end();
      } catch {
        child.kill();
        done();
      }
    }).finally(() => {
      this.closePromise = null;
      this.child = null;
      this.lines?.close();
      this.lines = null;
      this.ready = null;
      this.failTasks(new Error('迅雷 SDK 会话已关闭'));
      this.closing = false;
    });
    return this.closePromise;
  }

  private send(value: Record<string, unknown>): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('迅雷 SDK 会话连接已关闭');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  private handleEvent(event: ThunderBridgeEvent): void {
    const id = typeof event.task_id === 'string' ? event.task_id : null;
    if (!id) return;
    const task = this.tasks.get(id);
    if (!task) return;
    if (event.event === 'progress') {
      task.onProgress?.(event);
    } else if (event.event === 'completed' || event.event === 'metadata_ready') {
      if (task.signal.aborted) this.finishTask(id, new DOMException('迅雷任务已暂停', 'AbortError'));
      else this.finishTask(id);
    } else if (event.event === 'paused') {
      this.finishTask(id, new DOMException('迅雷任务已暂停', 'AbortError'));
    } else if (event.event === 'task_error') {
      this.finishTask(id, new Error(typeof event.message === 'string' ? event.message : '迅雷 SDK 任务失败'));
    }
  }

  private finishTask(id: string, error?: Error): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.tasks.delete(id);
    task.signal.removeEventListener('abort', task.onAbort);
    if (error) task.reject(error); else task.resolve();
  }

  private failTasks(error: Error): void {
    for (const id of [...this.tasks.keys()]) this.finishTask(id, error);
  }

  private failSession(error: Error): void {
    this.rejectReady?.(error);
    this.rejectReady = null;
    this.failTasks(error);
  }

  private async waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new DOMException('Thunder SDK operation cancelled', 'AbortError');
    let removeAbortListener: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new DOMException('Thunder SDK operation cancelled', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([promise, cancelled]); }
    finally { removeAbortListener?.(); }
  }
}
