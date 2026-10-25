# Permissions

SwiftGet asks only for what the current features use. Each entry below is the justification we will
also paste into the Chrome Web Store "Privacy practices" tab.

## Requested now

| Permission | Justification |
| --- | --- |
| `downloads` | Saves finished files to the user's Downloads folder and (from Phase 2) takes over downloads the user starts so they can be accelerated. |
| `offscreen` | Runs the download engine in an offscreen document's worker, because Manifest V3 service workers are stopped when idle and cannot hold long transfers. |
| `unlimitedStorage` | Partially downloaded files (often several GB) are kept in the extension's private file storage until they are complete and verified. |
| Host permission `<all_urls>` | A download manager must fetch files from whatever site the user downloads from, with the user's cookies for that site, and read response headers (size, ranges, filename). |

## Planned (added in the phase that needs it)

| Permission | Phase | Justification |
| --- | --- | --- |
| `webRequest` | 2 | Read `Content-Disposition`, `Content-Type` and size of downloads the user starts, to decide whether to take them over. |
| `declarativeNetRequestWithHostAccess` | 2 | Set the original page's `Referer`/`Origin` on SwiftGet's own requests for one download, because some servers require them. |
| `contextMenus` | 2 | "Download with SwiftGet" on links. |
| `storage` | 3 | Save user settings (connection limits, speed limit). |
| `notifications` | 3 | Tell the user when a download finishes or fails. |

Not requested: `cookies` (fetch with `credentials: 'include'` already sends the user's cookies), `tabs`
(opening our own page needs no permission), `scripting`/content scripts (none needed so far).
