import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { downloadHttpTask, inspectHttpUrl, sanitizeDownloadFileName } from '../electron/engines/http/http-engine.ts';

const payload = Buffer.from('Range downloads must preserve every byte across parallel writers. '.repeat(300));
const dynamicPayload = Buffer.alloc(16 * 1024 * 1024);
for (let index = 0; index < dynamicPayload.length; index++) dynamicPayload[index] = index % 251;
let dynamicRanges = [];
let slotActive = 0;
let slotMaximum = 0;
let server;
let baseUrl;
let firstDisconnect = true;

function rangeResponse(req, res, file, tag = '"v1"') {
  const range = req.headers.range;
  res.setHeader('etag', tag);
  res.setHeader('content-type', 'application/octet-stream');
  if (!range) {
    res.statusCode = 200; res.setHeader('content-length', file.length); res.end(file); return;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!match) { res.statusCode = 416; res.end(); return; }
  const start = Number(match[1]), end = Math.min(Number(match[2]), file.length - 1);
  if (start >= file.length) { res.statusCode = 416; res.end(); return; }
  res.statusCode = 206;
  res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + file.length);
  res.setHeader('content-length', end - start + 1);
  res.end(file.subarray(start, end + 1));
}

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    res.setHeader('accept-ranges', path === '/no-range' ? 'none' : 'bytes');
    if (req.method === 'HEAD') {
      res.setHeader('content-length', ['/dynamic', '/slots'].includes(path) ? dynamicPayload.length : payload.length);
      res.setHeader('etag', '"v1"');
      res.setHeader('content-type', 'application/octet-stream');
      res.statusCode = path === '/head-fallback' ? 405 : 200;
      res.end(); return;
    }
    if (path === '/slots' && req.headers.range && req.headers.range !== 'bytes=0-0') {
      slotActive++; slotMaximum = Math.max(slotMaximum, slotActive);
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
      const start = Number(match?.[1] || 0), end = Math.min(Number(match?.[2] || dynamicPayload.length - 1), dynamicPayload.length - 1);
      res.statusCode = 206; res.setHeader('etag', '"v1"');
      res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + dynamicPayload.length);
      res.setHeader('content-length', end - start + 1);
      let cursor = start;
      let slotReleased = false;
      const releaseSlot = () => {
        if (slotReleased) return;
        slotReleased = true;
        slotActive--;
      };
      const interval = setInterval(() => {
        if (cursor > end) { clearInterval(interval); releaseSlot(); res.end(); return; }
        const next = Math.min(end + 1, cursor + 128 * 1024);
        res.write(dynamicPayload.subarray(cursor, next)); cursor = next;
      }, 2);
      res.on('finish', releaseSlot);
      res.on('close', () => { clearInterval(interval); releaseSlot(); }); return;
    }
    if (path === '/dynamic' && req.headers.range && req.headers.range !== 'bytes=0-0') {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
      const start = Number(match?.[1] || 0), end = Math.min(Number(match?.[2] || dynamicPayload.length - 1), dynamicPayload.length - 1);
      dynamicRanges.push({ start, end });
      res.statusCode = 206; res.setHeader('etag', '"v1"');
      res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + dynamicPayload.length);
      res.setHeader('content-length', end - start + 1);
      if (start >= dynamicPayload.length / 2) { res.end(dynamicPayload.subarray(start, end + 1)); return; }
      let cursor = start;
      const interval = setInterval(() => {
        if (cursor > end) { clearInterval(interval); res.end(); return; }
        const next = Math.min(end + 1, cursor + 64 * 1024);
        res.write(dynamicPayload.subarray(cursor, next)); cursor = next;
      }, 2);
      res.on('close', () => clearInterval(interval)); return;
    }
    if (path === '/no-range' || (path === '/range-reject-late' && req.headers.range !== 'bytes=0-0')) {
      res.statusCode = 200; res.setHeader('content-length', payload.length); res.end(payload); return;
    }
    if (path === '/changed' && req.headers.range !== 'bytes=0-0') {
      rangeResponse(req, res, payload, '"v2"'); return;
    }
    if (path === '/disconnect' && req.headers.range && req.headers.range !== 'bytes=0-0' && firstDisconnect) {
      firstDisconnect = false;
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
      const start = Number(m[1]), end = Math.min(Number(m[2]), payload.length - 1);
      res.statusCode = 206; res.setHeader('etag', '"v1"');
      res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + payload.length);
      res.setHeader('content-length', end - start + 1);
      res.write(payload.subarray(start, Math.min(end + 1, start + 17)));
      setTimeout(() => res.destroy(), 5); return;
    }
    if (path === '/slow' && req.method === 'GET' && req.headers.range !== 'bytes=0-0') {
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      const start = Number(m?.[1] || 0), end = Math.min(Number(m?.[2] || payload.length - 1), payload.length - 1);
      res.statusCode = 206; res.setHeader('etag', '"v1"');
      res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + payload.length);
      res.setHeader('content-length', end - start + 1);
      let cursor = start;
      const interval = setInterval(() => {
        if (cursor > end) { clearInterval(interval); res.end(); return; }
        const next = Math.min(end + 1, cursor + 128);
        res.write(payload.subarray(cursor, next)); cursor = next;
      }, 2);
      res.on('close', () => clearInterval(interval)); return;
    }
    rangeResponse(req, res, ['/dynamic', '/slots'].includes(path) ? dynamicPayload : payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

async function tempDirectory() { return mkdtemp(join(tmpdir(), 'ldownload-http-')); }
function settings(extra = {}) {
  return { connectTimeoutSeconds: 5, maxRetries: 2, speedLimitBytesSec: 0, autoSegmentDownloads: true, segmentsPerDownload: 4, proxyMode: 'disabled', proxyUrl: null, ...extra };
}
function task(url, directory, extra = {}) {
  return { id: 'test-task', url, fileName: 'download.bin', directory, totalBytes: null, downloadedBytes: 0, segments: [], etag: null, lastModified: null, expectedChecksum: null, checksumAlgorithm: 'sha256', ...extra };
}
async function run(url, directory, extra = {}, config = {}) {
  const progress = [];
  const result = await downloadHttpTask(task(url, directory, extra), settings(config), new AbortController().signal, value => progress.push(value));
  return { result, progress };
}

test('routes HTTP download requests through an authenticated custom proxy', async () => {
  const directory = await tempDirectory();
  const seen = [];
  const proxy = createServer();
  proxy.on('connect', (req, client, head) => {
    seen.push({ url: req.url, auth: req.headers['proxy-authorization'], method: 'CONNECT' });
    const target = server.address();
    const upstream = netConnect(target.port, '127.0.0.1');
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await new Promise(resolve => proxy.once('listening', resolve));
  const address = proxy.address();
  try {
    const url = 'http://proxy-only.invalid/file.bin';
    const proxyUrl = 'http://127.0.0.1:' + address.port;
    await downloadHttpTask(task(url, directory), settings({ proxyMode: 'custom', proxyUrl, proxyUsername: 'local-user', proxyPassword: 'local-pass', allowInsecureProxyAuth: true }), new AbortController().signal, () => undefined);
    assert.deepEqual(await readFile(join(directory, 'download.bin')), payload);
    assert.ok(seen.length >= 1, 'metadata and file requests must pass through the proxy');
    assert.ok(seen.every(item => item.auth === 'Basic ' + Buffer.from('local-user:local-pass').toString('base64')));
    assert.ok(seen.every(item => String(item.url).startsWith('proxy-only.invalid:')));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await new Promise(resolve => proxy.close(resolve));
  }
});

test('routes downloads through an authenticated SOCKS5 proxy', async () => {
  const directory = await tempDirectory();
  let connections = 0;
  let authenticated = false;
  const proxy = createNetServer(socket => {
    let stage = 0;
    let buffer = Buffer.alloc(0);
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (stage === 0) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          buffer = buffer.subarray(2 + buffer[1]);
          socket.write(Buffer.from([5, 2]));
          stage = 1;
          continue;
        }
        if (stage === 1) {
          if (buffer.length < 2) return;
          const userLength = buffer[1];
          if (buffer.length < 2 + userLength + 1) return;
          const passLengthOffset = 2 + userLength;
          const passLength = buffer[passLengthOffset];
          if (buffer.length < passLengthOffset + 1 + passLength) return;
          const username = buffer.subarray(2, passLengthOffset).toString();
          const password = buffer.subarray(passLengthOffset + 1, passLengthOffset + 1 + passLength).toString();
          authenticated = username === 'socks-user' && password === 'socks-pass';
          buffer = buffer.subarray(passLengthOffset + 1 + passLength);
          socket.write(Buffer.from([1, authenticated ? 0 : 1]));
          if (!authenticated) { socket.destroy(); return; }
          stage = 2;
          continue;
        }
        if (stage === 2) {
          if (buffer.length < 5) return;
          const atyp = buffer[3];
          const addressLength = atyp === 1 ? 4 : atyp === 4 ? 16 : buffer[4];
          const totalLength = 4 + (atyp === 3 ? 1 : 0) + addressLength + 2;
          if (buffer.length < totalLength) return;
          let host;
          if (atyp === 1) host = [...buffer.subarray(4, 8)].join('.');
          else if (atyp === 3) host = buffer.subarray(5, 5 + addressLength).toString();
          else { socket.destroy(); return; }
          const port = buffer.readUInt16BE(totalLength - 2);
          buffer = buffer.subarray(totalLength);
          const upstream = netConnect(port, host);
          upstream.once('connect', () => {
            connections++;
            socket.removeListener('data', onData);
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            if (buffer.length) upstream.write(buffer);
            socket.pipe(upstream); upstream.pipe(socket);
          });
          upstream.on('error', () => socket.destroy());
          socket.on('error', () => upstream.destroy());
          return;
        }
      }
    };
    socket.on('data', onData);
  });
  proxy.listen(0, '127.0.0.1');
  await new Promise(resolve => proxy.once('listening', resolve));
  try {
    const address = proxy.address();
    const settingsWithProxy = settings({ proxyMode: 'custom', proxyUrl: 'socks5://127.0.0.1:' + address.port, proxyUsername: 'socks-user', proxyPassword: 'socks-pass' });
    await downloadHttpTask(task(baseUrl + '/range', directory), settingsWithProxy, new AbortController().signal, () => undefined);
    assert.deepEqual(await readFile(join(directory, 'download.bin')), payload);
    assert.ok(connections > 0, 'the SOCKS5 proxy must establish the target connection');
    assert.equal(authenticated, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await new Promise(resolve => proxy.close(resolve));
  }
});

test('inspects HEAD and Range metadata and sanitizes remote filenames', async () => {
  const metadata = await inspectHttpUrl({ url: baseUrl + '/range', fileName: 'CON.txt' });
  assert.equal(metadata.supportsRanges, true);
  assert.equal(metadata.totalBytes, payload.length);
  assert.equal(metadata.fileName, '_CON.txt');
  assert.equal(sanitizeDownloadFileName('../NUL.txt'), '__NUL.txt');
});

test('downloads a range-capable file with parallel positioned writes', async () => {
  const directory = await tempDirectory();
  try {
    const { result } = await run(baseUrl + '/range', directory);
    assert.equal(result.metadata.supportsRanges, true);
    assert.deepEqual(await readFile(join(directory, 'download.bin')), payload);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('runs the scanner callback after verification but before publishing the final file', async () => {
  const directory = await tempDirectory();
  const controller = new AbortController();
  let scannedPath = '';
  try {
    const result = await downloadHttpTask(
      task(baseUrl + '/range', directory),
      settings(),
      controller.signal,
      () => undefined,
      false,
      async partialPath => {
        scannedPath = partialPath;
        assert.match(partialPath, /\.part$/);
        assert.deepEqual(await readFile(partialPath), payload);
        await assert.rejects(readFile(join(directory, 'download.bin')), { code: 'ENOENT' });
      },
    );
    assert.ok(scannedPath);
    assert.deepEqual(await readFile(join(directory, 'download.bin')), payload);
    assert.equal(result.fileName, 'download.bin');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('enforces an individual task speed limit across parallel segments', async () => {
  const limitedPayload = Buffer.alloc(256 * 1024, 23);
  const limitedServer = createServer((req, res) => {
    res.setHeader('etag', '"limited-v1"');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-type', 'application/octet-stream');
    if (req.method === 'HEAD') { res.setHeader('content-length', limitedPayload.length); res.end(); return; }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = Math.min(Number(range[2]), limitedPayload.length - 1);
      res.statusCode = 206;
      res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + limitedPayload.length);
      res.setHeader('content-length', end - start + 1);
      res.end(limitedPayload.subarray(start, end + 1)); return;
    }
    res.setHeader('content-length', limitedPayload.length); res.end(limitedPayload);
  });
  limitedServer.listen(0, '127.0.0.1');
  await new Promise(resolve => limitedServer.once('listening', resolve));
  const directory = await tempDirectory();
  const address = limitedServer.address();
  const started = Date.now();
  try {
    await downloadHttpTask(
      task('http://127.0.0.1:' + address.port + '/limited', directory, { speedLimitBytesSec: 64 * 1024 }),
      settings({ segmentsPerDownload: 4 }),
      new AbortController().signal,
      () => undefined,
    );
    assert.deepEqual(await readFile(join(directory, 'download.bin')), limitedPayload);
    assert.ok(Date.now() - started >= 2500, 'parallel segments should share the per-task token bucket');
  } finally {
    await rm(directory, { recursive: true, force: true });
    await new Promise(resolve => limitedServer.close(resolve));
  }
});

test('enforces a global connection limit across separate downloads', async () => {
  const first = await tempDirectory();
  const second = await tempDirectory();
  slotActive = 0; slotMaximum = 0;
  try {
    await Promise.all([
      run(baseUrl + '/slots', first, {}, { segmentsPerDownload: 4, maxGlobalConnections: 1 }),
      run(baseUrl + '/slots', second, {}, { segmentsPerDownload: 4, maxGlobalConnections: 1 }),
    ]);
    assert.deepEqual(await readFile(join(first, 'download.bin')), dynamicPayload);
    assert.deepEqual(await readFile(join(second, 'download.bin')), dynamicPayload);
    assert.equal(slotMaximum, 1, 'only one range request should be active across both tasks');
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('starts fixed primary ranges and keeps the visible segment count stable', async () => {
  const directory = await tempDirectory();
  dynamicRanges = [];
  try {
    const { progress } = await run(baseUrl + '/dynamic', directory, {}, {
      segmentsPerDownload: 2, maxGlobalConnections: 2,
      adaptiveConfig: { initialConcurrency: 2, maxConcurrency: 2, minChunkBytes: 1024 * 1024 },
    });
    assert.deepEqual(await readFile(join(directory, 'download.bin')), dynamicPayload);
    assert.deepEqual(dynamicRanges.slice(0, 2).sort((left, right) => left.start - right.start), [
      { start: 0, end: dynamicPayload.length / 2 - 1 },
      { start: dynamicPayload.length / 2, end: dynamicPayload.length - 1 },
    ], 'the selected two primary ranges should cover the whole file before stealing begins');
    assert.ok(progress.every(item => item.segments.length === 2), 'the visible segment count should match the selected primary range count');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('falls back to one connection when the server ignores Range', async () => {
  const directory = await tempDirectory();
  try {
    const { result } = await run(baseUrl + '/no-range', directory);
    assert.equal(result.metadata.supportsRanges, false);
    assert.deepEqual(await readFile(join(directory, 'download.bin')), payload);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('falls back to one connection if Range stops working after the probe', async () => {
  const directory = await tempDirectory();
  try {
    const { result } = await run(baseUrl + '/range-reject-late', directory);
    assert.equal(result.metadata.supportsRanges, true);
    assert.deepEqual(await readFile(join(directory, 'download.bin')), payload);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('resumes a segment after a mid-stream disconnect', async () => {
  const directory = await tempDirectory(); firstDisconnect = true;
  try {
    await run(baseUrl + '/disconnect', directory);
    assert.deepEqual(await readFile(join(directory, 'download.bin')), payload);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rejects changed remote validators before resuming data', async () => {
  const directory = await tempDirectory();
  try {
    await assert.rejects(run(baseUrl + '/changed', directory), /远端文件已变化/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('downloads slowly streamed data and emits bounded progress snapshots', async () => {
  const directory = await tempDirectory();
  try {
    const { progress } = await run(baseUrl + '/slow', directory, {}, { segmentsPerDownload: 1 });
    assert.ok(progress.length > 0);
    assert.deepEqual(await readFile(join(directory, 'download.bin')), payload);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pause leaves a validated .ldl checkpoint and resume completes it', async () => {
  const directory = await tempDirectory();
  const controller = new AbortController();
  const state = task(baseUrl + '/slow', directory);
  try {
    const paused = downloadHttpTask(state, settings({ segmentsPerDownload: 1 }), controller.signal, () => undefined);
    setTimeout(() => controller.abort(new Error('test pause')), 150);
    await assert.rejects(paused);
    assert.ok(await readFile(join(directory, 'download.bin.ldl'), 'utf8'));
    await run(baseUrl + '/slow', directory, {}, { segmentsPerDownload: 1 });
    assert.deepEqual(await readFile(join(directory, 'download.bin')), payload);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('does not overwrite an existing file', async () => {
  const directory = await tempDirectory();
  try {
    await writeFile(join(directory, 'download.bin'), 'keep');
    await assert.rejects(run(baseUrl + '/range', directory), /目标文件已存在/);
    assert.equal(await readFile(join(directory, 'download.bin'), 'utf8'), 'keep');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
