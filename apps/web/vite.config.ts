import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En desarrollo el front usa `/graphql` relativo y el proxy de Vite lo reenvía (HTTP y WS)
// al BFF. `BFF_PROXY_TARGET` permite apuntar a otro host sin tocar el código.
const bffTarget = process.env.BFF_PROXY_TARGET ?? 'http://localhost:4000';
const port = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port,
    strictPort: true,
    proxy: {
      '/graphql': { target: bffTarget, changeOrigin: true, ws: true },
    },
  },
  preview: { port },
  // CodeMirror (con C++ y Python) pesa ~570 kB y va en su propio chunk diferido.
  build: { sourcemap: true, chunkSizeWarningLimit: 600 },
});
