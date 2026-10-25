# SwiftGet architecture

```
 ┌──────────────┐  runtime msg   ┌──────────────────┐  runtime msg  ┌───────────────────────────────┐
 │ Manager page │ ─────────────▶ │  Service worker  │ ────────────▶ │ Offscreen document            │
 │ Diagnostics  │  {start,id}    │  (coordination)  │               │  └─ Dedicated Worker = ENGINE │
 └──────┬───────┘                └───────┬──────────┘               │      fetch × N  →  OPFS file  │
        │ Dexie liveQuery                │ chrome.downloads          └──────────────┬────────────────┘
        ▼                                ▼                                          │
 ┌──────────────────────────────────────────────────────┐                           │
 │ IndexedDB (Dexie): download records, chunk map, etc. │ ◀─────────────────────────┘ progress writes
 └──────────────────────────────────────────────────────┘
```

## Components

| Piece | File | Role |
| --- | --- | --- |
| Engine core | `src/engine/*` | Platform-neutral TypeScript: probe, chunk planning, parallel ranged fetch with retries, Drive handling, filename parsing, SHA-256. Runs in Node for tests and in the browser worker. |
| Engine worker | `src/offscreen/engine.worker.ts` | Owns transfers. Opens the OPFS file with a **sync access handle**, runs `download()`, verifies size + SHA-256, writes progress to IndexedDB every 500 ms. |
| Offscreen document | `src/entrypoints/offscreen/` | Hosts the worker (reasons `WORKERS`, `BLOBS`). Turns finished OPFS files into `blob:` URLs for delivery. Holds no state. |
| Service worker | `src/entrypoints/background.ts` | Routes messages, creates the offscreen document on demand, calls `chrome.downloads.download` for delivery and cleans up when Chrome finishes. Keeps nothing in memory, so being killed is harmless. |
| Manager page | `src/ui/Manager.tsx` | Add downloads, watch progress (Dexie `liveQuery`, no polling or message storms). |
| Drive diagnostics | `src/ui/Diagnostics.tsx`, `src/diagnostics/run.ts` | Measures real-world behaviour of a Drive link (see below). |
| Test server | `test/server/` | Range-capable HTTP server with fault injection, used by Vitest and Playwright. |

## Download flow (Phase 0)

1. The manager writes a `queued` record to IndexedDB and sends `{type:'start', id}` to the service worker.
2. The service worker ensures the offscreen document exists and forwards the message; the offscreen document posts it to the engine worker.
3. **Probe:** `GET` with `Range: bytes=0-0`. A `206` with `Content-Range: bytes 0-0/TOTAL` means ranges work and gives the size. Errors fall back to `HEAD`. We record ETag, Last-Modified, Content-Type, Content-Disposition, `Repr-Digest`, and the final URL after redirects.
4. **Drive:** if a Drive host answers with HTML, we classify the page: the virus-scan confirmation form is followed (its action URL plus hidden inputs); quota and sign-in pages become clear errors and are **not** bypassed.
5. **Transfer:** the file is split into N even chunks (default 4, max 16). Each chunk is fetched with `Range` and `If-Range` (strong ETag, else Last-Modified). A `200` reply to a ranged request means the file changed, which raises `FILE_CHANGED`. Dropped connections resume from the last written byte. Retryable statuses (403/408/425/429/5xx) back off exponentially with jitter and honour `Retry-After`. Servers without range support use one stream that restarts from 0 on failure.
6. **Write:** each connection buffers 1 MiB, then calls `syncHandle.write(buf, {at: offset})` straight into the OPFS file. There is no merge step.
7. **Verify:** the file size must equal the expected total. The file is then streamed through SHA-256 and compared with the server's `Repr-Digest` when one exists.
8. **Deliver:**
   - *Default:* the offscreen document makes a `blob:` URL of the OPFS file (disk-backed, not copied into RAM) typed `application/octet-stream`. The service worker passes it to `chrome.downloads.download`. When Chrome reports `complete`, the OPFS file is deleted.
   - *"Choose where to save":* the page calls `showSaveFilePicker` when the download starts and stores the handle in IndexedDB. The worker streams the verified OPFS file into it.

## Design decisions and deviations from the brief

- **The engine runs in a Worker inside the offscreen document,** not in the document itself. Only dedicated workers get OPFS `createSyncAccessHandle()`, which is what allows durable writes at arbitrary offsets without a swap file.
- **OPFS is the working store; File System Access is a delivery target, not the primary write path.** The brief asked to write directly into a `showSaveFilePicker` file at offsets. Under Chrome that path has three problems:
  1. Writable streams on non-OPFS files buffer into a `.crswap` file and commit only on `close()`. Data is lost if the browser dies mid-download, so resume after a restart is impossible.
  2. The picker needs a user gesture in a visible page, which intercepted downloads (Phase 2) don't have.
  3. Write permission to a picked file is not guaranteed to survive restarts.

  So all writes go to OPFS at offsets (durable and resumable). The finished file is then handed to Chrome's downloader, or copied once into the picked file. The cost is that a finished file briefly occupies twice its size on disk.
- **SHA-256 is our own streaming implementation** (`src/engine/sha256.ts`), because WebCrypto can't hash incrementally and multi-GB files can't be held in memory. Vitest checks it against `node:crypto`.
- **Delivery type is `application/octet-stream`.** OPFS files have no MIME type, and Chrome otherwise renames `foo.bin` to `foo.txt` (an e2e test caught this).
- **Referer/Origin** will be set with `declarativeNetRequest` session rules scoped per download (Phase 2). `fetch()` can't set them.
- **Cookies:** requests use `credentials: 'include'` from the extension origin with host permissions, which sends the user's cookies for that site.

## Persistence (current and planned)

`DownloadRecord` (in `src/shared/db.ts`) already stores the URL, final URL, validators, the chunk map and status. Phase 1 adds resume: re-open the OPFS file, re-issue `Range` + `If-Range` for each chunk's `pos..end`, and restart cleanly on `FILE_CHANGED`.

## Drive diagnostics

For a pasted link, the page checks:

- the start URL (`drive.usercontent.google.com/download?id=…&export=download&authuser=…`);
- interstitial handling;
- whether `Range` is honoured (206), the last byte is reachable, and `If-Range` is honoured;
- whether the engine worker sees the same file;
- **capture tests**: start a native download (or wait for the user's click in a Drive tab), cancel it immediately, then test whether its final URL still serves ranges;
- throughput and status codes at 1/2/4/8 connections.

The JSON report has IDs and tokens redacted by default.
