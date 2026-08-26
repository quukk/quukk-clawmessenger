import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: fileURLToPath(
      new URL('../../packages/quukk-clawmessenger/dist/ui', import.meta.url),
    ),
    emptyOutDir: true,
  },
});
