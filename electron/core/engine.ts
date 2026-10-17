import type { TaskSnapshot } from '../../src/shared/contracts';

export type EngineProcessState = 'starting' | 'ready' | 'restarting' | 'failed';
export type EngineMethod =
  | 'tasks:list' | 'tasks:inspect-url' | 'tasks:add' | 'tasks:pause' | 'tasks:resume' | 'tasks:resume-order' | 'tasks:start-all' | 'tasks:pause-all'
  | 'tasks:export-input-secrets' | 'tasks:restore-input-secrets' | 'tasks:export-proxy-secrets' | 'tasks:set-proxy-credentials'
  | 'tasks:remove' | 'tasks:set-category' | 'tasks:set-queue' | 'tasks:import-torrent'
  | 'tasks:download-settings' | 'tasks:update-download-settings'
  | 'tasks:magnet-settings' | 'tasks:update-magnet-settings'
  | 'magnets:list' | 'magnets:inspect' | 'magnets:inspect-task' | 'magnets:add' | 'magnets:update-selection'
  | 'magnets:pause' | 'magnets:resume' | 'magnets:remove';

export interface EnginePort {
  start(): void;
  stop(): void;
  waitUntilReady(timeoutMs?: number): Promise<void>;
  request<T>(method: EngineMethod, payload?: unknown): Promise<T>;
  currentSnapshot(): TaskSnapshot;
}

export interface EngineStatus {
  state: EngineProcessState;
  message?: string;
}
