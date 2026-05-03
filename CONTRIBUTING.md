# Contributing to slAIdo

Thanks for taking a look! A few things to know before you open an issue or PR.

## Issue first

Please file an issue before opening a PR for anything non-trivial — a new
feature, a refactor, a behavior change. Small fixes (typos, obvious bugs,
docs nits) are fine to send straight as a PR.

This repo is small and unblocked by discussion, not gated by it. The "issue
first" rule is so we can agree on scope before either of us writes code that
gets thrown away.

## How development works here

slAIdo is developed entirely by AI agents driven by a single human
maintainer. See [`docs/seed.md`](./docs/seed.md) for the underlying design
philosophy. This shapes a few practical things:

- Code, comments, and commit messages tend to be written by an agent
  following the project's CLAUDE.md / `docs/` conventions. PRs from humans
  are very welcome — please just match the existing style of the file you're
  editing.
- Changes are usually scoped per task (`Txxx`) tracked under `.team/tasks/`.
  You don't need to follow that workflow for an external PR; the maintainer
  will reconcile it.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) style. Look at
`git log` for the established cadence — short subject, optional scope,
imperative mood:

```
feat(export): add PDF export via reveal.js print mode
fix(opencode): retry session bootstrap once on EADDRINUSE
docs(privacy): clarify Keychain item is not removed by --zap
```

Reference the relevant issue in the body when applicable.

## Testing

```bash
bun test           # unit tests
bun test:e2e       # Electrobun integration tests (slow)
```

E2E covers the host-message bridge end-to-end, so please run it before
sending PRs that touch `src/bun/` or `src/mainview/`.

## License & sign-off

Contributions are accepted under the MIT License (see [LICENSE](./LICENSE)).
There is no DCO and no CLA — opening a PR is your acknowledgement that your
contribution is yours to license.
