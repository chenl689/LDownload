export const REPEAT_INTERVALS_SECONDS = [86_400, 604_800] as const;

export function validateDownloadSchedule(scheduledAt: unknown, repeatIntervalSeconds: unknown): void {
  if (scheduledAt != null && (!Number.isSafeInteger(scheduledAt) || Number(scheduledAt) < 0)) {
    throw new Error('计划开始时间无效');
  }
  if (repeatIntervalSeconds != null && !REPEAT_INTERVALS_SECONDS.includes(Number(repeatIntervalSeconds) as typeof REPEAT_INTERVALS_SECONDS[number])) {
    throw new Error('重复周期只支持每天或每周');
  }
  if (repeatIntervalSeconds != null && scheduledAt == null) {
    throw new Error('重复下载需要先设置计划开始时间');
  }
}

export function scheduledAtMilliseconds(scheduledAt: number | null): number {
  return scheduledAt == null ? 0 : scheduledAt * 1000;
}

export function nextScheduledAtSeconds(nowMilliseconds: number, repeatIntervalSeconds: number): number {
  return Math.floor(nowMilliseconds / 1000) + repeatIntervalSeconds;
}
