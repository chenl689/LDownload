import { mkdtemp, realpath, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ThunderSdkEngine, findVerifiedSdkDirectory } from '../electron/engines/thunder/thunder-sdk.ts';

if (process.platform !== 'win32') throw new Error('此迅雷 SDK 自检只能在 Windows 上运行。');
const resourcesDirectory = resolve(process.argv[2] || 'release/win-unpacked/resources/thunder');
const sdkDirectory = join(resourcesDirectory, 'sdk');
const bridgeExecutable = join(resourcesDirectory, 'ThunderBridge.exe');
const verifiedSdk = await findVerifiedSdkDirectory(sdkDirectory);
if (verifiedSdk !== sdkDirectory) throw new Error('指定目录不是校验通过的包内迅雷 SDK：' + sdkDirectory);
const bridgeInfo = await lstat(bridgeExecutable).catch(() => null);
if (!bridgeInfo?.isFile() || bridgeInfo.isSymbolicLink()) throw new Error('包内 ThunderBridge.exe 不存在或不是普通文件。');

const temporaryRoot = await mkdtemp(join(tmpdir(), 'ldownload-thunder-sdk-smoke-'));
try {
  const engine = new ThunderSdkEngine({
    bundledSdkDirectory: sdkDirectory,
    stateDirectory: join(temporaryRoot, 'user-data', 'engine'),
    bridgeExecutable,
  });
  try {
    await engine.selfTest(new AbortController().signal);
    process.stdout.write('Bundled Thunder SDK load, export binding, initialization, and cleanup passed. No download task was created.\n');
  } finally {
    await engine.dispose();
  }
} finally {
  const canonicalTemp = await realpath(tmpdir());
  const canonicalTarget = await realpath(temporaryRoot);
  const rel = relative(canonicalTemp, canonicalTarget);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('自检临时目录校验失败，拒绝清理：' + canonicalTarget);
  const details = await lstat(canonicalTarget);
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('自检临时路径已改变，拒绝清理：' + canonicalTarget);
  await rm(canonicalTarget, { recursive: true, force: false });
}
