import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "slAIdo",
    identifier: "dev.slaido.app",
    version: "0.2.0",
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
    mac: {
      // codesign: Electrobun が helper / launcher / framework / dmg まで全署名する。
      //   `ELECTROBUN_DEVELOPER_ID` env が必要（"Developer ID Application: ..."）。
      // notarize: false に固定。公証は Electrobun ではなく fastlane の
      //   `notarize_app` lane に外出し（fastlane/Fastfile 参照）。
      //   理由: ~/git/.envrc が fastlane 流の APP_STORE_CONNECT_API_KEY_*
      //   を持っており、PEM の path 化を fastlane の app_store_connect_api_key
      //   action に任せると tempfile 管理が完結する。詳細は docs/signing-setup.md。
      codesign: true,
      notarize: false,
      createDmg: true,
      entitlements: {
        // Bun runtime の JIT に必要（hardened runtime 下でも JIT を許可）
        "com.apple.security.cs.allow-jit": true,
        // bun の動的コード生成に必要
        "com.apple.security.cs.allow-unsigned-executable-memory": true,
        // node-gyp 系の動的ライブラリ読み込みに必要
        "com.apple.security.cs.disable-library-validation": true,
      },
      // App icon: assets/icon.iconset を整備したら icons プロパティを追加する。
      // 現時点ではアイコン素材未整備のため省略（Electrobun 既定アイコンが使われる）。
    },
  },
} satisfies ElectrobunConfig;
