# Manual steps

These are the only steps that need your own accounts or your own browser. Everything else runs in GitHub Actions.

---

## 1. Install the test build in Chrome (needed now, and for every phase)

1. Open <https://github.com/nabin47/SwiftGet/actions/workflows/ci.yml>.
2. Click the newest run with a green check for the branch you want (for now `claude/swiftget-chrome-extension-gv2rit`).
3. Scroll to **Artifacts** at the bottom of the run page and click **swiftget-chrome-…** to download a `.zip`.
4. Unzip it. You get a folder that contains `manifest.json`.
5. In Chrome open `chrome://extensions`.
6. Turn on **Developer mode** (toggle, top right).
7. Click **Load unpacked** and pick the unzipped folder.
8. Optional: click the puzzle-piece icon in the toolbar and pin **SwiftGet**.

To update later: remove the old SwiftGet from `chrome://extensions` (or click the reload icon on its card after replacing the folder) and load the new folder.

## 2. Run Drive diagnostics on your large file (needed now, Phase 0)

1. Make sure you are signed in to Google in this Chrome profile with an account that can open the file.
2. Click the SwiftGet toolbar icon. The SwiftGet page opens. Click **Drive diagnostics** (top right).
3. Paste the Drive link of **one file**: `https://drive.google.com/file/d/…/view`. A **folder** link (`…/drive/folders/…`) won't work. To get a file link, open the folder, right-click the file, choose **Share → Copy link**, or open the file's preview and choose **⋮ → Open in new window**, then copy the address.
4. Leave **Bytes per speed test** at 64 MB (choose 128 MB on a fast connection) and keep **Test capturing a native download** ticked.
5. Click **Run** and wait. It downloads about 4 × 64 MB in total. A download may briefly appear in Chrome's download bubble and is cancelled immediately; that is the capture test.
6. When it finishes, run the second test: click **Wait for my click in Drive**, then in another tab open the file in Google Drive and click its **Download** button (and **Download anyway** if Drive asks). SwiftGet catches and cancels that download.
7. Back on the diagnostics page, leave **Redact file IDs and tokens** ticked, click **Copy report**, and paste the report into our chat.
8. Optional: also start a real download of the file from the SwiftGet page (paste the same link, click **Download**). Tell me whether it completed and roughly how fast. Keep **Connections** at 4 for Drive.

## 3. Turn on GitHub Pages (any time; needed before Phase 5)

1. Open <https://github.com/nabin47/SwiftGet/settings/pages>.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. The Pages workflow publishes `site/` whenever `main` changes. To publish now, go to **Actions → Pages → Run workflow** and pick `main`.
4. The site will be at `https://nabin47.github.io/SwiftGet/` and the privacy policy at `https://nabin47.github.io/SwiftGet/privacy.html`.

Note: the Pages workflow deploys from `main`. Until this branch is merged into `main`, there is nothing to deploy. GitHub only lets the default branch deploy to Pages unless you change the `github-pages` environment rules.

## 4. Chrome Web Store account and API secrets (needed before Phase 5)

Follow [PUBLISHING.md](PUBLISHING.md). In short:

1. Register as a Chrome Web Store developer ($5 one-time).
2. Upload the first zip by hand.
3. Create OAuth credentials in Google Cloud and get a refresh token, all in the browser.
4. Add 5 GitHub secrets: `CWS_EXTENSION_ID`, `CWS_PUBLISHER_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`.
