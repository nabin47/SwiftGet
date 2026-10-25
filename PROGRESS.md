# Progress

## Phase 0: scaffold, CI, test server, prototype engine, Drive diagnostics (waiting on Drive results)

Done:
- [x] WXT + TypeScript + React + Dexie scaffold, all dependencies pinned (`.npmrc save-exact`)
- [x] CI: typecheck, lint, Vitest, build, Playwright e2e with the extension loaded, extension artifact upload
- [x] Release workflow: version bump + tag, release notes from conventional commits, GitHub Release with zip, Chrome Web Store API v2 upload (upload only / upload and publish / skip)
- [x] GitHub Pages workflow: landing page and privacy policy (`site/`)
- [x] Fault-injecting test server: ranges, throttling, dropped connections, injected 429/503, changing ETag, no-range, unknown length, expired URLs, Drive-like interstitial/quota/sign-in pages, Repr-Digest
- [x] Engine: Range probe (HEAD fallback), 4 (1–16) parallel ranges, If-Range, per-chunk resume on drop, exponential backoff with Retry-After, single-stream fallback
- [x] OPFS storage via sync access handles in a worker (no merge); streaming SHA-256 verify; size verify
- [x] Delivery to Downloads (blob URL of the OPFS file) or to a picker-chosen file
- [x] Drive: link parsing incl. authuser/resourcekey, virus-scan confirmation, quota and access errors (not bypassed), conservative default of 4 connections
- [x] Drive diagnostics page: 206 check, last-byte check, If-Range check, engine-context check, native download capture and reuse test (triggered and real click), 1/2/4/8-connection throughput, redacted JSON report
- [x] Docs: ARCHITECTURE, PERMISSIONS, MANUAL_STEPS, MANUAL_TESTS, PUBLISHING

Test status: 51 Vitest tests (including a 256 MB download at 16 connections, hash-checked), 6 Playwright e2e tests.

Drive results so far (1.25 GB video, Chrome 156, 25 Oct 2026):
- [x] Virus-scan confirmation followed automatically; final URL on drive.usercontent.google.com
- [x] Range honored (206), last byte reachable, size 1,344,850,132
- [x] No ETag; If-Range with Last-Modified honored (resume will use Last-Modified)
- [x] Engine worker (cookies from extension origin) sees the same file
- [x] URL captured from a native download is reusable after cancelling it (206, same size)
- [ ] Speed at 1/2/4/8 connections: report was copied before these finished; rerun needed
- [ ] Real-click capture from a Drive tab
- [ ] Full download through the engine

Known limits (by design, addressed in later phases):
- No pause/resume yet. A browser restart marks active downloads "Interrupted" (Phase 1).
- No interception of normal Chrome downloads yet; downloads start from the SwiftGet page (Phase 2).
- No Referer/Origin rules yet (Phase 2).

## Phase 1: full engine (not started)
## Phase 2: browser integration (not started)
## Phase 3: UI (not started)
## Phase 4: hardening (not started)
## Phase 5: store release (not started)
