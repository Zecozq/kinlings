// Builds the game and its test pages together, for frozen copies used in checks.
import { defineConfig } from "vite";
import { resolve } from "node:path";

const here = import.meta.dirname;
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(here, "index.html"),
        race: resolve(here, "race-test.html"),
      },
    },
  },
});
