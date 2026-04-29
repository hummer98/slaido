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
      "assets/templates/reveal/index.html": "Resources/templates/reveal/index.html",
      "assets/templates/reveal/opencode.json": "Resources/templates/reveal/opencode.json",
      "assets/templates/reveal/AGENTS.md": "Resources/templates/reveal/AGENTS.md",
      "assets/templates/reveal/LICENSE": "Resources/templates/reveal/LICENSE",
      "assets/templates/reveal/VERSION.txt": "Resources/templates/reveal/VERSION.txt",
      "assets/templates/reveal/dist/reset.css": "Resources/templates/reveal/dist/reset.css",
      "assets/templates/reveal/dist/reveal.css": "Resources/templates/reveal/dist/reveal.css",
      "assets/templates/reveal/dist/reveal.js": "Resources/templates/reveal/dist/reveal.js",
      "assets/templates/reveal/dist/theme/black.css": "Resources/templates/reveal/dist/theme/black.css",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro.css": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro.css",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-regular.eot": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-regular.eot",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-regular.ttf": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-regular.ttf",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-regular.woff": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-regular.woff",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-italic.eot": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-italic.eot",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-italic.ttf": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-italic.ttf",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-italic.woff": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-italic.woff",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-semibold.eot": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-semibold.eot",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-semibold.ttf": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-semibold.ttf",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-semibold.woff": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-semibold.woff",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-semibolditalic.eot": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-semibolditalic.eot",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-semibolditalic.ttf": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-semibolditalic.ttf",
      "assets/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-semibolditalic.woff": "Resources/templates/reveal/dist/theme/fonts/source-sans-pro/source-sans-pro-semibolditalic.woff",
      "bin/darwin-arm64/opencode": "bin/darwin-arm64/opencode",
      "bin/darwin-x64/opencode": "bin/darwin-x64/opencode",
    },
  },
} satisfies ElectrobunConfig;
