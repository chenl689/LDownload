import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const root = import.meta.dirname;

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, 'electron/main/index.ts'),
          'engine-worker': resolve(root, 'electron/process/engine-worker.ts'),
        },
        output: { entryFileNames: '[name].cjs', format: 'cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(root, 'electron/preload/index.ts'),
        output: { entryFileNames: 'index.cjs', format: 'cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    publicDir: resolve(root, 'icon'),
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: { outDir: resolve(root, 'out/renderer'), emptyOutDir: true },
    plugins: [react(), {
      name: 'ldownload-csp',
      transformIndexHtml(html) {
        const devSources = mode === 'development' ? " http://127.0.0.1:5173 ws://127.0.0.1:5173" : '';
        return html.replace(/connect-src 'self'[^;]*;/, `connect-src 'self'${devSources};`);
      },
    }],
  },
}));
