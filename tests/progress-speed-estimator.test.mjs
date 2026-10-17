import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressSpeedEstimator } from '../electron/core/progress-speed-estimator.ts';

test('keeps the last measured speed through short gaps between byte updates', () => {
  const estimator = new ProgressSpeedEstimator();
  assert.equal(estimator.update(0, 1000), 0);
  assert.equal(estimator.update(1024, 2000), 1024);
  assert.equal(estimator.update(1024, 5000), 1024);
  assert.equal(estimator.update(1024, 11999), 1024);
  assert.equal(estimator.update(1024, 12001), 0);
});

test('starts a fresh rate sample after a long stall', () => {
  const estimator = new ProgressSpeedEstimator();
  estimator.update(0, 1000);
  estimator.update(1024, 2000);
  assert.equal(estimator.update(2048, 13000), 93);
});
