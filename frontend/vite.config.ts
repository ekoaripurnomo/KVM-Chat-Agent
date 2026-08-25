import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend never talks to the LLM or MCP directly. It only calls /api,
// which is proxied to the backend during development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
