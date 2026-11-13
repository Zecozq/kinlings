import { defineConfig } from "vite";

// Relative paths, so the built game works from any folder or project site.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
});
