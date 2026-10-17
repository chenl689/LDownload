import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDownloadInputShape } from '../electron/core/download-input.ts';

const validInput = () => ({
  url: 'https://example.com/archive.zip',
  headers: { 'x-client': 'LDownload' },
  speedLimitBytesSec: 1024 * 1024,
});

test('accepts HTTP, HTTPS, FTP, and FTPS task input', () => {
  assert.equal(validateDownloadInputShape(validInput()).url, 'https://example.com/archive.zip');
  assert.equal(validateDownloadInputShape({ url: 'http://example.com/file' }).url, 'http://example.com/file');
  assert.equal(validateDownloadInputShape({ url: 'ftp://example.com/file' }).url, 'ftp://example.com/file');
  assert.equal(validateDownloadInputShape({ url: 'ftps://example.com/file' }).url, 'ftps://example.com/file');
});

test('rejects unsupported schemes and embedded URL credentials', () => {
  assert.throws(() => validateDownloadInputShape({ url: 'magnet:?xt=urn:btih:ABC' }), /HTTP、HTTPS、FTP 或 FTPS/);
  assert.throws(() => validateDownloadInputShape({ url: 'https://user:pass@example.com/file' }), /内嵌凭据/);
  assert.throws(() => validateDownloadInputShape({ url: '' }));
});

test('bounds filenames, directories, headers and credentials', () => {
  assert.throws(() => validateDownloadInputShape({ url: 'https://example.com', fileName: 'x'.repeat(4097) }), /文件名/);
  assert.throws(() => validateDownloadInputShape({ url: 'https://example.com', directory: 'x'.repeat(4097) }), /保存目录/);
  assert.throws(() => validateDownloadInputShape({ url: 'https://example.com', headers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['x-' + i, 'v'])) }), /请求头数量/);
  assert.throws(() => validateDownloadInputShape({ url: 'https://example.com', headers: { Cookie: 9 } }), /请求头格式/);
  assert.throws(() => validateDownloadInputShape({ url: 'https://example.com', cookie: 42 }), /凭据或头字段/);
});

test('validates security switches and checksums', () => {
  assert.throws(() => validateDownloadInputShape({ url: 'https://example.com', allowInsecureAuth: 'yes' }), /明文认证/);
  assert.throws(() => validateDownloadInputShape({ url: 'https://example.com', expectedChecksum: 'x'.repeat(129) }), /校验值/);
});

test('validates speed limits and repeat schedule input', () => {
  assert.throws(() => validateDownloadInputShape({ url: 'https://example.com', speedLimitBytesSec: -1 }), /限速/);
  assert.throws(() => validateDownloadInputShape({ url: 'https://example.com', speedLimitBytesSec: 1024 * 1024 * 1024 + 1 }), /限速/);
  assert.throws(() => validateDownloadInputShape({ url: 'https://example.com', repeatIntervalSeconds: 86_400 }), /开始时间/);
  assert.throws(() => validateDownloadInputShape({ url: 'https://example.com', scheduledAt: -1 }), /开始时间/);
});
