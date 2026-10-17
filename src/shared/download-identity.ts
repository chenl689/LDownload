export function downloadSourceIdentity(value: string): string {
  const url = new URL(value.trim());
  url.hash = '';
  return url.href;
}

export function findDuplicateDownloadSource<T extends { url: string }>(
  tasks: readonly T[],
  candidateUrl: string,
): T | undefined {
  const identity = downloadSourceIdentity(candidateUrl);
  return tasks.find(task => {
    try {
      return downloadSourceIdentity(task.url) === identity;
    } catch {
      return false;
    }
  });
}
