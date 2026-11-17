import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    proxy: {
      "/catalog/arizona": {
        target: "https://arizona-ping.react.group",
        changeOrigin: true,
        rewrite: () => "/desktop/ping/Arizona/ping.json",
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
});
