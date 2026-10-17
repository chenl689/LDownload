import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ADAPTIVE_DOWNLOAD_CONFIG, resolveAdaptiveDownloadConfig } from '../electron/engines/http/adaptive-config.ts';
import { ConcurrencyController } from '../electron/engines/http/concurrency-controller.ts';

test('starts at two workers and probes upward while aggregate throughput improves', () => {
  const config = resolveAdaptiveDownloadConfig({ initialConcurrency: 2, maxConcurrency: 8 });
  const events = [];
  const controller = new ConcurrencyController(config, 8, event => events.push(event));
  assert.equal(controller.concurrency, 2);
  controller.observeThroughput(1000, 1000);
  assert.equal(controller.concurrency, 3);
  controller.observeThroughput(1200, 2000);
  assert.equal(controller.concurrency, 3, 'a >15% gain keeps the added worker');
  controller.observeThroughput(1400, 3000);
  assert.equal(controller.concurrency, 4);
  assert.ok(events.filter(event => event.type === 'increase').length >= 2);
});

test('manual concurrency ignores throughput swings but backs off and recovers after congestion', () => {
  const config = resolveAdaptiveDownloadConfig({
    manualConcurrency: true, initialConcurrency: 8, maxConcurrency: 8,
    cooldownMs: 100, sampleIntervalMs: 10,
  });
  const controller = new ConcurrencyController(config, 8);
  assert.equal(controller.concurrency, 8);
  controller.observeThroughput(10_000, 1000);
  controller.observeThroughput(100, 2000);
  assert.equal(controller.concurrency, 8, 'ordinary throughput changes must not override the selected range count');

  controller.onCongestion('HTTP 429', 50, 3000);
  assert.equal(controller.concurrency, 5, 'explicit congestion still applies the configured backoff');
  controller.observeThroughput(20_000, 3100);
  controller.recoverManualConcurrency(3199);
  assert.equal(controller.concurrency, 5, 'recovery waits through both Retry-After and cooldown');
  controller.recoverManualConcurrency(3200);
  assert.equal(controller.concurrency, 6);
  controller.recoverManualConcurrency(3299);
  assert.equal(controller.concurrency, 6, 'recovery is rate-limited to avoid immediately retriggering the server');
  controller.recoverManualConcurrency(3300);
  assert.equal(controller.concurrency, 7);
});

test('rolls back an unproductive probe and holds the saturated concurrency', () => {
  const config = resolveAdaptiveDownloadConfig({
    initialConcurrency: 2, uncertainSamplesBeforeSaturation: 2, saturationHoldMs: 5000,
  });
  const events = [];
  const controller = new ConcurrencyController(config, 8, event => events.push(event));
  controller.observeThroughput(1000, 1000);
  controller.observeThroughput(1040, 2000);
  controller.observeThroughput(1050, 3000);
  assert.equal(controller.concurrency, 2);
  assert.ok(events.some(event => event.type === 'saturated'));
  controller.observeThroughput(1050, 4000);
  assert.equal(controller.concurrency, 2, 'the saturation hold prevents immediate reprobes');
});

test('counts zero-throughput probe samples as failed gains instead of pinning concurrency', () => {
  const config = resolveAdaptiveDownloadConfig({ initialConcurrency: 2, uncertainSamplesBeforeSaturation: 2 });
  const controller = new ConcurrencyController(config, 8);
  controller.observeThroughput(1000, 1000);
  controller.observeThroughput(0, 2000);
  controller.observeThroughput(0, 3000);
  assert.equal(controller.concurrency, 2);
});

test('congestion reduces concurrency by 0.7 and honors Retry-After before new work', async () => {
  const config = resolveAdaptiveDownloadConfig({ initialConcurrency: 4, cooldownMs: 5 });
  const events = [];
  const controller = new ConcurrencyController(config, 8, event => events.push(event));
  controller.onCongestion('HTTP 429', 80);
  assert.equal(controller.concurrency, 2);
  assert.ok(events.some(event => event.type === 'decrease'));
  assert.ok(events.some(event => event.type === 'congestion'));
  const started = Date.now();
  const release = await controller.acquire(new AbortController().signal);
  const waited = Date.now() - started;
  release();
  assert.ok(waited >= 60, 'a new connection must wait for the server Retry-After');
});

test('a configured ceiling bounds adaptive concurrency without raising its current target', () => {
  const controller = new ConcurrencyController(resolveAdaptiveDownloadConfig({ initialConcurrency: 8 }), 32);
  controller.setCeiling(3);
  assert.equal(controller.maxConcurrency, 3);
  assert.equal(controller.concurrency, 3);
  controller.setCeiling(50);
  assert.equal(controller.maxConcurrency, 32);
  assert.equal(controller.concurrency, 3, 'raising the ceiling is only permission to probe higher');
});

test('aborted concurrency waiters are removed without consuming a slot', async () => {
  const controller = new ConcurrencyController(resolveAdaptiveDownloadConfig({ cooldownMs: 300 }), 2);
  const aborter = new AbortController();
  controller.onCongestion('HTTP 503', 300);
  const waiting = controller.acquire(aborter.signal);
  aborter.abort(new Error('pause'));
  await assert.rejects(waiting, /pause/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(controller.activeWorkers, 0);
});
