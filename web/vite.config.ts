import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Injected build marker — surfaced in the nerd HUD + login easter-egg.
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    // Allow any host to reach the Vite dev server (it sits behind the Zerops
    // subdomain proxy; the DNS-rebind guard isn't meaningful here).
    allowedHosts: true,
  },
});
