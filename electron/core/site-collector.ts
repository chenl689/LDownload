import type { SiteCollectionProject } from '../../src/shared/contracts';

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_FOUND_LINKS = 1000;
const MAX_FRONTIER = 2000;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_ROBOTS_RULES = 5000;
const REQUEST_INTERVAL_MS = 500;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'LDownload/3.0';

interface RobotsRule { allow: boolean; pattern: string }
interface RobotsGroup { agents: string[]; rules: RobotsRule[] }
export interface RobotsPolicy { rules: RobotsRule[]; denyAll: boolean }

function sameOrigin(root: URL, candidate: URL): boolean {
  return root.protocol === candidate.protocol && root.hostname.toLowerCase() === candidate.hostname.toLowerCase() &&
    root.port === candidate.port;
}

function safeHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('采集已停止'));
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolveDelay(); }, ms);
    const abort = () => { clearTimeout(timer); rejectDelay(signal.reason || new Error('采集已停止')); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function readLimited(response: Response, maximum: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximum) throw new Error('网页响应超过 2 MiB 限制');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.length;
      if (total > maximum) { await reader.cancel(); throw new Error('网页响应超过大小限制'); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

async function fetchSameOriginText(start: URL, target: URL, signal: AbortSignal, maxBytes: number): Promise<{ response: Response; url: URL; body: string }> {
  let url = target;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (!sameOrigin(start, url)) throw new Error('网页重定向超出起始站点范围');
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html, text/plain;q=0.9, */*;q=0.1' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirects === MAX_REDIRECTS) throw new Error('网页重定向次数超出限制');
      const next = safeHttpUrl(new URL(location, url).href);
      if (!next || !sameOrigin(start, next)) throw new Error('网页重定向超出起始站点范围');
      url = next;
      continue;
    }
    const data = await readLimited(response, maxBytes);
    return { response, url, body: new TextDecoder('utf-8', { fatal: false }).decode(data) };
  }
  throw new Error('网页重定向次数超出限制');
}

export function parseRobotsPolicy(text: string): RobotsPolicy {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup = { agents: [], rules: [] };
  let hasDirective = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#', 1)[0]?.trim() || '';
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      if (hasDirective && current.agents.length) { groups.push(current); current = { agents: [], rules: [] }; hasDirective = false; }
      const agent = value.split(/\s+/, 1)[0]?.toLowerCase() || '';
      if (agent && current.agents.length < 32) current.agents.push(agent);
    } else if ((key === 'allow' || key === 'disallow') && current.agents.length && value &&
      value.length <= 2048 && current.rules.length < MAX_ROBOTS_RULES) {
      current.rules.push({ allow: key === 'allow', pattern: value });
      hasDirective = true;
    }
  }
  if (current.agents.length) groups.push(current);
  const exact = groups.filter(group => group.agents.includes('ldownload'));
  const selected = exact.length ? exact : groups.filter(group => group.agents.includes('*'));
  return { rules: selected.flatMap(group => group.rules).slice(0, MAX_ROBOTS_RULES), denyAll: false };
}

function patternMatches(pattern: string, target: string): boolean {
  const endAnchored = pattern.endsWith('$');
  const source = endAnchored ? pattern.slice(0, -1) : pattern;
  let p = 0, t = 0;
  let star: [number, number] | null = null;
  while (t < target.length) {
    if (p === source.length && !endAnchored) return true;
    if (source[p] === '*') { star = [p + 1, t]; p++; }
    else if (source[p] === target[t]) { p++; t++; }
    else if (star) {
      const afterStar: number = star[0]; const matched: number = star[1];
      if (matched >= target.length) return false;
      star = [afterStar, matched + 1]; p = afterStar; t = matched + 1;
    } else return false;
  }
  while (source[p] === '*') p++;
  return p === source.length;
}

export function robotsAllows(policy: RobotsPolicy, value: string): boolean {
  if (policy.denyAll) return false;
  const url = safeHttpUrl(value);
  if (!url) return false;
  const target = url.pathname + (url.search || '');
  let best: { specificity: number; allow: boolean } | null = null;
  for (const rule of policy.rules) {
    if (!patternMatches(rule.pattern, target)) continue;
    const specificity = rule.pattern.replace(/[*$]/g, '').length;
    if (!best || specificity > best.specificity || (specificity === best.specificity && rule.allow && !best.allow))
      best = { specificity, allow: rule.allow };
  }
  return best?.allow ?? true;
}

export function extractPageLinks(html: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const tagPattern = /<(?:a|area|iframe|frame|source|img|link|script|video|audio)\b[^>]*>/gi;
  const attrPattern = /\b(?:href|src|data|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const tag of html.match(tagPattern) || []) {
    attrPattern.lastIndex = 0;
    for (let match = attrPattern.exec(tag); match; match = attrPattern.exec(tag)) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? '').split(',')[0]?.trim() || '';
      const decoded = raw.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
        .replace(/&#x2f;/gi, '/').replace(/&#47;/g, '/');
      if (decoded && !seen.has(decoded)) { seen.add(decoded); links.push(decoded); }
    }
  }
  return links;
}

async function fetchRobots(origin: URL, signal: AbortSignal): Promise<RobotsPolicy> {
  const robotsUrl = new URL('/robots.txt', origin);
  try {
    const { response, body } = await fetchSameOriginText(origin, robotsUrl, signal, MAX_ROBOTS_BYTES);
    if (response.status === 401 || response.status === 403) return { rules: [], denyAll: true };
    if (response.status === 429 || response.status === 408 || response.status >= 500)
      throw new Error('robots.txt 返回 HTTP ' + response.status + '；采集已暂停，可稍后重试');
    if (!response.ok && ![404, 410].includes(response.status) && response.status < 500) return { rules: [], denyAll: true };
    if (response.status === 404 || response.status === 410 || !response.ok) return { rules: [], denyAll: false };
    return parseRobotsPolicy(body);
  } catch (error) {
    if (signal.aborted) return { rules: [], denyAll: true };
    throw error;
  }
}

function pageLike(path: string): boolean {
  const name = path.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  if (!name || dot < 0) return true;
  const extension = name.slice(dot + 1).toLowerCase();
  return ['html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'cgi'].includes(extension);
}

function extensionOf(path: string): string {
  const name = path.split('/').pop() || '';
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index + 1).toLowerCase();
}

function excluded(project: SiteCollectionProject, url: string): boolean {
  const normalized = url.toLowerCase();
  return project.excludePatterns.some(pattern => pattern && normalized.includes(pattern.toLowerCase()));
}

function included(project: SiteCollectionProject, url: string): boolean {
  return !project.includePatterns.length || project.includePatterns.some(pattern => pattern && url.toLowerCase().includes(pattern.toLowerCase()));
}

function matchesFileRules(project: SiteCollectionProject, path: string): boolean {
  if (pageLike(path)) return false;
  if (!project.fileExtensions.length) return true;
  const extension = extensionOf(path);
  return Boolean(extension && project.fileExtensions.some(value => value.replace(/^\./, '').toLowerCase() === extension));
}

export async function runSiteCollection(
  input: SiteCollectionProject,
  signal: AbortSignal,
  onProgress: (project: SiteCollectionProject) => void,
): Promise<SiteCollectionProject> {
  const project: SiteCollectionProject = {
    ...input,
    frontier: input.frontier.map(page => ({ ...page })),
    visitedPages: [...input.visitedPages],
    foundLinks: [...input.foundLinks],
  };
  const origin = safeHttpUrl(project.startUrl);
  if (!origin) throw new Error('起始地址必须是有效的 HTTP 或 HTTPS 网页');
  const robots = await fetchRobots(origin, signal);
  const visited = new Set(project.visitedPages);
  const found = new Set(project.foundLinks);
  const frontier = [...project.frontier];
  let pagesThisRun = 0;
  let lastRequest = Date.now();

  const publish = (status: SiteCollectionProject['status'], error: string | null = null) => {
    project.frontier = [...frontier];
    project.visitedPages = [...visited].sort();
    project.foundLinks = [...found].sort();
    project.status = status;
    project.error = error;
    project.updatedAt = Date.now();
    onProgress({ ...project, frontier: [...project.frontier], visitedPages: [...project.visitedPages], foundLinks: [...project.foundLinks] });
  };

  while (frontier.length) {
    if (signal.aborted) { publish('stopped'); return project; }
    const page = frontier.shift()!;
    if (visited.has(page.url) || !robotsAllows(robots, page.url)) { publish('running'); continue; }
    if (pagesThisRun >= project.pageLimit || found.size >= MAX_FOUND_LINKS) {
      frontier.unshift(page); publish('idle'); return project;
    }
    try {
      await delay(Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastRequest)), signal);
      lastRequest = Date.now();
      const target = safeHttpUrl(page.url);
      if (!target || !sameOrigin(origin, target)) continue;
      const { response, url, body } = await fetchSameOriginText(origin, target, signal, MAX_PAGE_BYTES);
      if (response.status === 429 || response.status === 408 || response.status >= 500)
        throw new Error('网页返回 HTTP ' + response.status + '；采集已暂停，可稍后重试');
      visited.add(page.url);
      pagesThisRun++;
      if (response.ok && /text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) {
        for (const raw of extractPageLinks(body)) {
          if (found.size >= MAX_FOUND_LINKS) break;
          const link = safeHttpUrl(new URL(raw, url).href);
          if (!link || !sameOrigin(origin, link) || excluded(project, link.href) || !robotsAllows(robots, link.href)) continue;
          const normalized = link.href;
          if (page.depth < project.maxDepth && pageLike(link.pathname)) {
            if (!visited.has(normalized) && !frontier.some(item => item.url === normalized) && frontier.length < MAX_FRONTIER)
              frontier.push({ url: normalized, depth: page.depth + 1 });
          } else if (matchesFileRules(project, link.pathname) && included(project, normalized)) found.add(normalized);
        }
      }
      publish('running');
    } catch (error) {
      if (signal.aborted) { frontier.unshift(page); publish('stopped'); return project; }
      frontier.unshift(page);
      publish('failed', error instanceof Error ? error.message : String(error));
      return project;
    }
  }
  publish('completed');
  return project;
}
