import { defineConfig } from 'wxt';

// See docs/PERMISSIONS.md for why each permission is needed.
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'SwiftGet Download Manager',
    short_name: 'SwiftGet',
    description: 'Fast, resumable multi-connection download manager. Everything stays on your device.',
    permissions: ['downloads', 'offscreen', 'unlimitedStorage'],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'SwiftGet' },
    minimum_chrome_version: '116',
  },
});
