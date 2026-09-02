import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    // In sviluppo il pannello gira su 5174 e la sua API su 781: il proxy fa sì
    // che il cookie di sessione resti same-origin, come in produzione.
    proxy: { '/api': { target: 'http://localhost:781', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
