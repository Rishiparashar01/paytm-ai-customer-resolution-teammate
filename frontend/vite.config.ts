import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend API base is 100% env-driven (VITE_API_BASE_URL) — never a
// hardcoded production URL. See src/api/client.ts.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
});
