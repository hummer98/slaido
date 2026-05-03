# Privacy Policy

_Last updated: 2026-05-03_

## Overview

slAIdo is a macOS desktop application (Electrobun + Bun + WKWebView) that
generates and refines reveal.js slide decks via an AI agent. This document
describes what data slAIdo handles, where it lives, and what leaves your
machine.

## TL;DR

- **No telemetry, no analytics.** slAIdo never reports usage back to us.
- **No third-party data sharing.** The only outbound traffic is to the LLM
  provider you configure (OpenRouter and the underlying model provider it
  routes to).
- **Your API key stays in the macOS Keychain**, scoped to the bundle
  identifier `dev.slaido.app`.
- **Your seed documents and generated decks stay on disk**, under your home
  directory.

## What Is Stored Locally

slAIdo writes the following to your machine:

| Path | Contents |
|------|----------|
| `~/Library/Application Support/slAIdo/` | Project state — chat history, generated `index.html` decks, per-project metadata |
| `~/Library/Caches/dev.slaido.app/` | Cache files managed by macOS / WKWebView |
| `~/Library/Preferences/dev.slaido.app.plist` | App preferences (window size, last opened project, etc.) |
| `~/Library/Logs/slAIdo/main.log` | Structured event log (one event per line). See [`docs/logging-policy.md`](./docs/logging-policy.md) for what is logged and what is masked. |
| `~/Library/Saved Application State/dev.slaido.app.savedState/` | macOS-managed window state |
| macOS Keychain item `dev.slaido.app` | Your OpenRouter API key |

Additionally, slAIdo bundles the [OpenCode](https://opencode.ai) agent
runtime, which writes its own session logs to:

| Path | Contents |
|------|----------|
| `~/.local/share/opencode/log/<timestamp>.log` | OpenCode session transcripts. slAIdo injects events tagged `service=slaido` here so chat/generate/refine activity is grep-able alongside the OpenCode log. Seed bodies and chat bodies are **not** written — only their length and a short SHA-256 hash prefix. |

### What is _not_ stored

- We never write your API key to a plaintext config file. It is held in the
  macOS Keychain and read on demand.
- Logs do not contain seed document bodies or chat message bodies. See
  [`docs/logging-policy.md`](./docs/logging-policy.md) for the full set of
  fields that are explicitly masked.

## What Leaves Your Machine

### LLM provider traffic

When you generate or refine a deck, slAIdo sends the relevant context (system
prompt, prior slide HTML, your chat instructions) to the LLM provider via the
OpenCode SDK. By default this is **OpenRouter**, which then routes the
request to the underlying model provider you have selected (Anthropic,
OpenAI, etc.).

slAIdo does not intermediate that traffic — your API key authenticates
directly with OpenRouter. The handling of that data is governed by
OpenRouter's and the underlying provider's privacy policies, not by slAIdo.

### Apple notarization (release builds only)

Release artifacts on the [GitHub Releases](https://github.com/hummer98/slaido/releases)
page are codesigned with an Apple Developer ID and submitted to Apple Notary
Service for notarization before publication. This step is performed by the
maintainer at release time using fastlane (see
[`docs/signing-setup.md`](./docs/signing-setup.md)) and uploads the **app
binary**, not user data.

### Nothing else

slAIdo has no analytics SDK, no crash reporter, and no auto-updater. It does
not phone home.

## Uninstalling

If you installed via Homebrew Cask:

```bash
brew uninstall --cask slaido        # remove the app
brew uninstall --zap --cask slaido  # also delete app data
```

The `--zap` form removes everything listed under "What Is Stored Locally"
above except for two items, which macOS does not let casks touch
automatically:

- The Keychain item `dev.slaido.app` — open **Keychain Access**, search for
  `slaido`, and delete the entry manually.
- The OpenCode log directory `~/.local/share/opencode/log/` — this is shared
  with any other OpenCode-based tool you may have installed, so it is not
  removed by the slaido cask.

## Source Code

slAIdo is open source at <https://github.com/hummer98/slaido> under the MIT
License (see [LICENSE](./LICENSE)). You are encouraged to inspect the code
to verify the behavior described here — in particular `src/bun/` for the
backend, `docs/logging-policy.md` for what is logged, and
`docs/signing-setup.md` for the release pipeline.

## Contact

For privacy-related inquiries, contact:

- yuji.yamamoto@tayorie.jp
