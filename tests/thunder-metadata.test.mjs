import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseThunderTorrent } from '../electron/engines/thunder/torrent-metadata.ts';
import { findVerifiedSdkDirectory, parseMagnetIdentity, sdkCandidates } from '../electron/engines/thunder/thunder-sdk.ts';

function bstr(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from(String(bytes.length) + ':', 'ascii'), bytes]);
}
function bint(value) { return Buffer.from('i' + String(value) + 'e', 'ascii'); }
function blist(...values) { return Buffer.concat([Buffer.from('l'), ...values, Buffer.from('e')]); }
function bdict(entries) {
  const sorted = [...entries].sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return Buffer.concat([Buffer.from('d'), ...sorted.flatMap(([key, value]) => [bstr(key), value]), Buffer.from('e')]);
}
function makeTorrent(info) { return bdict([['info', info]]); }

test('parses a single-file torrent and hashes the exact bencoded info dictionary', () => {
  const info = bdict([['length', bint(1234)], ['name', bstr('video.mkv')]]);
  const metadata = parseThunderTorrent(makeTorrent(info));
  assert.equal(metadata.infoHash, createHash('sha1').update(info).digest('hex'));
  assert.equal(metadata.name, 'video.mkv');
  assert.equal(metadata.totalBytes, 1234);
  assert.equal(metadata.isMultiFile, false);
  assert.deepEqual(metadata.files, [{ index: 0, path: 'video.mkv', components: ['video.mkv'], size: 1234 }]);
});

test('parses a multi-file torrent into safe path components', () => {
  const info = bdict([
    ['files', blist(
      bdict([['length', bint(5)], ['path', blist(bstr('disc 1'), bstr('01.flac'))]]),
      bdict([['length', bint(7)], ['path', blist(bstr('disc 1'), bstr('02.flac'))]]),
    )],
    ['name', bstr('album')],
  ]);
  const metadata = parseThunderTorrent(makeTorrent(info));
  assert.equal(metadata.totalBytes, 12);
  assert.equal(metadata.isMultiFile, true);
  assert.deepEqual(metadata.files.map(file => file.components), [['disc 1', '01.flac'], ['disc 1', '02.flac']]);
});

test('rejects traversal, Windows device names and path separators', () => {
  for (const unsafeName of ['..', 'CON', 'folder\\file', 'name:stream']) {
    const info = bdict([['length', bint(1)], ['name', bstr(unsafeName)]]);
    assert.throws(() => parseThunderTorrent(makeTorrent(info)), /不安全的文件路径/);
  }
});

test('rejects duplicate dictionary fields and trailing data', () => {
  const info = bdict([['length', bint(1)], ['name', bstr('a.bin')]]);
  const duplicateInfo = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('4:info'), info, Buffer.from('e')]);
  assert.throws(() => parseThunderTorrent(duplicateInfo), /重复字段/);
  assert.throws(() => parseThunderTorrent(Buffer.concat([makeTorrent(info), Buffer.from('x')])), /额外数据/);
});

test('rejects empty and oversized metainfo', () => {
  assert.throws(() => parseThunderTorrent(Buffer.alloc(0)), /大小超出/);
  assert.throws(() => parseThunderTorrent(Buffer.alloc(16 * 1024 * 1024 + 1)), /大小超出/);
});

test('accepts only an explicitly supplied bundled SDK directory', () => {
  assert.deepEqual(sdkCandidates('D:/app/resources/thunder/sdk'), ['D:\\app\\resources\\thunder\\sdk']);
  assert.deepEqual(sdkCandidates('C:/Program Files/Thunder Network'), []);
  assert.deepEqual(sdkCandidates('D:/app/resources/thunder'), []);
});

test('accepts a valid BTIH magnet identity and rejects malformed hashes', () => {
  const hash = '0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(parseMagnetIdentity('magnet:?xt=urn:btih:' + hash), { infoHash: hash });
  assert.throws(() => parseMagnetIdentity('magnet:?xt=urn:btih:bad'), /有效的 BTIH/);
});

test('verifies the bundled vendor SDK by its pinned DLL hashes', async () => {
  const expected = resolve('vendor/thunder/sdk');
  assert.equal(await findVerifiedSdkDirectory(expected), expected);
});
