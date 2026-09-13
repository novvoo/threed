import { defineConfig } from 'vite';
import { tripoSplatPlugin } from './vite-plugin-triposplat.js';

export default defineConfig({
  plugins: [tripoSplatPlugin()],
  server: { port: 5180 },
  build: {
    // WebGPU/TSL 产物较大，放宽提示阈值
    chunkSizeWarningLimit: 2000,
  },
});
