import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Bind all interfaces and accept the Zerops dev subdomain so the dev server is
  // reachable over the zerops.app vantage (otherwise Vite 403s the unknown host).
  server: { host: true, allowedHosts: [".zerops.app"] },
});
