# Publishing to the Chrome Web Store

Everything here is done in a web browser. You never need local tools.

## A. Register as a developer (one time, $5)

1. Go to <https://chrome.google.com/webstore/devconsole> and sign in with the Google account that should own SwiftGet. A dedicated account is a good idea.
2. Accept the developer agreement and pay the one-time **$5** registration fee.
3. In the dashboard open **Account**. Fill in the publisher name and contact email, and verify the email address. Publishing is blocked until the email is verified.

## B. First upload by hand (one time)

The API can only update an item that already exists, so the first upload is manual.

1. Get a release zip. Either open **Releases** in the GitHub repo and download `swiftget-<version>-chrome.zip`, or run **Actions → Release → Run workflow** with store set to **skip** to make one.
   - Upload this zip **as is**. Do **not** use the CI artifact here: GitHub wraps that folder in an extra zip.
2. In the developer dashboard click **New item** (or **+ Add new item**) and upload the zip.
3. Copy the **item ID** shown for the new item (32 letters, e.g. `abcdefghijklmnopabcdefghijklmnop`). This is `CWS_EXTENSION_ID`.
4. Open **Account** (or **Publisher → Settings**) and copy the **Publisher ID**. This is `CWS_PUBLISHER_ID`.
5. Fill in the store listing, the privacy tab and distribution. In Phase 5 we provide the text, screenshots, permission justifications (from `docs/PERMISSIONS.md`) and the privacy policy URL (`https://nabin47.github.io/SwiftGet/privacy.html`). You can save the item as a draft until then.

## C. Create API credentials (one time)

1. Open <https://console.cloud.google.com/> with the same Google account, then **Select a project → New project**. Name it `swiftget-publish` and click **Create**.
2. Go to **APIs & Services → Library**, search for **Chrome Web Store API**, open it and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen** (it may be called **Google Auth Platform → Branding/Audience**):
   - User type: **External** → Create.
   - App name `SwiftGet publisher`, plus your email as support and developer contact. Save.
   - Under **Audience**, add your own Google account as a **test user**, then click **Publish app** so the status is **In production**. (Refresh tokens issued while the app is in "Testing" expire after 7 days. Google will show an "unverified app" warning, which is fine for your own account.)
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**, name `swiftget-ci`.
   - Under **Authorized redirect URIs** add exactly `https://developers.google.com/oauthplayground`.
   - Click **Create**, then copy the **Client ID** (`CWS_CLIENT_ID`) and **Client secret** (`CWS_CLIENT_SECRET`).
5. Get a refresh token with the OAuth Playground:
   1. Open <https://developers.google.com/oauthplayground>.
   2. Click the gear icon (top right), tick **Use your own OAuth credentials**, and paste the client ID and secret.
   3. In the left box **Input your own scopes**, enter `https://www.googleapis.com/auth/chromewebstore` and click **Authorize APIs**.
   4. Sign in with the developer account. If you see "Google hasn't verified this app", click **Advanced → Go to SwiftGet publisher (unsafe)**, then **Continue**.
   5. Back in the playground click **Exchange authorization code for tokens**.
   6. Copy the **Refresh token**. This is `CWS_REFRESH_TOKEN`.

## D. Add the GitHub secrets

1. Open <https://github.com/nabin47/SwiftGet/settings/secrets/actions>.
2. Click **New repository secret** once for each of these, using exactly these names:

| Name | Value |
| --- | --- |
| `CWS_EXTENSION_ID` | item ID from B.3 |
| `CWS_PUBLISHER_ID` | publisher ID from B.4 |
| `CWS_CLIENT_ID` | from C.4 |
| `CWS_CLIENT_SECRET` | from C.4 |
| `CWS_REFRESH_TOKEN` | from C.5 |

The Chrome Web Store API v2 (launched October 2025) needs the publisher ID in every request. That is why there is a fifth secret beyond the four in the original plan.

## E. Releasing

1. Open **Actions → Release → Run workflow**.
2. **Version**: `patch`, `minor`, `major`, or an exact version like `1.0.0`.
3. **Chrome Web Store**:
   - **upload only** uploads a new draft package. You then review it and click **Submit for review** in the dashboard.
   - **upload and publish** uploads and submits for review. The listing goes live automatically once it passes review.
   - **skip** creates only the GitHub Release.
4. The workflow:
   1. runs the tests;
   2. sets the version in `package.json` (and therefore `manifest.json`);
   3. commits `chore(release): vX.Y.Z` and creates and pushes the `vX.Y.Z` tag;
   4. builds the zip and writes release notes from the conventional commit messages;
   5. creates the GitHub Release with the zip attached;
   6. uploads to the store, if the secrets are set; otherwise it skips this with a warning.

Pushing a `v*` tag yourself also releases (with **upload only**). The version is then taken from the tag.

**Note:** the store rejects an upload whose version is not higher than the last uploaded one.
