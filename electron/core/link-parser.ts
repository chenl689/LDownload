export function findIncomingLink(arguments_: Iterable<string>): string | null {
  for (const argument of arguments_) {
    const normalized = normalizeIncomingLink(argument);
    if (normalized) return normalized;
  }
  return null;
}

export function normalizeIncomingLink(raw: string, depth = 0): string | null {
  if (!raw || raw.length > 16_384 || depth > 3) return null;
  const value = raw.trim();
  if (/^magnet:/i.test(value)) return value.length <= 8192 ? value : null;
  if (/^thunder:\/\//i.test(value)) {
    const encoded = value.slice(value.indexOf('//') + 2);
    if (encoded.length > 12_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      if (!decoded.startsWith('AA') || !decoded.endsWith('ZZ')) return null;
      return normalizeIncomingLink(decoded.slice(2, -2), depth + 1);
    } catch { return null; }
  }
  try {
    const url = new URL(value);
    if (['http:', 'https:', 'ftp:', 'ftps:'].includes(url.protocol) && !url.username && !url.password) return url.href;
    if (url.protocol === 'ldownload:') {
      const target = url.searchParams.get('url') || url.searchParams.get('link');
      return target ? normalizeIncomingLink(target, depth + 1) : null;
    }
  } catch { /* Invalid protocol URLs are ignored. */ }
  return null;
}
