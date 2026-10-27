import { defineConfig } from "vite";

export default defineConfig({
  server: { fs: { allow: [".."] } },
  worker: { format: "es" },
  build: { target: "es2022" },
});
