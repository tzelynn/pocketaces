import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // relative base: works at the domain root and under a GitHub Pages project path
  base: "./",
  // `npm run dev:api` runs the Worker (accounts + sync) on :8787
  server: { proxy: { "/api": { target: "http://localhost:8787", ws: true } } },
  define: { __BUILT_AT__: JSON.stringify(new Date().toISOString()) },
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: false,
      injectManifest: { globPatterns: ["**/*.{js,css,html,svg,png,json}"] },
      manifest: {
        name: "pocket aces",
        short_name: "pocket aces",
        description: "Pick the right credit card, and keep track of bills, fees and spend.",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#f6f3ec",
        theme_color: "#1f5c4d",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  test: { environment: "node" },
});
