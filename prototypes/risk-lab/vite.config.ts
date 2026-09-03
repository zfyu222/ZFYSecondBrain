import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { offlineAssets, offlineShell } from "./server/offline-shell";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "risk-lab-offline-shell",
      generateBundle(_options, bundle) {
        const assets = offlineAssets(Object.keys(bundle));
        const version = "risk-lab-" + Date.now();
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: offlineShell(version, assets),
        });
      },
    },
  ],
  build: { chunkSizeWarningLimit: 1200 },
});
