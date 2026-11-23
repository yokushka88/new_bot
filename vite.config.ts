import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run build` — збірка застосунку магазину в dist/. Сторінки /s/<slug> віддає server.mjs.
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: { host: true, port: 5173, proxy: { '/api': 'http://localhost:3000', '/media': 'http://localhost:3000' } },
  build: { outDir: 'dist' },
});
