import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        schema: "schema.html",
        replay: "replay.html"
      }
    }
  }
});
