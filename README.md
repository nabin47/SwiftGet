# SwiftGet

A fast, resumable, multi-connection download manager for Chrome (Manifest V3). Edge and Firefox are planned.

- Parallel ranged downloads (default 4 connections, max 16), with per-chunk resume and backoff on errors.
- Files are written straight into the browser's private file system at the right offsets, then verified with SHA-256.
- Works with signed-in sites, including large Google Drive files you have access to.
- No servers, no analytics, no tracking. [Privacy policy](site/privacy.html).

Status: **Phase 0 (prototype engine + Drive diagnostics)**. See [PROGRESS.md](PROGRESS.md).

## Try it

Download the latest CI artifact and use **Load unpacked**. Step-by-step instructions are in [docs/MANUAL_STEPS.md](docs/MANUAL_STEPS.md).

## Development

Everything runs in GitHub Actions ([ci.yml](.github/workflows/ci.yml)):

| Command | What |
| --- | --- |
| `npm run build` | Build to `.output/chrome-mv3` (WXT) |
| `npm test` | Vitest unit/integration tests against the local test server |
| `npm run test:e2e` | Playwright: loads the built extension in Chromium |
| `npm run test-server` | Start the fault-injecting test server on :8787 |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Permissions](docs/PERMISSIONS.md)
- [Manual steps](docs/MANUAL_STEPS.md)
- [Manual tests](docs/MANUAL_TESTS.md)
- [Publishing](docs/PUBLISHING.md)
