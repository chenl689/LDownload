import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type { TaskLogEntry, TaskLogLevel } from '../../src/shared/contracts';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const tails = new Map<string, Promise<void>>();

function logDirectory(): string {
  return join(app.getPath('userData'), 'logs');
}

function validTaskId(taskId: string): boolean {
  return /^[a-z0-9-]{1,80}$/i.test(taskId);
}

function entry(level: TaskLogLevel, code: string, message: string): TaskLogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    code: code.slice(0, 80),
    message: message.slice(0, 2000),
  };
}

function append(fileName: string, value: TaskLogEntry): Promise<void> {
  const filePath = join(logDirectory(), fileName);
  const previous = tails.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await mkdir(logDirectory(), { recursive: true });
    try {
      const details = await stat(filePath);
      if (details.size >= MAX_LOG_BYTES) {
        const backup = filePath + '.1';
        await rm(backup, { force: true });
        await rename(filePath, backup);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await appendFile(filePath, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600 });
  });
  tails.set(filePath, next);
  return next;
}

export function writeApplicationLog(level: TaskLogLevel, code: string, message: string): Promise<void> {
  return append('application.jsonl', entry(level, code, message)).catch(() => undefined);
}

export function writeTaskLog(taskId: string, level: TaskLogLevel, code: string, message: string): void {
  if (!validTaskId(taskId)) return;
  void append('task-' + taskId + '.jsonl', entry(level, code, message)).catch(() => undefined);
}

async function readFileEntries(filePath: string): Promise<TaskLogEntry[]> {
  try {
    const contents = await readFile(filePath, 'utf8');
    const result: TaskLogEntry[] = [];
    for (const line of contents.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const value = JSON.parse(line) as TaskLogEntry;
        if (typeof value.timestamp === 'string' && typeof value.code === 'string' &&
            typeof value.message === 'string' && ['info', 'warn', 'error'].includes(value.level)) result.push(value);
      } catch { /* Ignore a partial last line after an interrupted write. */ }
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function readTaskLogs(taskId: string, limit = 200): Promise<TaskLogEntry[]> {
  if (!validTaskId(taskId)) throw new Error('任务编号无效');
  const currentPath = join(logDirectory(), 'task-' + taskId + '.jsonl');
  await tails.get(currentPath)?.catch(() => undefined);
  const [older, current] = await Promise.all([
    readFileEntries(currentPath + '.1'),
    readFileEntries(currentPath),
  ]);
  return [...older, ...current].slice(-Math.max(1, Math.min(500, limit)));
}

export function classifyTaskError(message: string): string {
  const value = message.toLowerCase();
  if (/\b403\b|forbidden/.test(value)) return 'HTTP_FORBIDDEN';
  if (/\b416\b|range not satisfiable/.test(value)) return 'HTTP_RANGE_INVALID';
  if (/\b5\d\d\b|server error|service unavailable/.test(value)) return 'HTTP_SERVER_ERROR';
  if (/enospc|no space left|磁盘空间不足/.test(value)) return 'DISK_SPACE';
  if (/eacces|eperm|access is denied|permission denied|拒绝访问/.test(value)) return 'FILE_PERMISSION';
  if (/etimedout|timeout|timed out|超时/.test(value)) return 'NETWORK_TIMEOUT';
  if (/econnreset|econnrefused|enotfound|network|socket|网络/.test(value)) return 'NETWORK_ERROR';
  if (/proxy|代理/.test(value)) return 'PROXY_ERROR';
  if (/thunder|迅雷|sdk|bridge/.test(value)) return 'THUNDER_ENGINE_ERROR';
  return 'DOWNLOAD_FAILED';
}
