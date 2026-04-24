import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "slAIdo",
    identifier: "dev.slaido.app",
    version: "0.1.0",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
    },
  },
} satisfies ElectrobunConfig;
