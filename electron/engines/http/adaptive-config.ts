const MIB = 1024 * 1024;

/**
 * Central tuning surface for HTTP range transfers. The selected connection
 * count is a ceiling; concurrency and chunk size adapt to observed throughput.
 */
export interface AdaptiveDownloadConfig {
  /** Respect the selected segment count except for explicit congestion backoff. */
  manualConcurrency: boolean;
  smallFileThresholdBytes: number;
  initialConcurrency: number;
  maxConcurrency: number;
  minChunkBytes: number;
  maxChunkBytes: number;
  chunkAlignmentBytes: number;
  targetChunkDurationSeconds: number;
  initialChunkBytes: number;
  sampleIntervalMs: number;
  throughputEwmaAlpha: number;
  workerEwmaAlpha: number;
  concurrencyIncreaseThreshold: number;
  concurrencySaturationThreshold: number;
  uncertainSamplesBeforeSaturation: number;
  concurrencyDecreaseThreshold: number;
  congestionReductionFactor: number;
  cooldownMs: number;
  saturationHoldMs: number;
  tailConnectionOverheadSeconds: number;
  hedgeMaxRemainingBytes: number;
  hedgeSlowWorkerRatio: number;
  slowWorkerDurationMs: number;
  slowWorkerRatio: number;
  maxConnectionsPerDomain: number;
  retryInitialMs: number;
  retryMaxMs: number;
  retryJitterRatio: number;
  checkpointIntervalMs: number;
  progressEmitIntervalMs: number;
  debug: boolean;
}
export const DEFAULT_ADAPTIVE_DOWNLOAD_CONFIG: Readonly<AdaptiveDownloadConfig> = Object.freeze({
  manualConcurrency: false,
  smallFileThresholdBytes: 4 * MIB,
  initialConcurrency: 2,
  maxConcurrency: 32,
  minChunkBytes: 1 * MIB,
  maxChunkBytes: 64 * MIB,
  chunkAlignmentBytes: 1 * MIB,
  targetChunkDurationSeconds: 3,
  initialChunkBytes: 2 * MIB,
  sampleIntervalMs: 1000,
  throughputEwmaAlpha: 0.35,
  workerEwmaAlpha: 0.35,
  concurrencyIncreaseThreshold: 0.15,
  concurrencySaturationThreshold: 0.08,
  uncertainSamplesBeforeSaturation: 2,
  concurrencyDecreaseThreshold: 0.2,
  congestionReductionFactor: 0.7,
  cooldownMs: 5000,
  saturationHoldMs: 10_000,
  tailConnectionOverheadSeconds: 1.5,
  hedgeMaxRemainingBytes: 8 * MIB,
  hedgeSlowWorkerRatio: 0.3,
  slowWorkerDurationMs: 10_000,
  slowWorkerRatio: 0.3,
  maxConnectionsPerDomain: 32,
  retryInitialMs: 500,
  retryMaxMs: 30_000,
  retryJitterRatio: 0.25,
  checkpointIntervalMs: 1000,
  progressEmitIntervalMs: 150,
  debug: false,
});

function numberOption(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

/** Resolve untrusted test/runtime overrides once, before a task starts. */
export function resolveAdaptiveDownloadConfig(
  overrides: Partial<AdaptiveDownloadConfig> | undefined,
): AdaptiveDownloadConfig {
  const value = { ...DEFAULT_ADAPTIVE_DOWNLOAD_CONFIG, ...(overrides || {}) };
  const minChunkBytes = Math.floor(numberOption(value.minChunkBytes, MIB, 1, 1024 * MIB));
  const maxChunkBytes = Math.max(minChunkBytes, Math.floor(numberOption(value.maxChunkBytes, 64 * MIB, 1, 1024 * MIB)));
  const maxConcurrency = Math.floor(numberOption(value.maxConcurrency, 32, 1, 32));
  return {
    manualConcurrency: value.manualConcurrency === true,
    smallFileThresholdBytes: Math.floor(numberOption(value.smallFileThresholdBytes, 4 * MIB, 0, 1024 * MIB * 1024)),
    initialConcurrency: Math.min(maxConcurrency, Math.floor(numberOption(value.initialConcurrency, 2, 1, 32))),
    maxConcurrency,
    minChunkBytes,
    maxChunkBytes,
    chunkAlignmentBytes: Math.floor(numberOption(value.chunkAlignmentBytes, MIB, 1, 64 * MIB)),
    targetChunkDurationSeconds: numberOption(value.targetChunkDurationSeconds, 3, 0.1, 120),
    initialChunkBytes: Math.floor(numberOption(value.initialChunkBytes, 2 * MIB, 1, 4 * MIB)),
    sampleIntervalMs: Math.floor(numberOption(value.sampleIntervalMs, 1000, 100, 60_000)),
    throughputEwmaAlpha: numberOption(value.throughputEwmaAlpha, 0.35, 0.01, 1),
    workerEwmaAlpha: numberOption(value.workerEwmaAlpha, 0.35, 0.01, 1),
    concurrencyIncreaseThreshold: numberOption(value.concurrencyIncreaseThreshold, 0.15, 0, 10),
    concurrencySaturationThreshold: numberOption(value.concurrencySaturationThreshold, 0.08, 0, 10),
    uncertainSamplesBeforeSaturation: Math.floor(numberOption(value.uncertainSamplesBeforeSaturation, 2, 1, 20)),
    concurrencyDecreaseThreshold: numberOption(value.concurrencyDecreaseThreshold, 0.2, 0, 1),
    congestionReductionFactor: numberOption(value.congestionReductionFactor, 0.7, 0.1, 1),
    cooldownMs: Math.floor(numberOption(value.cooldownMs, 5000, 0, 600_000)),
    saturationHoldMs: Math.floor(numberOption(value.saturationHoldMs, 10_000, 0, 3_600_000)),
    tailConnectionOverheadSeconds: numberOption(value.tailConnectionOverheadSeconds, 1.5, 0, 60),
    hedgeMaxRemainingBytes: Math.floor(numberOption(value.hedgeMaxRemainingBytes, 8 * MIB, 1, 1024 * MIB)),
    hedgeSlowWorkerRatio: numberOption(value.hedgeSlowWorkerRatio, 0.3, 0, 1),
    slowWorkerDurationMs: Math.floor(numberOption(value.slowWorkerDurationMs, 10_000, 100, 3_600_000)),
    slowWorkerRatio: numberOption(value.slowWorkerRatio, 0.3, 0, 1),
    maxConnectionsPerDomain: Math.floor(numberOption(value.maxConnectionsPerDomain, 32, 1, 256)),
    retryInitialMs: Math.floor(numberOption(value.retryInitialMs, 500, 0, 300_000)),
    retryMaxMs: Math.floor(numberOption(value.retryMaxMs, 30_000, 0, 3_600_000)),
    retryJitterRatio: numberOption(value.retryJitterRatio, 0.25, 0, 1),
    checkpointIntervalMs: Math.floor(numberOption(value.checkpointIntervalMs, 1000, 100, 60_000)),
    progressEmitIntervalMs: Math.floor(numberOption(value.progressEmitIntervalMs, 150, 50, 10_000)),
    debug: value.debug === true,
  };
}
