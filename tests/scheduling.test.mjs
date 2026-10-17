import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextScheduledAtSeconds,
  scheduledAtMilliseconds,
  validateDownloadSchedule,
} from '../electron/core/scheduling.ts';

test('converts scheduled timestamps from Unix seconds to milliseconds', () => {
  assert.equal(scheduledAtMilliseconds(1_800_000_000), 1_800_000_000_000);
  assert.equal(scheduledAtMilliseconds(null), 0);
});

test('accepts only daily and weekly repeat plans with a scheduled start', () => {
  assert.doesNotThrow(() => validateDownloadSchedule(1_800_000_000, 86_400));
  assert.doesNotThrow(() => validateDownloadSchedule(1_800_000_000, 604_800));
  assert.doesNotThrow(() => validateDownloadSchedule(null, null));
  assert.throws(() => validateDownloadSchedule(null, 86_400), /计划开始时间/);
  assert.throws(() => validateDownloadSchedule(1_800_000_000, 60), /每天或每周/);
  assert.throws(() => validateDownloadSchedule(-1, null), /计划开始时间/);
});

test('computes the next repeat time in Unix seconds', () => {
  assert.equal(nextScheduledAtSeconds(1_800_000_000_123, 86_400), 1_800_086_400);
});
