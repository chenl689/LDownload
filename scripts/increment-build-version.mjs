import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version ?? '');
if (!match) throw new Error('Windows package version must use MAJOR.MINOR.PATCH.');
const [major, minor, patch] = match.slice(1).map(Number);
if (![major, minor, patch].every(value => Number.isSafeInteger(value) && value >= 0)) {
  throw new Error('Windows package version contains an invalid numeric component.');
}
packageJson.version = `${major}.${minor}.${patch + 1}`;
await writeFile(packagePath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
console.log('Packaging version: ' + packageJson.version);
