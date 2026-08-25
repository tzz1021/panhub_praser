import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** WebUI 构建（backend 独立包；产物进 webui/dist，由 server.js 静态托管） */
export default defineConfig({
  plugins: [preact()],
  root: ROOT,
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 18789,
    // 开发模式直连 backend webui 端口（改端口后同步这里）
    proxy: {
      '/api/web': 'http://127.0.0.1:18788',
    },
  },
});
