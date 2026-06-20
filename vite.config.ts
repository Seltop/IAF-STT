import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const basePath = readBasePath(process.env.PUBLIC_BASE_PATH || process.env.BASE_PATH);

export default defineConfig({
  base: basePath ? `${basePath}/` : "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true
      }
    }
  },
  test: {
    environment: "node",
    globals: true
  }
});

function readBasePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}
