#!/usr/bin/env node
// Uploads (and optionally publishes) a zip to the Chrome Web Store with API v2.
// Usage: node scripts/cws-upload.mjs <zip> <upload|upload-and-publish>
// Env: CWS_EXTENSION_ID, CWS_PUBLISHER_ID, CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN
import { readFile } from 'node:fs/promises';

const [zipPath, mode = 'upload'] = process.argv.slice(2);
const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}. See docs/PUBLISHING.md.`);
  return v;
};
const API = 'https://chromewebstore.googleapis.com';

async function accessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('CWS_CLIENT_ID'),
      client_secret: env('CWS_CLIENT_SECRET'),
      refresh_token: env('CWS_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`OAuth token request failed: ${res.status} ${JSON.stringify(body)}`);
  return body.access_token;
}

async function call(token, method, url, body, contentType) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(contentType ? { 'content-type': contentType } : {}) },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  return json;
}

async function main() {
  if (!zipPath || !['upload', 'upload-and-publish'].includes(mode)) {
    throw new Error('Usage: cws-upload.mjs <zip> <upload|upload-and-publish>');
  }
  const name = `publishers/${env('CWS_PUBLISHER_ID')}/items/${env('CWS_EXTENSION_ID')}`;
  const token = await accessToken();
  const zip = await readFile(zipPath);

  console.log(`Uploading ${zipPath} (${zip.length} bytes) to ${name}…`);
  let up = await call(token, 'POST', `${API}/upload/v2/${name}:upload`, zip, 'application/zip');
  console.log('Upload response:', JSON.stringify(up));
  for (let i = 0; up.uploadState === 'IN_PROGRESS' && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const st = await call(token, 'GET', `${API}/v2/${name}:fetchStatus`);
    up = { uploadState: st.lastAsyncUploadState };
    console.log('Upload state:', up.uploadState);
  }
  if (up.uploadState !== 'SUCCEEDED') throw new Error(`Upload did not succeed: ${up.uploadState}`);

  if (mode === 'upload-and-publish') {
    const pub = await call(token, 'POST', `${API}/v2/${name}:publish`, JSON.stringify({}), 'application/json');
    console.log('Publish response:', JSON.stringify(pub));
    console.log(`Submitted for review. State: ${pub.state}`);
  } else {
    console.log('Uploaded as a draft. Publish it from the dashboard or re-run with "upload-and-publish".');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
