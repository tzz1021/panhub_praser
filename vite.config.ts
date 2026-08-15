import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base:'./' —— 相对路径构建，支持任意静态托管（GitHub Pages 等）
export default defineConfig({
  base: './',
  plugins: [react()],
});
