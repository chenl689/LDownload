import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddDownloadInput } from '../../src/shared/contracts';

type DownloadSecret = Pick<AddDownloadInput, 'headers' | 'cookie' | 'referer' | 'userAgent' | 'authScheme' | 'authUsername' | 'authPassword' | 'allowInsecureAuth'>;
export interface ProxyCredentials { username: string | null; password: string | null }
type StoredSecret = DownloadSecret | { proxyUsername: string | null; proxyPassword: string | null };
type SecretMap = Record<string, StoredSecret>;
const PROXY_SECRET_KEY = '__ldownload_proxy_credentials__';
let cached: SecretMap | null = null;
let pendingWrite: Promise<void> = Promise.resolve();

function storePath(): string { return join(app.getPath('userData'), 'download-secrets.bin'); }

async function readStore(): Promise<SecretMap> {
  if (cached) return cached;
  let encrypted: Buffer;
  try { encrypted = await readFile(storePath()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (cached = {});
    throw error;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法读取已保存的下载凭据');
  const value = JSON.parse(safeStorage.decryptString(encrypted));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('下载凭据存储格式无效');
  cached = value as SecretMap;
  return cached;
}

function secretsFrom(input: Partial<AddDownloadInput>): DownloadSecret {
  const value: DownloadSecret = {};
  if (input.headers && Object.keys(input.headers).length) value.headers = input.headers;
  if (input.cookie) value.cookie = input.cookie;
  if (input.referer) value.referer = input.referer;
  if (input.userAgent) value.userAgent = input.userAgent;
  if (input.authScheme) value.authScheme = input.authScheme;
  if (input.authUsername) value.authUsername = input.authUsername;
  if (input.authPassword) value.authPassword = input.authPassword;
  if (input.allowInsecureAuth) value.allowInsecureAuth = true;
  return value;
}

function persistSnapshot(values: SecretMap): Promise<void> {
  const snapshot = JSON.stringify(values);
  pendingWrite = pendingWrite.catch(() => undefined).then(async () => {
    const target = storePath();
    if (!Object.keys(values).length) {
      await unlink(target).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 用户的系统凭据加密不可用，无法安全保存下载认证信息');
    const temporary = target + '.' + randomUUID() + '.tmp';
    const encrypted = safeStorage.encryptString(snapshot);
    try {
      await mkdir(app.getPath('userData'), { recursive: true });
      await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  });
  return pendingWrite;
}

export async function saveDownloadInputSecrets(taskId: string, input: Partial<AddDownloadInput>): Promise<void> {
  const values = await readStore();
  const secret = secretsFrom(input);
  if (Object.keys(secret).length) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 用户的系统凭据加密不可用，无法安全保存下载认证信息');
    values[taskId] = secret;
  } else delete values[taskId];
  cached = values;
  await persistSnapshot(values);
}

export async function removeDownloadInputSecrets(taskId: string): Promise<void> {
  const values = await readStore();
  if (!(taskId in values)) return;
  delete values[taskId];
  cached = values;
  await persistSnapshot(values);
}

export async function loadDownloadInputSecrets(): Promise<Record<string, DownloadSecret>> {
  return Object.fromEntries(Object.entries(await readStore()).filter(([id]) => id !== PROXY_SECRET_KEY).map(([id, secret]) => [id, { ...secret } as DownloadSecret]));
}

export async function saveProxyCredentials(credentials: ProxyCredentials): Promise<void> {
  const values = await readStore();
  if (!credentials.username) delete values[PROXY_SECRET_KEY];
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 用户的系统凭据加密不可用，无法安全保存代理凭据');
    values[PROXY_SECRET_KEY] = { proxyUsername: credentials.username, proxyPassword: credentials.password ?? null };
  }
  cached = values;
  await persistSnapshot(values);
}

export async function loadProxyCredentials(): Promise<ProxyCredentials> {
  const value = (await readStore())[PROXY_SECRET_KEY] as { proxyUsername?: string | null; proxyPassword?: string | null } | undefined;
  return { username: value?.proxyUsername ?? null, password: value?.proxyPassword ?? null };
}
