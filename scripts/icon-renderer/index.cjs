const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

async function rasterize(window, svgDataUrl, size) {
  const script = 'new Promise((resolve, reject) => { const image = new Image(); image.onload = () => { const canvas = document.createElement("canvas"); canvas.width = ' + size + '; canvas.height = ' + size + '; const context = canvas.getContext("2d"); context.drawImage(image, 0, 0, ' + size + ', ' + size + '); resolve(canvas.toDataURL("image/png")); }; image.onerror = () => reject(new Error("SVG failed to load")); image.src = ' + JSON.stringify(svgDataUrl) + '; })';
  const result = await window.webContents.executeJavaScript(script);
  return Buffer.from(result.slice(result.indexOf(',') + 1), 'base64');
}

function createIco(images) {
  const headerSize = 6;
  const entrySize = 16;
  const header = Buffer.alloc(headerSize + images.length * entrySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = headerSize + index * entrySize;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

function createIcns(images) {
  const typeBySize = new Map([[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']]);
  const chunks = images.map(({ size, data }) => {
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.write(typeBySize.get(size), 0, 4, 'ascii');
    chunkHeader.writeUInt32BE(data.length + chunkHeader.length, 4);
    return Buffer.concat([chunkHeader, data]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

app.whenReady().then(async () => {
  let window;
  let exitCode = 0;
  try {
    const root = process.cwd();
    const source = await fs.readFile(path.join(root, 'icon', 'app-icon.svg'), 'utf8');
    const svg = source.replace(/<svg\b/, '<svg width="1024" height="1024"');
    const svgDataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    window = new BrowserWindow({ width: 1024, height: 1024, show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await window.loadURL('data:text/html,<html><body></body></html>');
    const appImages = [];
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) appImages.push({ size, data: await rasterize(window, svgDataUrl, size) });
    await fs.writeFile(path.join(root, 'icon', 'app-icon.png'), appImages.find(image => image.size === 512).data);
    await fs.writeFile(path.join(root, 'icon', 'app-icon.ico'), createIco(appImages.filter(({ size }) => size <= 256)));
    await fs.writeFile(path.join(root, 'icon', 'app-icon.icns'), createIcns(appImages));
    for (const browser of ['chromium', 'firefox']) {
      const directory = path.join(root, 'vendor', 'browser-extension', browser, 'icons');
      await fs.mkdir(directory, { recursive: true });
      for (const size of [16, 32, 48, 128]) {
        await fs.writeFile(path.join(directory, 'app-icon-' + size + '.png'), await rasterize(window, svgDataUrl, size));
      }
    }
    console.log('Generated Windows ICO, macOS ICNS, runtime PNG, and browser extension icons from icon/app-icon.svg');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
  }
  if (exitCode) app.exit(exitCode); else app.quit();
});
