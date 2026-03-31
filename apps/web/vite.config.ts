import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverPort = process.env.INTELLIGENCE_DASHBOARD_PORT || process.env.PORT || "8050";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${serverPort}`
    }
  }
});
