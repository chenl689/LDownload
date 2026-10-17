import { createHash } from 'node:crypto';
import { copyFile, lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sdkVersion = '2.86.202.143';
const expectedHashes = new Map([
  ['DownloadSDKProxy.dll', '8de0b2befdb8e439da90b39aee99b5576db2f74c26a1a23774207c9f6658fa19'],
  ['DownloadSDK.dll', 'e055afbca6dbb413e6db180507f0a3e6536f39008da38a3d761ef4168fa264c9'],
]);

if (process.platform !== 'win32') throw new Error('迅雷 SDK 安装包只能在 Windows 构建；未生成安装资源。');

async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

const thunderRoot = join(projectRoot, 'vendor', 'thunder');
const sdkDirectory = join(thunderRoot, 'sdk');
const bridgeSource = join(projectRoot, 'out', 'thunder', 'ThunderBridge.exe');
const sdkInfo = await lstat(sdkDirectory).catch(() => null);
if (!sdkInfo?.isDirectory() || sdkInfo.isSymbolicLink()) throw new Error('缺少 vendor/thunder/sdk 随包 SDK 目录。请先将已批准的 SDK 副本放入新项目 vendor 目录。');
for (const [name, expected] of expectedHashes) {
  if (await hashFile(join(sdkDirectory, name)) !== expected) throw new Error('随包 SDK 校验失败：' + name);
}
const serverInfo = await lstat(join(sdkDirectory, 'DownloadSDKServer.exe')).catch(() => null);
if (!serverInfo?.isFile() || serverInfo.isSymbolicLink()) throw new Error('随包 SDK 缺少 DownloadSDKServer.exe。');
const bridgeInfo = await lstat(bridgeSource).catch(() => null);
if (!bridgeInfo?.isFile() || bridgeInfo.isSymbolicLink()) throw new Error('迅雷桥接程序未构建为普通文件。');
await copyFile(bridgeSource, join(thunderRoot, 'ThunderBridge.exe'));
process.stdout.write('Verified the existing bundled Thunder SDK ' + sdkVersion + ' in ' + sdkDirectory + '; staged the bridge beside it. No installed SDK is queried or copied.\n');