export interface ByteRange {
  start: number;
  end: number;
}

export interface RangeLease extends ByteRange {
  id: string;
  workerId: number;
  receivedBytes: number;
  speedBytesPerSecond: number;
  startedAt: number;
  kind: 'primary';
  /** A lease must reserve its one and only disk commit before writing. */
  commitClaimed: boolean;
}

export interface RangeSchedulerSnapshot {
  totalBytes: number;
  pending: ByteRange[];
  active: RangeLease[];
  done: ByteRange[];
}

export interface PartialFinishResult {
  committedPrefix: ByteRange | null;
  requeued: ByteRange[];
}

function rangeLength(range: ByteRange): number {
  return Math.max(0, range.end - range.start + 1);
}

/**
 * Synchronous range bookkeeping. Mutations do not await, so each lease has
 * exclusive ownership of its bytes while network and disk work runs outside
 * the scheduler. Completed ranges are disjoint and pending ranges cover every
 * byte not in done or active.
 */
export class RangeScheduler {
  private readonly pending: ByteRange[] = [];
  private readonly active = new Map<string, RangeLease>();
  private readonly done: ByteRange[] = [];
  private nextLeaseNumber = 1;
  private claimFromLowEnd = true;
  readonly totalBytes: number;

  constructor(totalBytes: number, completed: ByteRange[] = []) {
    this.totalBytes = totalBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new Error('区间总长度无效');
    this.done.push(...this.normalizeCompleted(completed));
    this.rebuildPending();
  }

  get remainingBytes(): number {
    return this.totalBytes - this.done.reduce((sum, range) => sum + rangeLength(range), 0);
  }
  get activeCount(): number { return this.active.size; }
  get pendingCount(): number { return this.pending.length; }
  get isComplete(): boolean { return this.totalBytes === 0 || this.remainingBytes === 0; }
  hasWork(): boolean { return this.pending.length > 0; }

  /**
   * Seed the pending map with visible, file-wide ranges before workers start.
   * Splitting the largest gap repeatedly gives balanced initial ranges without
   * permanently tying a worker to one of them; later work stealing may split
   * any unfinished lease again.
   */
  seedPending(segmentCount: number): void {
    const target = Math.max(1, Math.min(32, Math.floor(segmentCount) || 1));
    while (this.pending.length < target) {
      let largestIndex = -1;
      let largestLength = 1;
      for (let index = 0; index < this.pending.length; index++) {
        const length = rangeLength(this.pending[index]!);
        if (length > largestLength) { largestIndex = index; largestLength = length; }
      }
      if (largestIndex < 0) break;
      const range = this.pending.splice(largestIndex, 1)[0]!;
      const middle = range.start + Math.floor((rangeLength(range) - 1) / 2);
      this.pending.push({ start: range.start, end: middle }, { start: middle + 1, end: range.end });
      this.pending.sort((left, right) => left.start - right.start);
    }
  }

  claim(workerId: number, desiredBytes: number, now = Date.now()): RangeLease | null {
    if (!Number.isSafeInteger(workerId) || workerId < 0) throw new Error('worker ID 无效');
    if (!Number.isFinite(desiredBytes) || desiredBytes <= 0) return null;
    // IDM gives a free connection half of the largest remaining segment.
    // Break ties from alternating file ends so early progress spans the file.
    let largestLength = 0;
    let firstLargest = -1;
    let lastLargest = -1;
    for (let index = 0; index < this.pending.length; index++) {
      const length = rangeLength(this.pending[index]!);
      if (length > largestLength) {
        largestLength = length;
        firstLargest = index;
        lastLargest = index;
      } else if (length === largestLength) lastLargest = index;
    }
    const pendingIndex = this.claimFromLowEnd ? firstLargest : lastLargest;
    const takeFromLowEnd = this.pending.length === 1 ? true : this.claimFromLowEnd;
    this.claimFromLowEnd = !this.claimFromLowEnd;
    const pending = this.pending[pendingIndex];
    if (!pending) return null;
    const count = Math.min(rangeLength(pending), Math.floor(desiredBytes));
    const start = takeFromLowEnd ? pending.start : pending.end - count + 1;
    const end = takeFromLowEnd ? start + count - 1 : pending.end;
    if (count === rangeLength(pending)) this.pending.splice(pendingIndex, 1);
    else if (takeFromLowEnd) pending.start = end + 1;
    else pending.end = start - 1;
    const lease: RangeLease = {
      id: 'range-' + this.nextLeaseNumber++, workerId, start, end,
      receivedBytes: 0, speedBytesPerSecond: 0, startedAt: now,
      kind: 'primary', commitClaimed: false,
    };
    this.active.set(lease.id, lease);
    return { ...lease };
  }

  updateProgress(id: string, receivedBytes: number, speedBytesPerSecond: number): void {
    const lease = this.requireLease(id);
    if (!Number.isSafeInteger(receivedBytes) || receivedBytes < lease.receivedBytes || receivedBytes > rangeLength(lease)) {
      throw new Error('区间进度必须单调递增且不能超出租约范围');
    }
    lease.receivedBytes = receivedBytes;
    lease.speedBytesPerSecond = Number.isFinite(speedBytesPerSecond) ? Math.max(0, speedBytesPerSecond) : 0;
  }

  activeLeases(): RangeLease[] { return [...this.active.values()].map(lease => ({ ...lease })); }

  /** Reserve the only output-file write for a complete lease. */
  beginCommit(id: string): boolean {
    const lease = this.active.get(id);
    if (!lease || lease.commitClaimed || this.isDone(lease)) return false;
    lease.commitClaimed = true;
    return true;
  }

  cancelCommit(id: string): void {
    const lease = this.active.get(id);
    if (lease) lease.commitClaimed = false;
  }

  complete(id: string): void {
    const lease = this.requireLease(id);
    if (lease.receivedBytes !== rangeLength(lease)) throw new Error('未完整接收的区间不能标记完成');
    if (!lease.commitClaimed) throw new Error('区间提交前必须先取得唯一写入权');
    this.addDone({ start: lease.start, end: lease.end });
    this.active.delete(id);
  }

  /** Commit a verified prefix and return only the uncommitted suffix to pending. */
  finishPartial(id: string, committedBytes: number, splitRemainder = false): PartialFinishResult {
    const lease = this.requireLease(id);
    if (!Number.isSafeInteger(committedBytes) || committedBytes < 0 || committedBytes > lease.receivedBytes) {
      throw new Error('部分提交字节数超出已接收范围');
    }
    if (lease.commitClaimed) throw new Error('正在提交的区间不能回收');
    const prefix = committedBytes > 0 ? { start: lease.start, end: lease.start + committedBytes - 1 } : null;
    if (prefix) this.addDone(prefix);
    const nextStart = lease.start + committedBytes;
    const remaining = nextStart <= lease.end ? { start: nextStart, end: lease.end } : null;
    let requeued: ByteRange[] = remaining ? [remaining] : [];
    if (splitRemainder && remaining && rangeLength(remaining) >= 2) {
      const middle = remaining.start + Math.floor((rangeLength(remaining) - 1) / 2);
      requeued = [{ start: remaining.start, end: middle }, { start: middle + 1, end: remaining.end }];
    }
    this.pending.push(...requeued);
    this.pending.sort((left, right) => left.start - right.start);
    this.active.delete(id);
    return { committedPrefix: prefix, requeued };
  }

  snapshot(): RangeSchedulerSnapshot {
    return {
      totalBytes: this.totalBytes,
      pending: this.pending.map(range => ({ ...range })),
      active: this.activeLeases(),
      done: this.done.map(range => ({ ...range })),
    };
  }

  assertCompleteCoverage(): void {
    if (this.totalBytes === 0) return;
    const ranges = [...this.done].sort((left, right) => left.start - right.start);
    let next = 0;
    for (const range of ranges) {
      if (range.start !== next) throw new Error('下载区间覆盖存在空洞或重叠');
      next = range.end + 1;
    }
    if (next !== this.totalBytes) throw new Error('下载区间没有完整覆盖文件');
  }

  /** Check that done, pending, and active leases still partition the file. */
  assertPartitionCoverage(): void {
    const ranges = [
      ...this.done,
      ...this.pending,
      ...[...this.active.values()].map(({ start, end }) => ({ start, end })),
    ].sort((left, right) => left.start - right.start);
    let next = 0;
    for (const range of ranges) {
      if (range.start !== next) throw new Error('待下载区间出现空洞或重叠');
      next = range.end + 1;
    }
    if (next !== this.totalBytes) throw new Error('待下载区间没有完整覆盖文件');
  }

  private normalizeCompleted(ranges: ByteRange[]): ByteRange[] {
    const sorted = ranges.map(range => ({ ...range })).sort((left, right) => left.start - right.start);
    const normalized: ByteRange[] = [];
    for (const range of sorted) {
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
        range.start < 0 || range.end < range.start || range.end >= this.totalBytes) {
        throw new Error('续传区间超出文件范围');
      }
      const previous = normalized[normalized.length - 1];
      if (previous && range.start <= previous.end) throw new Error('续传区间重叠');
      if (previous && range.start === previous.end + 1) previous.end = range.end;
      else normalized.push(range);
    }
    return normalized;
  }

  private rebuildPending(): void {
    let cursor = 0;
    for (const range of this.done) {
      if (cursor < range.start) this.pending.push({ start: cursor, end: range.start - 1 });
      cursor = range.end + 1;
    }
    if (cursor < this.totalBytes) this.pending.push({ start: cursor, end: this.totalBytes - 1 });
  }

  private addDone(range: ByteRange): void {
    if (range.start > range.end) return;
    const sorted = [...this.done, { ...range }].sort((left, right) => left.start - right.start);
    const merged: ByteRange[] = [];
    for (const item of sorted) {
      const previous = merged[merged.length - 1];
      if (previous && item.start <= previous.end) throw new Error('完成区间不能重叠');
      if (previous && item.start === previous.end + 1) previous.end = item.end;
      else merged.push(item);
    }
    this.done.splice(0, this.done.length, ...merged);
  }

  private isDone(range: ByteRange): boolean {
    return this.done.some(done => range.start >= done.start && range.end <= done.end);
  }

  private requireLease(id: string): RangeLease {
    const lease = this.active.get(id);
    if (!lease) throw new Error('下载区间租约不存在');
    return lease;
  }
}
