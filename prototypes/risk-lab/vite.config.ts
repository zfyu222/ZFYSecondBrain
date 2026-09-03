import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { offlineAssets, offlineShell } from "./server/offline-shell";

export default defineConfig({
  server: {
    watch: {
      ignored: ["**/.prototype-data/**"],
      followSymlinks: false,
    },
  },
  plugins: [
    react(),
    {
      name: "risk-lab-offline-shell",
      enforce: "post",
      generateBundle(_options, bundle) {
        const entry = bundle["index.html"];
        if (!entry || entry.type !== "asset")
          throw new Error("构建缺少 HTML 入口");
        const digest = createHash("sha256").update(entry.source).digest("hex");
        const shell = `offline-shell-${digest}.html`;
        this.emitFile({ type: "asset", fileName: shell, source: entry.source });
        const assets = offlineAssets([...Object.keys(bundle), shell]);
        const version = "risk-lab-" + digest;
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
