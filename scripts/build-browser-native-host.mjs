import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  process.stdout.write('The browser native messaging host is Windows-only; skipping build.\n');
  process.exit(0);
}

const windowsRoot = process.env.WINDIR || 'C:\\Windows';
const framework = join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = join(framework, 'csc.exe');
const reference = join(framework, 'System.Web.Extensions.dll');
const source = join(projectRoot, 'electron', 'main', 'BrowserNativeHost.cs');
const output = join(projectRoot, 'out', 'browser-native-host', 'LDownloadNativeHost.exe');
mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(compiler, [
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/codepage:65001',
  `/out:${output}`, `/reference:${reference}`, source,
], { stdio: 'inherit', windowsHide: true });
if (result.error) throw new Error(`Could not run the .NET Framework compiler at ${compiler}: ${result.error.message}`);
if (result.status !== 0) throw new Error(`Browser native messaging host compilation failed (${result.status}).`);
process.stdout.write(`Built browser native messaging host: ${output}\n`);
