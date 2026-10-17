import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RangeScheduler } from '../electron/engines/http/range-scheduler.ts';

const MiB = 1024 * 1024;

test('claims disjoint ranges with exclusive ownership', () => {
  const scheduler = new RangeScheduler(12 * MiB);
  const first = scheduler.claim(0, 3 * MiB, 0);
  const second = scheduler.claim(1, 3 * MiB, 0);
  assert.deepEqual([first?.start, first?.end], [0, 3 * MiB - 1]);
  assert.deepEqual([second?.start, second?.end], [3 * MiB, 6 * MiB - 1]);
  assert.equal(scheduler.snapshot().pending[0]?.start, 6 * MiB);
  assert.ok(first && second && first.end < second.start);
});

test('seeds independent ranges across the whole file before workers start', () => {
  const scheduler = new RangeScheduler(16 * MiB);
  scheduler.seedPending(4);
  const ranges = scheduler.snapshot().pending;
  assert.equal(ranges.length, 4);
  assert.deepEqual(ranges[0], { start: 0, end: 4 * MiB - 1 });
  assert.deepEqual(ranges[3], { start: 12 * MiB, end: 16 * MiB - 1 });
  const first = scheduler.claim(0, 4 * MiB, 0);
  const second = scheduler.claim(1, 4 * MiB, 0);
  assert.equal(first?.start, 0);
  assert.equal(second?.end, 16 * MiB - 1);
  scheduler.assertPartitionCoverage();
});

test('commits one complete interval exactly once', () => {
  const scheduler = new RangeScheduler(2 * MiB);
  const lease = scheduler.claim(0, 2 * MiB, 0);
  assert.ok(lease);
  scheduler.updateProgress(lease.id, 2 * MiB, 2 * MiB);
  assert.equal(scheduler.beginCommit(lease.id), true);
  assert.equal(scheduler.beginCommit(lease.id), false);
  scheduler.complete(lease.id);
  scheduler.assertCompleteCoverage();
  assert.equal(scheduler.remainingBytes, 0);
});

test('a paused partial range commits its prefix and resumes only the suffix', () => {
  const scheduler = new RangeScheduler(6 * MiB);
  const lease = scheduler.claim(0, 6 * MiB, 0);
  assert.ok(lease);
  scheduler.updateProgress(lease.id, 2 * MiB, MiB);
  const checkpoint = scheduler.finishPartial(lease.id, 2 * MiB);
  assert.deepEqual(checkpoint.committedPrefix, { start: 0, end: 2 * MiB - 1 });
  assert.deepEqual(checkpoint.requeued, [{ start: 2 * MiB, end: 6 * MiB - 1 }]);
  const resumed = scheduler.claim(1, 6 * MiB, 1);
  assert.ok(resumed);
  assert.deepEqual([resumed.start, resumed.end], [2 * MiB, 6 * MiB - 1]);
  assert.equal(scheduler.snapshot().done[0]?.end, 2 * MiB - 1);
});

test('a yielded slow range commits its prefix and divides the suffix into disjoint help ranges', () => {
  const scheduler = new RangeScheduler(12 * MiB);
  const lease = scheduler.claim(0, 8 * MiB, 0);
  assert.ok(lease);
  scheduler.updateProgress(lease.id, 2 * MiB, MiB);
  const result = scheduler.finishPartial(lease.id, 2 * MiB, true);
  assert.deepEqual(result.committedPrefix, { start: 0, end: 2 * MiB - 1 });
  assert.deepEqual(result.requeued, [
    { start: 2 * MiB, end: 5 * MiB - 1 },
    { start: 5 * MiB, end: 8 * MiB - 1 },
  ]);
  scheduler.assertPartitionCoverage();
  const snapshot = scheduler.snapshot();
  const allRanges = [...snapshot.done, ...snapshot.pending].sort((a, b) => a.start - b.start);
  assert.equal(allRanges[0].start, 0);
  assert.equal(allRanges.at(-1).end, 12 * MiB - 1);
  for (let index = 1; index < allRanges.length; index++) {
    assert.equal(allRanges[index - 1].end + 1, allRanges[index].start);
  }
});

test('restores validated completed intervals and rejects overlaps', () => {
  const scheduler = new RangeScheduler(10, [{ start: 0, end: 3 }, { start: 4, end: 5 }]);
  assert.deepEqual(scheduler.snapshot().done, [{ start: 0, end: 5 }]);
  const lease = scheduler.claim(0, 10);
  assert.ok(lease);
  assert.deepEqual([lease.start, lease.end], [6, 9]);
  assert.throws(() => new RangeScheduler(10, [{ start: 0, end: 5 }, { start: 4, end: 7 }]), /重叠/);
});
