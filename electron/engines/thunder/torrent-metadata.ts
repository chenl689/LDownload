import { createHash } from 'node:crypto';

type BValue =
  | { kind: 'bytes'; value: Buffer; start: number; end: number }
  | { kind: 'integer'; value: bigint; start: number; end: number }
  | { kind: 'list'; values: BValue[]; start: number; end: number }
  | { kind: 'dictionary'; values: Map<string, BValue>; start: number; end: number };

export interface ThunderTorrentMetadata {
  infoHash: string;
  name: string;
  totalBytes: number;
  isMultiFile: boolean;
  files: Array<{ index: number; path: string; components: string[]; size: number }>;
}

class BencodeReader {
  private offset = 0;
  private nodes = 0;
  private readonly bytes: Buffer;
  constructor(bytes: Buffer) { this.bytes = bytes; }

  parse(): BValue {
    const root = this.read(0);
    if (this.offset !== this.bytes.length) throw new Error('种子文件包含额外数据');
    return root;
  }

  private read(depth: number): BValue {
    if (depth > 64 || ++this.nodes > 100_000 || this.offset >= this.bytes.length) throw new Error('种子元数据结构超出限制');
    const start = this.offset;
    const marker = this.bytes[this.offset++];
    if (marker === undefined) throw new Error('种子元数据结构不完整');
    if (marker === 0x69) {
      const end = this.bytes.indexOf(0x65, this.offset);
      if (end < 0 || end - this.offset > 32) throw new Error('种子元数据中的整数无效');
      const text = this.bytes.toString('ascii', this.offset, end);
      if (!/^-?(0|[1-9]\d*)$/.test(text)) throw new Error('种子元数据中的整数格式无效');
      this.offset = end + 1;
      return { kind: 'integer', value: BigInt(text), start, end: this.offset };
    }
    if (marker === 0x6c) {
      const values: BValue[] = [];
      while (this.bytes[this.offset] !== 0x65) {
        if (this.offset >= this.bytes.length) throw new Error('种子元数据列表不完整');
        values.push(this.read(depth + 1));
      }
      this.offset++;
      return { kind: 'list', values, start, end: this.offset };
    }
    if (marker === 0x64) {
      const values = new Map<string, BValue>();
      while (this.bytes[this.offset] !== 0x65) {
        if (this.offset >= this.bytes.length) throw new Error('种子元数据字典不完整');
        const key = this.readBytes();
        const keyText = key.value.toString('utf8');
        if (values.has(keyText)) throw new Error('种子元数据含重复字段');
        values.set(keyText, this.read(depth + 1));
      }
      this.offset++;
      return { kind: 'dictionary', values, start, end: this.offset };
    }
    if (marker >= 0x30 && marker <= 0x39) {
      this.offset = start;
      return this.readBytes();
    }
    throw new Error('种子元数据编码无效');
  }

  private readBytes(): Extract<BValue, { kind: 'bytes' }> {
    const start = this.offset;
    const colon = this.bytes.indexOf(0x3a, this.offset);
    if (colon < 0 || colon - this.offset > 12) throw new Error('种子元数据中的字符串长度无效');
    const lengthText = this.bytes.toString('ascii', this.offset, colon);
    if (!/^(0|[1-9]\d*)$/.test(lengthText)) throw new Error('种子元数据中的字符串长度格式无效');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length < 0 || colon + 1 + length > this.bytes.length) throw new Error('种子元数据字符串超出文件范围');
    this.offset = colon + 1 + length;
    return { kind: 'bytes', value: this.bytes.subarray(colon + 1, this.offset), start, end: this.offset };
  }
}

function dictionary(value: BValue | undefined, label: string): Map<string, BValue> {
  if (!value || value.kind !== 'dictionary') throw new Error(`种子元数据缺少 ${label} 字典`);
  return value.values;
}

function bytes(value: BValue | undefined, label: string): Buffer {
  if (!value || value.kind !== 'bytes') throw new Error(`种子元数据缺少 ${label}`);
  return value.value;
}

function integer(value: BValue | undefined, label: string): number {
  if (!value || value.kind !== 'integer' || value.value < 0n || value.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`种子元数据中的 ${label} 数值无效`);
  }
  return Number(value.value);
}

function safeComponent(value: Buffer): string {
  const component = value.toString('utf8').normalize('NFC');
  if (!component || component === '.' || component === '..' || /[\\/:\0<>"|?*]/.test(component) || /[. ]$/.test(component) || component.length > 255 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component)) {
    throw new Error('种子元数据包含不安全的文件路径');
  }
  return component;
}

export function parseThunderTorrent(data: Buffer): ThunderTorrentMetadata {
  if (!data.length || data.length > 16 * 1024 * 1024) throw new Error('种子文件大小超出支持范围');
  const root = dictionary(new BencodeReader(data).parse(), '根');
  const info = dictionary(root.get('info'), 'info');
  const infoNode = root.get('info')!;
  const nameValue = info.get('name.utf-8') ?? info.get('name');
  const name = safeComponent(bytesValue(nameValue, 'name'));
  const files: ThunderTorrentMetadata['files'] = [];
  const multiFiles = info.get('files');
  if (multiFiles) {
    if (multiFiles.kind !== 'list' || multiFiles.values.length > 20_000) throw new Error('种子文件清单无效或过大');
    for (const [index, item] of multiFiles.values.entries()) {
      const entry = dictionary(item, 'files');
      if (entry.get('attr')?.kind === 'bytes' && (entry.get('attr') as Extract<BValue, { kind: 'bytes' }>).value.includes(0x70)) {
        throw new Error('种子文件清单包含符号链接');
      }
      const length = integer(entry.get('length'), 'length');
      const pathNode = entry.get('path.utf-8') ?? entry.get('path');
      if (!pathNode || pathNode.kind !== 'list' || pathNode.values.length === 0 || pathNode.values.length > 64) throw new Error('种子文件路径无效');
      const components = pathNode.values.map(part => safeComponent(bytes(part, 'path')));
      files.push({ index, path: components.join('/'), components, size: length });
    }
  } else {
    files.push({ index: 0, path: name, components: [name], size: integer(info.get('length'), 'length') });
  }
  const totalBytes = files.reduce((sum, file) => {
    const next = sum + file.size;
    if (!Number.isSafeInteger(next)) throw new Error('种子文件总大小超出支持范围');
    return next;
  }, 0);
  const hash = createHash('sha1').update(data.subarray(infoNode.start, infoNode.end)).digest('hex');
  return { infoHash: hash, name, totalBytes, isMultiFile: Boolean(multiFiles), files };
}

function bytesValue(value: BValue | undefined, label: string): Buffer {
  return bytes(value, label);
}
