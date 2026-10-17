import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { downloadHttpTask } from '../electron/engines/http/http-engine.ts';
import { createMockRangeServer } from '../tests/helpers/mock-range-server.mjs';

const MiB = 1024 * 1024;
const sizeMiB = Math.max(4, Number(process.argv.find(value => value.startsWith('--size-mib='))?.split('=')[1] || 6));
const data = randomBytes(sizeMiB * MiB);
const expectedHash = createHash('sha256').update(data).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'ldl-http-benchmark-'));

async function runStaticRanges(url, outputPath) {
  // Baseline the former policy: at least two fixed ranges, and increase the
  // count only once each piece would exceed the old 128 MiB split threshold.
  const workers = Math.min(32, Math.max(2, Math.ceil(data.length / (128 * MiB))));
  const width = Math.ceil(data.length / workers);
  const file = await open(outputPath, 'w+');
  await file.truncate(data.length);
  try {
    await Promise.all(Array.from({ length: workers }, async (_, index) => {
      const start = index * width;
      const end = Math.min(data.length - 1, start + width - 1);
      if (start > end) return;
      const response = await fetch(url, { headers: { range: `bytes=${start}-${end}` } });
      assert.equal(response.status, 206);
      const contentRange = response.headers.get('content-range') || '';
      assert.equal(contentRange, `bytes ${start}-${end}/${data.length}`);
      if (!response.body) throw new Error('Mock server returned an empty response body');
      const reader = response.body.getReader();
      let offset = start;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        const chunk = Buffer.from(item.value);
        await file.write(chunk, 0, chunk.length, offset);
        offset += chunk.length;
      }
      assert.equal(offset, end + 1, `static range ${start}-${end} was incomplete`);
    }));
    await file.sync();
  } finally {
    await file.close();
  }
}

async function measure(label, run) {
  const server = await createMockRangeServer({
    data,
    connectionBytesPerSecond: 4 * MiB,
    slowFirstRangeStart: 0,
    slowFirstRangeBytesPerSecond: 192 * 1024,
    slowFirstRangeDelayMs: 150,
  });
  const outputPath = join(root, label + '.bin');
  const startedAt = performance.now();
  try {
    await run(server.url, outputPath);
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const actualHash = createHash('sha256').update(await readFile(outputPath)).digest('hex');
    assert.equal(actualHash, expectedHash, `${label} output hash mismatch`);
    return { label, elapsedSeconds, mibPerSecond: sizeMiB / elapsedSeconds, maxConnections: server.stats.maxActiveDataRequests };
  } finally {
    await server.close();
  }
}

try {
  await mkdir(root, { recursive: true });
  const baseline = await measure('static', runStaticRanges);
  let adaptiveEvents = [];
  const adaptive = await measure('adaptive', async (url, outputPath) => {
    const settings = {
      connectTimeoutSeconds: 10,
      maxRetries: 4,
      speedLimitBytesSec: 0,
      autoSegmentDownloads: true,
      segmentsPerDownload: 8,
      maxGlobalConnections: 32,
      proxyMode: 'disabled',
      proxyUrl: null,
      onAdaptiveEvent: event => adaptiveEvents.push(event),
      adaptiveConfig: {
        smallFileThresholdBytes: 0,
        initialConcurrency: 2,
        maxConcurrency: 8,
        minChunkBytes: MiB,
        maxChunkBytes: 4 * MiB,
        chunkAlignmentBytes: MiB,
        initialChunkBytes: MiB,
        targetChunkDurationSeconds: 1,
        sampleIntervalMs: 250,
        cooldownMs: 100,
        retryInitialMs: 40,
        retryMaxMs: 500,
        retryJitterRatio: 0,
        checkpointIntervalMs: 250,
        progressEmitIntervalMs: 50,
        slowWorkerDurationMs: 500,
        hedgeMaxRemainingBytes: 4 * MiB,
      },
    };
    const directory = join(root, 'adaptive-output');
    await mkdir(directory, { recursive: true });
    const task = {
      id: 'adaptive-benchmark', url, fileName: 'adaptive.bin', directory,
      totalBytes: null, downloadedBytes: 0, segments: [], etag: null, lastModified: null,
      expectedChecksum: expectedHash, checksumAlgorithm: 'sha256',
    };
    await downloadHttpTask(task, settings, new AbortController().signal, () => undefined);
    // Copy only after engine checksum verification; measure() then hashes
    // both algorithms' output through the same path.
    await copyFile(join(directory, 'adaptive.bin'), outputPath);
  });
  const speedup = baseline.elapsedSeconds / adaptive.elapsedSeconds;
  const steals = adaptiveEvents.filter(event => event.type === 'steal').length;
  const evictions = adaptiveEvents.filter(event => event.type === 'evict').length;
  process.stdout.write([
    `Scenario: ${sizeMiB} MiB, 4 MiB/s per connection, first range limited to 192 KiB/s`,
    `Static 128 MiB policy: ${baseline.elapsedSeconds.toFixed(2)} s, ${baseline.mibPerSecond.toFixed(2)} MiB/s, peak ${baseline.maxConnections} connections`,
    `Adaptive 8-connection ceiling: ${adaptive.elapsedSeconds.toFixed(2)} s, ${adaptive.mibPerSecond.toFixed(2)} MiB/s, peak ${adaptive.maxConnections} connections`,
    `Assistance events: ${steals} steals, ${evictions} slow-connection evictions`,
    `Speedup: ${speedup.toFixed(2)}x`,
  ].join('\n') + '\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
