import type { AddDownloadInput, DownloadMetadata } from '../../src/shared/contracts';
import {
  downloadHttpTask,
  inspectHttpUrl,
  type HttpProgress,
  type HttpTaskState,
  type HttpTransferSettings,
} from '../engines/http/http-engine.ts';
import {
  downloadFtpTask,
  inspectFtpUrl,
  type FtpInspection,
} from '../engines/ftp-engine.ts';

export type DownloadEngineMetadata = DownloadMetadata & {
  finalUrl: string;
  etag: string | null;
  lastModified: string | null;
};

export interface DownloadEngine {
  readonly id: 'http' | 'ftp';
  readonly protocols: readonly string[];
  inspect(input: AddDownloadInput, timeoutSeconds: number, settings: HttpTransferSettings): Promise<DownloadEngineMetadata>;
  download(
    task: HttpTaskState & Partial<AddDownloadInput>,
    settings: HttpTransferSettings,
    signal: AbortSignal,
    onProgress: (progress: HttpProgress) => void,
    forceSingleConnection: boolean,
    beforeFinalize?: (partialPath: string) => Promise<void>,
  ): Promise<{ fileName: string; metadata: DownloadEngineMetadata }>;
}

const httpEngine: DownloadEngine = {
  id: 'http',
  protocols: ['http', 'https'],
  inspect: (input, timeoutSeconds, settings) => inspectHttpUrl(input, timeoutSeconds, new AbortController().signal, settings),
  download: (task, settings, signal, onProgress, forceSingleConnection, beforeFinalize) =>
    downloadHttpTask(task, settings, signal, onProgress, forceSingleConnection, beforeFinalize),
};

const ftpEngine: DownloadEngine = {
  id: 'ftp',
  protocols: ['ftp', 'ftps'],
  inspect: (input, timeoutSeconds, settings) => {
    if (settings.proxyMode !== 'disabled') throw new Error('当前 FTP 引擎不支持代理；请将代理设置为直接连接');
    return inspectFtpUrl(input, timeoutSeconds);
  },
  download: (task, settings, signal, onProgress, _forceSingleConnection, beforeFinalize) => {
    if (settings.proxyMode !== 'disabled') throw new Error('当前 FTP 引擎不支持代理；请将代理设置为直接连接');
    return downloadFtpTask(task, settings, signal, progress => onProgress(progress), beforeFinalize) as Promise<{
      fileName: string;
      metadata: FtpInspection;
    }>;
  },
};

const registeredEngines: readonly DownloadEngine[] = [httpEngine, ftpEngine];

export function downloadEngineForUrl(value: string): DownloadEngine {
  const protocol = new URL(value).protocol.slice(0, -1);
  const engine = registeredEngines.find(candidate => candidate.protocols.includes(protocol));
  if (!engine) throw new Error('没有可用于该下载协议的引擎');
  return engine;
}

export function inspectDownloadUrl(input: AddDownloadInput, timeoutSeconds: number, settings: HttpTransferSettings): Promise<DownloadEngineMetadata> {
  return downloadEngineForUrl(input.url).inspect(input, timeoutSeconds, settings);
}

export function downloadTaskWithEngine(
  task: HttpTaskState & Partial<AddDownloadInput>,
  settings: HttpTransferSettings,
  signal: AbortSignal,
  onProgress: (progress: HttpProgress) => void,
  forceSingleConnection = false,
  beforeFinalize?: (partialPath: string) => Promise<void>,
): Promise<{ fileName: string; metadata: DownloadEngineMetadata }> {
  return downloadEngineForUrl(task.url).download(task, settings, signal, onProgress, forceSingleConnection, beforeFinalize);
}
