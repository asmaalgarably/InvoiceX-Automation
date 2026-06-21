import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: [".trycloudflare.com", ".loca.lt"],
    proxy: {
      "/api": "http://localhost:8787"
    }
  }
});
