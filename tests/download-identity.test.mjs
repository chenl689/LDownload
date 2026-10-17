import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadSourceIdentity, findDuplicateDownloadSource } from '../src/shared/download-identity.ts';

test('canonicalizes ordinary download URLs and ignores fragments', () => {
  assert.equal(downloadSourceIdentity('HTTP://EXAMPLE.COM:80/file.bin#first'), 'http://example.com/file.bin');
  assert.equal(downloadSourceIdentity('https://example.com:443/file.bin#second'), 'https://example.com/file.bin');
});

test('finds an existing ordinary task by normalized source URL', () => {
  const existing = { url: 'https://EXAMPLE.com:443/file.bin#old', fileName: 'file.bin', status: 'completed' };
  assert.equal(findDuplicateDownloadSource([existing], 'https://example.com/file.bin'), existing);
  assert.equal(findDuplicateDownloadSource([existing], 'https://example.com/other.bin'), undefined);
});

test('keeps query strings in download identity', () => {
  const existing = { url: 'https://example.com/file.bin?token=one' };
  assert.equal(findDuplicateDownloadSource([existing], 'https://example.com/file.bin?token=two'), undefined);
});
