const NO_PROGRESS_TIMEOUT_MS = 10_000;

export class ProgressSpeedEstimator {
  private lastBytes = 0;
  private lastSampleAt: number | null = null;
  private lastProgressAt: number | null = null;
  private smoothedBytesPerSecond = 0;

  update(downloadedBytes: number, now = Date.now()): number {
    const bytes = Math.max(0, Math.floor(Number(downloadedBytes) || 0));
    if (this.lastSampleAt === null) {
      this.lastBytes = bytes;
      this.lastSampleAt = now;
      this.lastProgressAt = now;
      return 0;
    }

    const elapsed = now - this.lastSampleAt;
    if (bytes > this.lastBytes && elapsed > 0) {
      if (this.lastProgressAt !== null && now - this.lastProgressAt > NO_PROGRESS_TIMEOUT_MS) {
        this.smoothedBytesPerSecond = 0;
      }
      const sample = ((bytes - this.lastBytes) * 1000) / elapsed;
      this.smoothedBytesPerSecond = this.smoothedBytesPerSecond > 0
        ? this.smoothedBytesPerSecond * 0.65 + sample * 0.35
        : sample;
      this.lastBytes = bytes;
      this.lastSampleAt = now;
      this.lastProgressAt = now;
    }

    if (this.lastProgressAt !== null && now - this.lastProgressAt > NO_PROGRESS_TIMEOUT_MS) {
      this.smoothedBytesPerSecond = 0;
    }
    return Math.max(0, Math.round(this.smoothedBytesPerSecond));
  }
}
