import { createServer } from 'node:http';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));

export async function createMockRangeServer(options = {}) {
  const data = options.data || Buffer.alloc(0);
  const settings = {
    supportsRanges: options.supportsRanges !== false,
    omitValidators: options.omitValidators === true,
    unknownSize: options.unknownSize === true,
    totalBytesPerSecond: options.totalBytesPerSecond || 0,
    connectionBytesPerSecond: options.connectionBytesPerSecond || 0,
    delayMinMs: options.delayMinMs || 0,
    delayMaxMs: options.delayMaxMs || 0,
    disconnectFirstRequests: options.disconnectFirstRequests || 0,
    rejectFirstRequests: options.rejectFirstRequests || 0,
    retryAfterMs: options.retryAfterMs || 1000,
    changeEtagAfterDataRequests: options.changeEtagAfterDataRequests ?? Number.POSITIVE_INFINITY,
    ignoreRangeAfterProbe: options.ignoreRangeAfterProbe === true,
    slowFirstRangeStart: options.slowFirstRangeStart,
    slowFirstRangeBytesPerSecond: options.slowFirstRangeBytesPerSecond || 0,
    slowFirstRangeDelayMs: options.slowFirstRangeDelayMs || 0,
  };
  const stats = {
    requests: 0, dataRequests: 0, rangeRequests: 0, response429: 0, slowFirstRangeRequests: 0,
    activeDataRequests: 0, maxActiveDataRequests: 0, byRangeStart: new Map(),
  };
  let globalNextAt = Date.now();

  const currentEtag = () => stats.dataRequests > settings.changeEtagAfterDataRequests ? '"v2"' : '"v1"';
  const reserveGlobal = async bytes => {
    if (!settings.totalBytesPerSecond) return;
    const now = Date.now();
    const start = Math.max(now, globalNextAt);
    globalNextAt = start + bytes * 1000 / settings.totalBytesPerSecond;
    await sleep(start - now);
  };
  const server = createServer(async (req, res) => {
    stats.requests++;
    const etag = currentEtag();
    if (!settings.omitValidators) res.setHeader('etag', etag);
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('accept-ranges', settings.supportsRanges ? 'bytes' : 'none');
    if (req.method === 'HEAD') {
      if (!settings.unknownSize) res.setHeader('content-length', String(data.length));
      res.statusCode = 200;
      res.end();
      return;
    }

    const header = req.headers.range || '';
    const match = /^bytes=(\d+)-(\d*)$/i.exec(header);
    const probe = header === 'bytes=0-0';
    const treatAsRange = !!match && settings.supportsRanges &&
      !(settings.ignoreRangeAfterProbe && !probe);
    if (treatAsRange) stats.rangeRequests++;

    const isDataRequest = !probe;
    if (isDataRequest) {
      stats.dataRequests++;
      if (!settings.omitValidators) res.setHeader('etag', currentEtag());
      if (stats.dataRequests <= settings.rejectFirstRequests) {
        stats.response429++;
        const retryDate = new Date(Date.now() + settings.retryAfterMs).toUTCString();
        res.statusCode = 429;
        res.setHeader('retry-after', retryDate);
        res.setHeader('content-length', '0');
        res.end();
        return;
      }
    }

    if (!treatAsRange) {
      if (settings.unknownSize) {
        res.statusCode = 200;
        await streamBytes(req, res, 0, data.length - 1, false, null);
      } else {
        res.statusCode = 200;
        res.setHeader('content-length', String(data.length));
        res.end(data);
      }
      return;
    }

    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
    if (start >= data.length || end < start) {
      res.statusCode = 416;
      res.setHeader('content-range', 'bytes */' + data.length);
      res.end();
      return;
    }
    const requestedValidator = req.headers['if-range'];
    const responseValidator = currentEtag();
    if (requestedValidator && requestedValidator !== responseValidator) {
      res.statusCode = 200;
      res.setHeader('content-length', String(data.length));
      res.end(data);
      return;
    }

    // Keep the metadata probe out of data-request accounting and throttling.
    if (probe) {
      res.statusCode = 206;
      res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + data.length);
      res.setHeader('content-length', String(end - start + 1));
      res.end(data.subarray(start, end + 1));
      return;
    }

    const requestNumber = (stats.byRangeStart.get(start) || 0) + 1;
    stats.byRangeStart.set(start, requestNumber);
    const shouldDisconnect = stats.dataRequests <= settings.disconnectFirstRequests;
    const slowFirst = settings.slowFirstRangeStart === start && requestNumber === 1;
    if (slowFirst) stats.slowFirstRangeRequests++;
    if (slowFirst && settings.slowFirstRangeDelayMs) await sleep(settings.slowFirstRangeDelayMs);
    const connectionRate = slowFirst
      ? settings.slowFirstRangeBytesPerSecond
      : settings.connectionBytesPerSecond;
    const delay = settings.delayMaxMs >= settings.delayMinMs
      ? settings.delayMinMs + Math.random() * (settings.delayMaxMs - settings.delayMinMs)
      : 0;
    if (delay) await sleep(delay);

    res.statusCode = 206;
    res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + data.length);
    res.setHeader('content-length', String(end - start + 1));
    stats.activeDataRequests++;
    stats.maxActiveDataRequests = Math.max(stats.maxActiveDataRequests, stats.activeDataRequests);
    let countedClosed = false;
    const close = () => {
      if (countedClosed) return;
      countedClosed = true;
      stats.activeDataRequests = Math.max(0, stats.activeDataRequests - 1);
    };
    res.once('close', close);
    await streamBytes(req, res, start, end, shouldDisconnect, connectionRate, close);
  });

  async function streamBytes(req, res, start, end, disconnect, connectionRate, onClose = () => {}) {
    let cursor = start;
    const disconnectAt = disconnect ? Math.min(end + 1, start + Math.max(64 * 1024, Math.floor((end - start + 1) / 4))) : end + 1;
    while (cursor <= end) {
      if (req.aborted || res.destroyed) { onClose(); return; }
      const next = Math.min(end + 1, cursor + 64 * 1024, disconnectAt);
      const length = next - cursor;
      if (connectionRate) await sleep(length * 1000 / connectionRate);
      await reserveGlobal(length);
      if (req.aborted || res.destroyed) { onClose(); return; }
      if (!res.write(data.subarray(cursor, next))) {
        await new Promise(resolve => res.once('drain', resolve));
      }
      cursor = next;
      if (disconnect && cursor >= disconnectAt) {
        onClose();
        res.destroy();
        return;
      }
    }
    onClose();
    res.end();
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: 'http://127.0.0.1:' + address.port + '/download.bin',
    stats,
    close: () => new Promise(resolve => { if (!server.listening) return resolve(); server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
