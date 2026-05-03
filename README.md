<!-- TODO: assets/icon.svg を作成して差し込む -->
<p align="center">
  <img src="./assets/icon.svg" alt="slAIdo" width="180" />
</p>

<p align="center">
  <a href="./README.ja.md">日本語版</a>
</p>

# slAIdo

> An AI-driven slide generator for macOS — hand the agent a seed document, get back a reveal.js deck you can keep refining in chat.

<!-- TODO: docs/images/screenshot.png を撮影 -->

## Why slAIdo?

Most slide tools assume you write the slides. When you're working with an AI agent, that assumption is backwards — you want to hand it the raw material (a memo, an outline, an existing doc) and iterate on the *deck* through conversation.

Existing tools didn't fit:

- **Marp** edits at the Markdown line level. Diff-driven AI revisions become noisy and the model has no semantic unit to grab onto.
- **Google Slides API** ties you to an external service and a Google account, which is friction for end users and a constraint on offline use.
- **reveal.js**, written by hand, is great for humans but tedious — until you let an AI write the HTML directly. `<section>` is exactly the right granularity for "rewrite slide 3" without disturbing the rest.

slAIdo is built around that last observation. The agent edits a single `index.html` of reveal.js sections; the desktop app shows the live preview and routes your chat instructions to the model.

It targets non-engineers — no terminal required. Install it from Homebrew, double-click the app, paste a seed document, and iterate.

## Features

- **reveal.js output** — slides are real `<section>` elements in a single HTML file, editable by both the agent and (if you want) by hand
- **OpenCode SDK in the loop** — LLM calls go through the [OpenCode](https://opencode.ai) agent runtime, so the model gets a real coding-agent toolset instead of a thin chat wrapper
- **OpenRouter BYOK** — bring your own OpenRouter key; it's stored in the macOS Keychain (`dev.slaido.app`), never in plaintext config
- **Anthropic prompt caching** — repeated context (templates, prior slide HTML) is cached on the provider side to keep iteration cheap
- **HTML zip & PDF export** — ship the deck as a self-contained `slides.zip` or render it to PDF for distribution
- **Signed & notarized** — built with an Apple Developer ID and notarized by Apple, so it launches on macOS without Gatekeeper workarounds

## Install

The recommended path is Homebrew Cask (macOS on Apple Silicon):

```bash
brew install --cask hummer98/slaido/slaido
```

This drops `slAIdo.app` into `/Applications`. Because the app is signed with an Apple Developer ID and notarized by Apple, it launches directly — no `xattr -d com.apple.quarantine` or right-click-Open dance.

To upgrade later:

```bash
brew update && brew upgrade --cask slaido
```

### Manual install (without Homebrew)

Grab `slAIdo-v0.1.0-macos-arm64.zip` from the [v0.1.0 release](https://github.com/hummer98/slaido/releases/tag/v0.1.0), unzip it, and move `slAIdo.app` into `/Applications`.

Releases are built and published automatically by GitHub Actions on tag push (`v*.*.*`). The Homebrew Cask at `hummer98/slaido` is updated by a follow-up workflow as soon as the release is live, so `brew upgrade --cask slaido` reflects new versions without manual steps. See [`docs/release-automation.md`](./docs/release-automation.md) for the full pipeline.

## Usage

1. Launch **slAIdo** from `/Applications` (or Spotlight).
2. On first run, paste your OpenRouter API key when prompted — it goes into the macOS Keychain.
3. Drop your **seed document** (memo, outline, existing doc) into the left pane and hit *Generate*.
4. The right pane shows the live reveal.js preview. Iterate by typing instructions in chat: *"make slide 3 a two-column comparison"*, *"shorten the intro"*, etc.
5. When you're happy, export:
   - **HTML zip** — a self-contained directory you can host anywhere
   - **PDF** — rendered via reveal.js's print mode

See [`examples/seed-meta.md`](./examples/seed-meta.md) for an example of what a seed document looks like.

## How it works

slAIdo is built on [Electrobun](https://electrobun.dev) — a thin native shell pairing [Bun](https://bun.sh) with macOS WKWebView. The Bun process owns the [OpenCode SDK](https://opencode.ai) session and the file I/O; the WebView hosts the chat UI on the left and an iframe-loaded reveal.js deck on the right. Chat instructions and slide updates flow over a host-message bridge, so the agent edits a real HTML file on disk and the preview reloads in place.

## Development

Prerequisites: macOS on Apple Silicon (`arm64`), [Bun](https://bun.sh) >= 1.0.

```bash
bun install              # install deps
bun start                # run the dev app (Electrobun dev mode)
bun test                 # unit tests (bun:test)
bun test:e2e             # Electrobun integration tests
```

Signing and notarization for release builds is handled by Electrobun + fastlane — see [`docs/signing-setup.md`](./docs/signing-setup.md). The release pipeline (CI build + Cask update) is documented in [`docs/release-automation.md`](./docs/release-automation.md); per-version notes live in [`CHANGELOG.md`](./CHANGELOG.md).

## Privacy

slAIdo runs locally and only talks to the LLM provider you point it at (OpenRouter and the underlying model providers). It collects no telemetry. See [PRIVACY.md](./PRIVACY.md) for what is stored where.

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

Issue-first, please. File an issue before opening a PR for anything non-trivial so we can talk through scope. Details in [CONTRIBUTING.md](./CONTRIBUTING.md).
