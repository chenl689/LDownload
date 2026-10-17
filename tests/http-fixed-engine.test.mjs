import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { downloadHttpTask } from '../electron/engines/http/http-engine.ts';
import { createMockRangeServer } from './helpers/mock-range-server.mjs';

const MiB = 1024 * 1024;
const liveServers = new Set();
const mockServer = async options => { const server = await createMockRangeServer(options); liveServers.add(server); return server; };
after(async () => { for (const server of liveServers) await server.close(); });
const fastSettings = (extra = {}) => ({
  connectTimeoutSeconds: 10,
  maxRetries: 4,
  speedLimitBytesSec: 0,
  autoSegmentDownloads: true,
  segmentsPerDownload: 8,
  maxGlobalConnections: 64,
  proxyMode: 'disabled',
  proxyUrl: null,
  adaptiveConfig: {
    smallFileThresholdBytes: 0,
    maxConcurrency: 32,
    minChunkBytes: MiB,
    sampleIntervalMs: 250,
    retryInitialMs: 40,
    retryMaxMs: 500,
    retryJitterRatio: 0,
    checkpointIntervalMs: 100,
    progressEmitIntervalMs: 50,
    ...extra,
  },
});

function task(url, directory, fileName) {
  return {
    id: fileName, url, fileName, directory,
    totalBytes: null, downloadedBytes: 0, segments: [],
    etag: null, lastModified: null, expectedChecksum: null,
    checksumAlgorithm: 'sha256',
  };
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
async function inTemp(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'ldl-fixed-ranges-'));
  try { await callback(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function run(server, directory, fileName, settings = fastSettings(), options = {}) {
  return downloadHttpTask(task(server.url, directory, fileName), settings, options.signal || new AbortController().signal,
    options.onProgress || (() => undefined));
}
async function assertFile(directory, fileName, expected) {
  const actual = await readFile(join(directory, fileName));
  assert.equal(actual.length, expected.length);
  assert.equal(sha256(actual), sha256(expected));
}

test('starts the selected fixed segments together and keeps progress grouped by them', { timeout: 30_000 }, async () => {
  const data = randomBytes(24 * MiB);
  const server = await mockServer({ data, connectionBytesPerSecond: 3 * MiB });
  await inTemp(async directory => {
    const events = [];
    const settings = fastSettings({ maxConcurrency: 4, initialConcurrency: 2 });
    settings.segmentsPerDownload = 4;
    settings.onAdaptiveEvent = event => events.push(event);
    const snapshots = [];
    await run(server, directory, 'adaptive.bin', settings, { onProgress: value => snapshots.push(value) });
    await assertFile(directory, 'adaptive.bin', data);
    assert.equal(server.stats.maxActiveDataRequests, 4, 'all selected workers should start together');
    assert.ok(snapshots.some(snapshot => snapshot.adaptive?.activeWorkers === 4));
    assert.ok(snapshots.every(snapshot => snapshot.segments.length === 4), 'internal lease splits must aggregate to four visible segments');
  });
  await server.close();
});

test('a persistently slow range is evicted and its unfinished suffix is reassigned', { timeout: 15_000 }, async () => {
  const data = randomBytes(24 * MiB);
  const server = await mockServer({
    data, connectionBytesPerSecond: 4 * MiB,
    slowFirstRangeStart: 0, slowFirstRangeBytesPerSecond: 64 * 1024,
  });
  await inTemp(async directory => {
    const events = [];
    const snapshots = [];
    const settings = fastSettings({
      initialConcurrency: 2, maxConcurrency: 4, slowWorkerDurationMs: 500,
      slowWorkerRatio: 0.5, sampleIntervalMs: 200, tailConnectionOverheadSeconds: 0,
    });
    settings.segmentsPerDownload = 4;
    settings.onAdaptiveEvent = event => events.push(event);
    const started = Date.now();
    await run(server, directory, 'slow-range.bin', settings, { onProgress: value => snapshots.push(value) });
    const elapsed = Date.now() - started;
    await assertFile(directory, 'slow-range.bin', data);
    assert.ok(server.stats.slowFirstRangeRequests >= 1);
    assert.ok(events.some(event => event.type === 'evict'), 'the sustained slow connection should be reported as evicted');
    assert.ok(snapshots.length > 0 && snapshots.every(snapshot => snapshot.segments.length === 4), 'steal and eviction leases must remain grouped into four UI segments');
    assert.ok(elapsed < 12_000, 'reassigned work should beat waiting for the original slow range; elapsed=' + elapsed + 'ms');
  });
  await server.close();
});

test('keeps the selected number of ranges under a shared bandwidth cap', { timeout: 30_000 }, async () => {
  const data = randomBytes(32 * MiB);
  const server = await mockServer({ data, totalBytesPerSecond: 8 * MiB, connectionBytesPerSecond: 16 * MiB });
  await inTemp(async directory => {
    const settings = fastSettings({
      initialConcurrency: 2, maxConcurrency: 8,
      uncertainSamplesBeforeSaturation: 2, saturationHoldMs: 1000,
    });
    settings.segmentsPerDownload = 8;
    const snapshots = [];
    await run(server, directory, 'saturated.bin', settings, { onProgress: value => snapshots.push(value) });
    await assertFile(directory, 'saturated.bin', data);
    assert.equal(server.stats.maxActiveDataRequests, 8, 'the selected fixed segments should start together even behind a shared cap');
    assert.ok(snapshots.every(snapshot => snapshot.segments.length === 8));
  });
  await server.close();
});

test('429 response reduces active concurrency and honors Retry-After', { timeout: 30_000 }, async () => {
  const data = randomBytes(8 * MiB);
  const retryAfterMs = 350;
  const server = await mockServer({ data, rejectFirstRequests: 1, retryAfterMs });
  await inTemp(async directory => {
    const events = [];
    const settings = fastSettings({ cooldownMs: 40 });
    settings.onAdaptiveEvent = event => events.push(event);
    const started = Date.now();
    await run(server, directory, 'retry-after.bin', settings);
    const elapsed = Date.now() - started;
    await assertFile(directory, 'retry-after.bin', data);
    assert.ok(elapsed >= retryAfterMs - 30, 'the retry must wait at least Retry-After; elapsed=' + elapsed + 'ms');
    assert.ok(events.some(event => event.type === 'congestion'));
    assert.ok(events.some(event => event.type === 'decrease'));
    assert.equal(server.stats.response429, 1);
  });
  await server.close();
});

test('pause checkpoints resume when the server has no ETag or Last-Modified', { timeout: 30_000 }, async () => {
  const data = randomBytes(8 * MiB);
  const server = await mockServer({ data, omitValidators: true, connectionBytesPerSecond: 2 * MiB });
  await inTemp(async directory => {
    const controller = new AbortController();
    const snapshots = [];
    await assert.rejects(run(server, directory, 'resume.bin', fastSettings({ maxConcurrency: 4 }), {
      signal: controller.signal,
      onProgress: progress => {
        snapshots.push(progress.downloadedBytes);
        if (progress.downloadedBytes >= 1200 * 1024) controller.abort(new Error('test pause'));
      },
    }));
    assert.ok((await stat(join(directory, 'resume.bin.ldl'))).size > 0, 'pause should persist completed byte intervals');
    const oldRangeStarts = new Set(server.stats.byRangeStart.keys());
    const resumedSnapshots = [];
    await run(server, directory, 'resume.bin', fastSettings({ maxConcurrency: 4 }), { onProgress: value => resumedSnapshots.push(value) });
    await assertFile(directory, 'resume.bin', data);
    assert.ok(resumedSnapshots.length > 0 && resumedSnapshots.every(snapshot => snapshot.segments.length === 4), 'resume should rebuild the selected fixed segment view');
    assert.ok(oldRangeStarts.has(0), 'first attempt should have started at byte zero');
    assert.equal(server.stats.byRangeStart.get(0), 1, 'completed data from byte zero must not be downloaded again');
    assert.ok([...server.stats.byRangeStart.keys()].some(start => start > 0), 'resume should continue at an unfinished nonzero offset');
  });
  await server.close();
});

test('fixed workers preserve random file contents across repeated transfers', { timeout: 45_000 }, async () => {
  for (let runIndex = 0; runIndex < 3; runIndex++) {
    const data = randomBytes(7 * MiB);
    const server = await mockServer({ data, connectionBytesPerSecond: 4 * MiB, delayMinMs: 0, delayMaxMs: 8 });
    await inTemp(async directory => {
      await run(server, directory, 'race-' + runIndex + '.bin', fastSettings({ maxConcurrency: 7 }));
      await assertFile(directory, 'race-' + runIndex + '.bin', data);
    });
    await server.close();
  }
});
