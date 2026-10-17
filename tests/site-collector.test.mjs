import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { extractPageLinks, parseRobotsPolicy, robotsAllows, runSiteCollection } from '../electron/core/site-collector.ts';

let server;
let baseUrl;
let visited = [];

before(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    if (path === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('User-agent: *\nDisallow: /private\nAllow: /private/open.pdf\n');
      return;
    }
    visited.push(path);
    if (path === '/start') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<a href="/page">Page</a><a href="/public/a.zip">Archive</a><a href="/private/no.pdf">Blocked</a><a href="https://elsewhere.invalid/public/remote.zip">External</a><a href="/skip/file.zip">Excluded</a>');
      return;
    }
    if (path === '/page') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end("<a href='/public/book.PDF?download=1'>Book</a><img src='/public/cover.png'>");
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

function project(extra = {}) {
  return {
    id: 'project-1', startUrl: baseUrl + '/start', maxDepth: 2, pageLimit: 10,
    includePatterns: ['/public'], excludePatterns: ['/skip'], fileExtensions: ['zip', 'pdf'],
    frontier: [{ url: baseUrl + '/start', depth: 0 }], visitedPages: [], foundLinks: [],
    status: 'idle', error: null, createdAt: 1, updatedAt: 1, ...extra,
  };
}

test('parses robots allow rules and honors the most specific match', () => {
  const policy = parseRobotsPolicy('User-agent: *\nDisallow: /private*\nAllow: /private/public$\n');
  assert.equal(robotsAllows(policy, 'https://example.test/private/secret'), false);
  assert.equal(robotsAllows(policy, 'https://example.test/private/public'), true);
  assert.equal(robotsAllows(policy, 'https://example.test/open'), true);
});

test('extracts static HTML links and decodes common entities', () => {
  assert.deepEqual(extractPageLinks('<a href="/a?x=1&amp;y=2">A</a><img src="/cover.png">'), ['/a?x=1&y=2', '/cover.png']);
});

test('collects bounded same-origin file links while respecting robots and patterns', async () => {
  visited = [];
  const output = await runSiteCollection(project(), new AbortController().signal, () => undefined);
  assert.equal(output.status, 'completed');
  assert.deepEqual(output.visitedPages, [baseUrl + '/page', baseUrl + '/start'].sort());
  assert.deepEqual(output.foundLinks, [baseUrl + '/public/a.zip', baseUrl + '/public/book.PDF?download=1'].sort());
  assert.ok(!visited.includes('/private/no.pdf'));
});

test('stopping during the per-host delay preserves the unvisited frontier', async () => {
  const controller = new AbortController();
  const run = runSiteCollection(project(), controller.signal, () => undefined);
  setTimeout(() => controller.abort(new Error('user stop')), 80);
  const output = await run;
  assert.equal(output.status, 'stopped');
  assert.equal(output.frontier[0]?.url, baseUrl + '/start');
});
