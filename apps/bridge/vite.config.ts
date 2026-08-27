import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(
      new URL('../../packages/quukk-clawmessenger/dist/ui', import.meta.url),
    ),
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
  },
});
