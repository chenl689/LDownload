import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { downloadFtpTask, inspectFtpUrl } from '../electron/engines/ftp-engine.ts';
import { downloadEngineForUrl } from '../electron/core/download-engine.ts';

let server;
let baseUrl;
let payload;
const sockets = new Set();
const passiveServers = new Set();
const restOffsets = [];

before(async () => {
  payload = Buffer.from('FTP download payload with binary bytes.\n'.repeat(1800));
  server = createServer(control => {
    sockets.add(control);
    control.on('close', () => sockets.delete(control));
    control.on('error', () => {});
    control.write('220 Local test FTP server ready\r\n');
    let input = '';
    let passive = null;
    let dataSocket = null;
    let restartAt = 0;
    let transferPending = false;

    const beginTransfer = () => {
      if (!transferPending || !dataSocket) return;
      transferPending = false;
      const target = dataSocket;
      dataSocket = null;
      const offset = restartAt;
      restartAt = 0;
      target.end(payload.subarray(offset), () => {
        if (!control.destroyed) control.write('226 Transfer complete\r\n');
      });
    };
    const openPassive = response => {
      passive?.close();
      passive = createServer(data => {
        sockets.add(data);
        dataSocket = data;
        data.on('close', () => sockets.delete(data));
        data.on('error', () => {});
        beginTransfer();
      });
      passiveServers.add(passive);
      passive.listen(0, '127.0.0.1', () => {
        const port = passive.address().port;
        control.write(response(port));
      });
    };

    control.on('data', chunk => {
      input += chunk.toString('utf8');
      while (input.includes('\r\n')) {
        const split = input.indexOf('\r\n');
        const line = input.slice(0, split);
        input = input.slice(split + 2);
        const [verb, ...parts] = line.trim().split(/\s+/);
        const argument = parts.join(' ');
        if (verb === 'FEAT') control.write('211-Features\r\n211 End\r\n');
        else if (verb === 'USER') control.write('331 Password required\r\n');
        else if (verb === 'PASS') control.write('230 Logged in\r\n');
        else if (verb === 'TYPE' || verb === 'STRU' || verb === 'OPTS') control.write('200 OK\r\n');
        else if (verb === 'SIZE') control.write('213 ' + payload.length + '\r\n');
        else if (verb === 'MDTM') control.write('213 20261016000000\r\n');
        else if (verb === 'EPSV') openPassive(port => '229 Entering Extended Passive Mode (|||' + port + '|)\r\n');
        else if (verb === 'PASV') openPassive(port => {
          const high = Math.floor(port / 256), low = port % 256;
          return '227 Entering Passive Mode (127,0,0,1,' + high + ',' + low + ')\r\n';
        });
        else if (verb === 'REST') {
          restartAt = Number(argument) || 0;
          restOffsets.push(restartAt);
          control.write('350 Restart position accepted\r\n');
        } else if (verb === 'RETR') {
          transferPending = true;
          control.write('150 Opening data connection\r\n');
          beginTransfer();
        } else if (verb === 'QUIT') control.write('221 Bye\r\n');
        else control.write('200 OK\r\n');
      }
    });
    control.on('close', () => passive?.close());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'ftp://127.0.0.1:' + server.address().port + '/files.bin';
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  for (const passive of passiveServers) {
    if (passive.listening) await new Promise(resolve => passive.close(() => resolve()));
  }
  await new Promise(resolve => server.close(() => resolve()));
});

function task(directory, extra = {}) {
  return {
    url: baseUrl,
    fileName: 'files.bin',
    directory,
    expectedChecksum: null,
    checksumAlgorithm: 'sha256',
    speedLimitBytesSec: null,
    authScheme: 'basic',
    authUsername: null,
    authPassword: null,
    allowInsecureAuth: false,
    ...extra,
  };
}
function settings(extra = {}) {
  return { connectTimeoutSeconds: 5, maxRetries: 0, speedLimitBytesSec: 0, proxyMode: 'disabled', ...extra };
}
async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'ldownload-ftp-'));
}

test('engine registry routes ordinary protocols to their dedicated engine', () => {
  assert.equal(downloadEngineForUrl('https://example.com/file').id, 'http');
  assert.equal(downloadEngineForUrl('ftp://example.com/file').id, 'ftp');
  assert.equal(downloadEngineForUrl('ftps://example.com/file').id, 'ftp');
  assert.throws(() => downloadEngineForUrl('magnet:?xt=urn:btih:ABC'), /没有可用于该下载协议的引擎/);
});

test('FTP download writes the file, reports metadata, and verifies its checksum', async () => {
  const directory = await tempDirectory();
  try {
    const checksum = createHash('sha512').update(payload).digest('hex');
    const progress = [];
    const result = await downloadFtpTask(
      task(directory, { expectedChecksum: checksum, checksumAlgorithm: 'sha512' }),
      settings(),
      new AbortController().signal,
      value => progress.push(value),
    );
    assert.equal(result.fileName, 'files.bin');
    assert.equal(result.metadata.totalBytes, payload.length);
    assert.equal(result.metadata.supportsRanges, false);
    assert.ok(result.metadata.lastModified);
    assert.deepEqual(await readFile(join(directory, 'files.bin')), payload);
    assert.ok(progress.length > 0);
    assert.equal(await stat(join(directory, 'files.bin.ldl')).then(() => true, () => false), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('FTP pause preserves a validated partial file and resume uses REST', async () => {
  const directory = await tempDirectory();
  const originalPayload = payload;
  payload = Buffer.alloc(4 * 1024 * 1024, 0x5a);
  const controller = new AbortController();
  const downloadTask = task(directory);
  restOffsets.length = 0;
  try {
    const run = downloadFtpTask(downloadTask, settings({ speedLimitBytesSec: 128 * 1024 }), controller.signal, () => undefined);
    setTimeout(() => controller.abort(new Error('test pause')), 350);
    await assert.rejects(run, /test pause|paused|closed|socket/i);
    const partialSize = await stat(join(directory, 'files.bin.part')).then(info => info.size, () => 0);
    assert.ok(partialSize > 0 && partialSize < payload.length, 'pause should retain a partial file');
    assert.equal(await stat(join(directory, 'files.bin.ldl')).then(() => true, () => false), true);
    await downloadFtpTask(downloadTask, settings(), new AbortController().signal, () => undefined);
    assert.deepEqual(await readFile(join(directory, 'files.bin')), payload);
    assert.ok(restOffsets.includes(partialSize), 'resume should continue from the verified local offset');
  } finally {
    controller.abort();
    payload = originalPayload;
    await rm(directory, { recursive: true, force: true });
  }
});

test('FTP credentials require explicit consent when transport is not encrypted', async () => {
  await assert.rejects(
    inspectFtpUrl({ url: baseUrl, authScheme: 'basic', authUsername: 'user', authPassword: 'secret', allowInsecureAuth: false }),
    /明文发送登录凭据/,
  );
});