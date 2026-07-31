import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The backend holds UNLINK_API_KEY_ARC_TESTNET and CIRCLE_APP_KIT_KEY, so it is a
// separate origin in development. Proxy /api to it to keep the browser bundle free
// of any credential and free of CORS configuration.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
