import type { AdaptiveDownloadConfig } from './adaptive-config';

export interface ConcurrencyDecision {
  type: 'increase' | 'saturated' | 'decrease' | 'congestion' | 'ceiling' | 'cooldown' | 'steal' | 'evict';
  reason: string;
  timestamp: number;
  concurrency: number;
  activeWorkers: number;
  totalSpeedBytesPerSecond: number;
  retryAfterMs?: number;
}

interface SlotWaiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  abort: () => void;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('下载已取消');
}

/**
 * Treats the selected count as a ceiling. One-at-a-time probes grow the pool
 * only while aggregate throughput improves; congestion backs it off.
 */
export class ConcurrencyController {
  private target: number;
  private ceiling: number;
  private active = 0;
  private readonly waiters: SlotWaiter[] = [];
  private cooldownUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly workerSpeeds = new Map<number, number>();
  private lastThroughput = 0;
  private probe: { previousTarget: number; baselineSpeed: number; samples: number } | null = null;
  private saturatedUntil = 0;
  private lastAdjustmentAt = 0;
  private nextManualRecoveryAt = 0;
  private readonly config: AdaptiveDownloadConfig;
  private readonly onDecision: ((decision: ConcurrencyDecision) => void) | undefined;

  constructor(
    config: AdaptiveDownloadConfig,
    maxConcurrency: number,
    onDecision?: (decision: ConcurrencyDecision) => void,
    _now = Date.now(),
  ) {
    this.config = config;
    this.ceiling = Math.max(1, Math.min(config.maxConcurrency, Math.floor(maxConcurrency) || 1));
    this.target = Math.min(this.ceiling, config.initialConcurrency);
    this.onDecision = onDecision;
  }

  get concurrency(): number { return this.target; }
  get activeWorkers(): number { return this.active; }
  get totalSpeedBytesPerSecond(): number { return this.lastThroughput; }
  get maxConcurrency(): number { return this.ceiling; }
  get currentWorkerSpeeds(): Array<{ workerId: number; speedBytesPerSecond: number }> {
    return [...this.workerSpeeds].map(([workerId, speedBytesPerSecond]) => ({ workerId, speedBytesPerSecond }));
  }

  setCeiling(value: number, now = Date.now()): void {
    const next = Math.max(1, Math.min(this.config.maxConcurrency, Math.floor(value) || 1));
    if (next === this.ceiling) return;
    this.ceiling = next;
    if (this.target > next) {
      this.target = next;
      this.probe = null;
      this.emit('ceiling', '当前剩余数据或配置限制了并发上限。', now);
    }
    this.dispatch(now);
  }

  reportWorkerSpeed(workerId: number, speedBytesPerSecond: number): void {
    this.workerSpeeds.set(workerId, Math.max(0, Number.isFinite(speedBytesPerSecond) ? speedBytesPerSecond : 0));
  }

  /**
   * Add one worker at a time and keep it only when the smoothed aggregate rate
   * improves. Waiting for multiple samples near saturation avoids reacting to
   * a single burst or a short gap between Range responses.
   */
  observeThroughput(speedBytesPerSecond: number, now = Date.now()): void {
    const speed = Math.max(0, Number.isFinite(speedBytesPerSecond) ? speedBytesPerSecond : 0);
    const previousSpeed = this.lastThroughput;
    this.lastThroughput = speed;
    // In manual mode, ordinary throughput fluctuations must not undo the
    // user's selected parallelism. Explicit congestion responses still call
    // onCongestion and are handled separately.
    if (this.config.manualConcurrency) return;
    if (this.probe) {
      if (this.probe.baselineSpeed <= 0) return;
      // A zero-throughput sample is evidence that the new worker did not help,
      // rather than a reason to leave a probe active forever during a stall.
      const gain = speed <= 0 ? -1 : (speed - this.probe.baselineSpeed) / this.probe.baselineSpeed;
      if (gain >= this.config.concurrencyIncreaseThreshold) {
        this.probe = null;
        this.lastAdjustmentAt = now;
        this.emit('increase', '增加连接后总吞吐提升 ' + Math.round(gain * 100) + '%，继续探测。', now);
        return;
      }
      this.probe.samples++;
      if (this.probe.samples >= this.config.uncertainSamplesBeforeSaturation) {
        const previousTarget = this.probe.previousTarget;
        const reason = gain <= this.config.concurrencySaturationThreshold
          ? '增加连接后的吞吐提升仅 ' + Math.round(gain * 100) + '%，已达到当前网络或服务端的有效并发上限。'
          : '连续采样未确认新增连接有足够收益，暂时锁定并发以避免抖动。';
        this.target = previousTarget;
        this.probe = null;
        this.saturatedUntil = now + this.config.saturationHoldMs;
        this.lastAdjustmentAt = now;
        this.emit('saturated', reason, now);
        this.dispatch(now);
      }
      return;
    }

    if (previousSpeed > 0 && this.target > 1 && this.cooldownUntil <= now &&
        this.lastAdjustmentAt > 0 && now - this.lastAdjustmentAt >= this.config.sampleIntervalMs &&
        speed < previousSpeed * (1 - this.config.concurrencyDecreaseThreshold)) {
      this.reduceConcurrency('总吞吐显著下降，减少连接并进入冷却期。', now);
      return;
    }
    if (this.target >= this.ceiling || this.cooldownUntil > now || this.saturatedUntil > now || speed <= 0) return;
    if (this.lastAdjustmentAt > 0 && now - this.lastAdjustmentAt < this.config.sampleIntervalMs) return;

    const previousTarget = this.target;
    this.target = Math.min(this.ceiling, this.target + 1);
    this.probe = { previousTarget, baselineSpeed: speed, samples: 0 };
    this.lastAdjustmentAt = now;
    this.emit('increase', '慢启动探测：新增一个连接并比较总吞吐。', now);
    this.dispatch(now);
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw abortError(signal);
    if (this.canAcquire(Date.now()) && this.waiters.length === 0) {
      this.active++;
      return this.createRelease();
    }
    return new Promise((resolve, reject) => {
      const waiter: SlotWaiter = {
        signal,
        resolve: release => { signal.removeEventListener('abort', waiter.abort); resolve(release); },
        reject: error => { signal.removeEventListener('abort', waiter.abort); reject(error); },
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter.reject(abortError(signal));
          this.dispatch(Date.now());
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
      this.dispatch(Date.now());
    });
  }

  onCongestion(reason: string, retryAfterMs = 0, now = Date.now()): void {
    const retryAfter = Math.max(0, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
    this.cooldownUntil = Math.max(this.cooldownUntil, now + this.config.cooldownMs, now + retryAfter);
    this.nextManualRecoveryAt = this.cooldownUntil + Math.max(this.config.cooldownMs, this.config.sampleIntervalMs);
    this.probe = null;
    this.saturatedUntil = 0;
    this.reduceConcurrency(reason, now, false);
    this.emit('congestion', reason, now, retryAfter);
    this.emit('cooldown', '等待服务端冷却窗口结束后再发送新请求。', now, retryAfter);
    this.dispatch(now);
  }

  waitForCooldown(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    const remaining = this.cooldownUntil - Date.now();
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, remaining);
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(abortError(signal));
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** Recover one connection at a time after explicit congestion has cooled. */
  recoverManualConcurrency(now = Date.now()): void {
    if (!this.config.manualConcurrency || this.target >= this.ceiling ||
        now < this.cooldownUntil || now < this.nextManualRecoveryAt) return;
    this.target = Math.min(this.ceiling, this.target + 1);
    this.nextManualRecoveryAt = now + Math.max(this.config.cooldownMs, this.config.sampleIntervalMs);
    this.lastAdjustmentAt = now;
    this.emit('increase', '服务端冷却后逐步恢复用户设定的连接数。', now);
    this.dispatch(now);
  }

  private canAcquire(now: number): boolean {
    return now >= this.cooldownUntil && this.active < this.target;
  }

  private reduceConcurrency(reason: string, now: number, startCooldown = true): void {
    const previous = this.target;
    this.target = Math.max(1, Math.floor(previous * this.config.congestionReductionFactor));
    if (previous > 1 && this.target === previous) this.target = previous - 1;
    this.probe = null;
    if (startCooldown) this.cooldownUntil = Math.max(this.cooldownUntil, now + this.config.cooldownMs);
    this.lastAdjustmentAt = now;
    if (this.target !== previous) this.emit('decrease', reason, now);
    this.dispatch(now);
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.dispatch(Date.now());
    };
  }

  private dispatch(now: number): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.canAcquire(now) && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal.aborted) { waiter.reject(abortError(waiter.signal)); continue; }
      this.active++;
      waiter.resolve(this.createRelease());
    }
    if (this.waiters.length && now < this.cooldownUntil) {
      this.timer = setTimeout(() => this.dispatch(Date.now()), Math.max(1, this.cooldownUntil - now));
    }
  }

  private emit(
    type: ConcurrencyDecision['type'],
    reason: string,
    timestamp: number,
    retryAfterMs?: number,
  ): ConcurrencyDecision {
    const decision: ConcurrencyDecision = {
      type, reason, timestamp, concurrency: this.target, activeWorkers: this.active,
      totalSpeedBytesPerSecond: this.lastThroughput,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
    this.onDecision?.(decision);
    return decision;
  }
}
