import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API is proxied under /api so the browser stays same-origin (no CORS needed).
// Point it elsewhere with GARUDA_API_PROXY (e.g. the stub server on another port).
const api = process.env.GARUDA_API_PROXY ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  define: { global: "globalThis" },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { "/api": { target: api, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } },
  },
  preview: { port: Number(process.env.WEB_PORT ?? 4173), proxy: { "/api": { target: api, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } } },
  optimizeDeps: { include: ["@solana/web3.js", "@solana/spl-token", "buffer"] },
  build: { chunkSizeWarningLimit: 1500 },
});
