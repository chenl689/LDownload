import assert from 'node:assert/strict';
import { test } from 'node:test';
import { regroupDownloadSegments } from '../src/shared/contracts.ts';

const MiB = 1024 * 1024;

test('regroups persisted scheduler leases into the selected logical segment count', () => {
  const oldSegments = Array.from({ length: 28 }, (_, index) => {
    const start = Math.floor(index * 32 * MiB / 28);
    const end = Math.floor((index + 1) * 32 * MiB / 28) - 1;
    return {
      index, rangeStart: start, rangeEnd: end,
      totalBytes: end - start + 1,
      downloadedBytes: index < 7 ? end - start + 1 : index === 7 ? 512 * 1024 : 0,
      active: false,
    };
  });

  const grouped = regroupDownloadSegments(oldSegments, 32 * MiB, 8);
  assert.ok(grouped);
  assert.equal(grouped.length, 8);
  assert.deepEqual(grouped.map(segment => [segment.rangeStart, segment.rangeEnd]), Array.from({ length: 8 }, (_, index) => [
    index * 4 * MiB,
    (index + 1) * 4 * MiB - 1,
  ]));
  assert.equal(grouped.reduce((sum, segment) => sum + segment.downloadedBytes, 0),
    oldSegments.reduce((sum, segment) => sum + segment.downloadedBytes, 0));
  assert.ok(grouped.every(segment => !segment.active));
});

test('does not count overlapping legacy progress twice', () => {
  const grouped = regroupDownloadSegments([
    { index: 0, rangeStart: 0, rangeEnd: 4 * MiB - 1, downloadedBytes: 4 * MiB, totalBytes: 4 * MiB, active: false },
    { index: 1, rangeStart: 2 * MiB, rangeEnd: 6 * MiB - 1, downloadedBytes: 4 * MiB, totalBytes: 4 * MiB, active: false },
  ], 8 * MiB, 1);

  assert.equal(grouped?.[0]?.downloadedBytes, 6 * MiB);
});

test('returns null when byte progress cannot be tied to stored range offsets', () => {
  const grouped = regroupDownloadSegments([
    { index: 0, rangeStart: null, rangeEnd: null, downloadedBytes: 10, totalBytes: 20, active: false },
  ], 20, 2);
  assert.equal(grouped, null);
});
