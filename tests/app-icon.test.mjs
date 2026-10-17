import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

function assertPngSize(png, size) {
  assert.deepEqual([...png.subarray(0, 8)], pngSignature);
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
}

test('desktop and browser extension icons are generated from the provided app icon', async () => {
  const svg = await readFile(join(root, 'icon/app-icon.svg'), 'utf8');
  assert.match(svg, /<svg[^>]*viewBox="0 0 512 512"/);

  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.build.win.icon, 'icon/app-icon.ico');
  assert.equal(packageJson.build.mac.icon, 'icon/app-icon.icns');
  assert.equal(packageJson.build.linux.icon, 'icon/app-icon.png');
  const resources = packageJson.build.extraResources.map(resource => resource.from);
  for (const asset of ['icon/app-icon.svg', 'icon/app-icon.png', 'icon/app-icon.ico', 'icon/app-icon.icns']) assert.ok(resources.includes(asset));

  const appPng = await readFile(join(root, 'icon/app-icon.png'));
  assertPngSize(appPng, 512);

  const ico = await readFile(join(root, 'icon/app-icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const icoCount = ico.readUInt16LE(4);
  assert.equal(icoCount, 5);
  const expectedIcoSizes = [16, 32, 64, 128, 256];
  for (let index = 0; index < icoCount; index++) {
    const entry = 6 + index * 16;
    const width = ico[entry] || 256;
    const height = ico[entry + 1] || 256;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(width, expectedIcoSizes[index]);
    assert.equal(height, expectedIcoSizes[index]);
    assertPngSize(ico.subarray(offset, offset + length), width);
  }

  const icns = await readFile(join(root, 'icon/app-icon.icns'));
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const expectedIcnsTypes = ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10'];
  let cursor = 8;
  for (let index = 0; index < expectedIcnsTypes.length; index++) {
    assert.equal(icns.toString('ascii', cursor, cursor + 4), expectedIcnsTypes[index]);
    const chunkLength = icns.readUInt32BE(cursor + 4);
    const size = [16, 32, 64, 128, 256, 512, 1024][index];
    assertPngSize(icns.subarray(cursor + 8, cursor + chunkLength), size);
    cursor += chunkLength;
  }
  assert.equal(cursor, icns.length);

  for (const browser of ['chromium', 'firefox']) {
    const directory = join(root, 'vendor/browser-extension', browser);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.icons['128'], 'icons/app-icon-128.png');
    assert.equal(manifest.action.default_icon['16'], 'icons/app-icon-16.png');
    for (const size of [16, 32, 48, 128]) {
      const path = join(directory, 'icons', 'app-icon-' + size + '.png');
      const png = await readFile(path);
      assertPngSize(png, size);
      assert.ok((await stat(path)).size > 0);
    }
  }
});
