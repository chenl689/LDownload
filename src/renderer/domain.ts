import type { DownloadTask, MagnetFilePreview, MagnetTask } from '../shared/contracts';

export type DisplayTask =
  | (DownloadTask & { kind: 'ordinary' })
  | (Omit<MagnetTask, 'id'> & {
      id: string;
      sourceId: string;
      kind: 'magnet';
      category: string;
      queueName: string;
      segments: [];
      scheduledAt: null;
    });

export function normalizeMagnets(tasks: MagnetTask[]): DisplayTask[] {
  return tasks.map(task => ({
    ...task,
    id: 'magnet:' + task.id,
    sourceId: task.id,
    kind: 'magnet',
    category: 'other',
    queueName: '默认',
    segments: [],
    scheduledAt: null,
  }));
}

export function combineTasks(downloads: DownloadTask[], magnets: MagnetTask[]): DisplayTask[] {
  return [
    ...downloads.map(task => ({ ...task, kind: 'ordinary' as const })),
    ...normalizeMagnets(magnets),
  ].sort((a, b) => b.createdAt - a.createdAt);
}

export function formatBytes(value: number | null | undefined, english = false): string {
  if (value == null || !Number.isFinite(value)) return english ? 'Checking' : '检测中';
  if (value < 1024) return value + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return size.toFixed(size >= 100 ? 0 : 1) + ' ' + units[index];
}

export function getTaskType(task: DisplayTask): string {
  if (task.kind === 'magnet') return 'torrent';
  const file = task.fileName.toLowerCase();
  const ext = file.match(/\.([^.\\/]+)$/)?.[1] || '';
  const groups: Record<string, string[]> = {
    video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg'],
    installer: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'apk', 'ipa'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'avif'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'cab', 'iso'],
    document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'epub'],
  };
  for (const [group, extensions] of Object.entries(groups)) {
    if (extensions.includes(ext)) return group;
  }
  const fromCategory: Record<string, string> = {
    compressed: 'archive', music: 'audio', programs: 'installer', documents: 'document',
  };
  return fromCategory[task.category] || 'other';
}

export function isSupportedLink(value: string): boolean {
  if (/^magnet:\?/i.test(value)) return true;
  try {
    const protocol = new URL(value).protocol.toLowerCase();
    return ['http:', 'https:', 'ftp:', 'ftps:'].includes(protocol);
  } catch {
    return false;
  }
}

export function parseLinks(value: string): string[] {
  return value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

export function isMagnet(value: string): boolean {
  return /^magnet:\?/i.test(value);
}

export function selectedFileSummary(preview: MagnetFilePreview, indices: Set<number>, english = false): string {
  const size = preview.files.filter(file => indices.has(file.index)).reduce((sum, file) => sum + file.size, 0);
  return indices.size + ' / ' + preview.files.length + (english ? ' files · ' : ' 个文件 · ') + formatBytes(size, english);
}
