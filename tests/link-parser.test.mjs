import test from 'node:test';
import assert from 'node:assert/strict';
import { findIncomingLink, normalizeIncomingLink } from '../electron/core/link-parser.ts';

function thunderLink(target) {
  return 'thunder://' + Buffer.from('AA' + target + 'ZZ', 'utf8').toString('base64');
}

test('normalizes ordinary HTTP and HTTPS download links', () => {
  assert.equal(normalizeIncomingLink(' HTTPS://EXAMPLE.COM/file.zip '), 'https://example.com/file.zip');
  assert.equal(normalizeIncomingLink('http://example.com/file'), 'http://example.com/file');
  assert.equal(normalizeIncomingLink('FTP://example.com/files/a.zip'), 'ftp://example.com/files/a.zip');
  assert.equal(normalizeIncomingLink('ftps://example.com/files/a.zip'), 'ftps://example.com/files/a.zip');
});

test('preserves valid magnet links', () => {
  const magnet = 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789';
  assert.equal(normalizeIncomingLink(magnet), magnet);
});

test('decodes bundled Thunder links to ordinary and magnet links', () => {
  assert.equal(normalizeIncomingLink(thunderLink('https://example.com/file.zip')), 'https://example.com/file.zip');
  const magnet = 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789';
  assert.equal(normalizeIncomingLink(thunderLink(magnet)), magnet);
});

test('rejects malformed wrappers and unsupported protocols', () => {
  assert.equal(normalizeIncomingLink('thunder://not-base64!'), null);
  assert.equal(normalizeIncomingLink('thunder://' + Buffer.from('not-wrapped').toString('base64')), null);
  assert.equal(normalizeIncomingLink('file:///C:/example/file'), null);
  assert.equal(normalizeIncomingLink('javascript:alert(1)'), null);
});

test('limits nested protocol wrappers', () => {
  let value = 'https://example.com/file';
  for (let i = 0; i < 4; i++) value = thunderLink(value);
  assert.equal(normalizeIncomingLink(value), null);
});


test('finds supported deep links consistently in cold-start and second-instance arguments', () => {
  const magnet = 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789';
  assert.equal(findIncomingLink(['LDownload.exe', '--hidden', 'ftp://example.com/a.zip']), 'ftp://example.com/a.zip');
  assert.equal(findIncomingLink(['LDownload.exe', thunderLink(magnet)]), magnet);
  assert.equal(findIncomingLink(['LDownload.exe', 'ldownload://add?url=' + encodeURIComponent('ftps://example.com/a.zip')]), 'ftps://example.com/a.zip');
  assert.equal(findIncomingLink(['LDownload.exe', 'file:///C:/unsafe.zip']), null);
});
