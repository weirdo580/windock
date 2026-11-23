import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 着色器通过 Vite 的 ?raw 导入，保持 GLSL 源码独立且无需额外插件。
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome130'
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
});
