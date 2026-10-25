# Manual test checklist

Automated tests cover the engine against a local server. These checks cover real sites and Google Drive.
Install the build first ([MANUAL_STEPS.md](MANUAL_STEPS.md) §1). Tick each item and note the Chrome version.

## Phase 0

### Drive (most important)
- [ ] Diagnostics on a **multi-GB Drive file you own**: report copied and sent.
- [ ] Diagnostics on a multi-GB file **shared with you** (not owned).
- [ ] Diagnostics with a second signed-in Google account (`/u/1/` or `authuser=1` in the link): the right account is used.
- [ ] Diagnostics "Wait for my click in Drive": the download is captured and cancelled, and the captured URL is reported as reusable or not.
- [ ] A full download of a 1–5 GB Drive file from the SwiftGet page with 4 connections: completes, the SHA-256 is shown, and the file opens.
- [ ] A small Drive file (< 100 MB, so no virus-scan page): downloads.
- [ ] A folder link or Google Docs link: a message explains what to paste instead.
- [ ] A file you **don't** have access to: a clear "check you are signed in" message, no crash.
- [ ] If you hit Drive's quota page: the "download quota exceeded" message appears and SwiftGet does not retry endlessly.

### General sites
- [ ] A large file from a CDN, e.g. a Linux ISO from a mirror. Compare the shown SHA-256 with the published checksum.
- [ ] A site without range support: the "single connection" note is shown and the download completes.
- [ ] A URL with redirects (e.g. a GitHub release asset): the final filename is correct.
- [ ] A filename with non-ASCII characters (Content-Disposition `filename*`): saved with the correct name.
- [ ] "Choose where to save": the picker appears and the file ends up at the chosen location.
- [ ] Cancel a running download: status Cancelled, no leftover file in Downloads.
- [ ] Close the SwiftGet tab mid-download: the download keeps going (reopen the page to see it).

## Later phases (to be expanded)
- Pause/resume, browser restart mid-download, network switch (Wi-Fi ↔ Ethernet), sleep/wake.
- Interception of normal Chrome downloads, context menu, Referer-protected sites.
- 10 GB+ file, disk nearly full.
- Keyboard-only use and screen reader pass on the manager and popup.
