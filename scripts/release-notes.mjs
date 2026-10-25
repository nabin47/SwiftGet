#!/usr/bin/env node
// Builds Markdown release notes from conventional commits since the previous tag.
// Usage: node scripts/release-notes.mjs <tag>
import { execFileSync } from 'node:child_process';

const tag = process.argv[2];
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let prev = '';
try {
  prev = git('describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`);
} catch {
  // first release
}
const range = prev ? `${prev}..${tag}` : tag;
const log = git('log', range, '--no-merges', '--pretty=format:%s%x1f%h');

const groups = {
  feat: 'Features',
  fix: 'Bug fixes',
  perf: 'Performance',
  refactor: 'Refactoring',
  docs: 'Documentation',
  test: 'Tests',
  build: 'Build',
  ci: 'CI',
  chore: 'Chores',
};
const buckets = new Map();
const breaking = [];
for (const line of log.split('\n').filter(Boolean)) {
  const [subject, hash] = line.split('\x1f');
  if (/^chore\(release\)/.test(subject)) continue;
  const m = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/.exec(subject);
  const type = m && groups[m[1]] ? m[1] : 'other';
  const text = m ? `${m[2] ? `**${m[2].slice(1, -1)}:** ` : ''}${m[4]}` : subject;
  if (m?.[3]) breaking.push(`- ${text} (${hash})`);
  if (!buckets.has(type)) buckets.set(type, []);
  buckets.get(type).push(`- ${text} (${hash})`);
}

const out = [`## SwiftGet ${tag}`, ''];
if (breaking.length) out.push('### Breaking changes', ...breaking, '');
for (const [type, title] of [...Object.entries(groups), ['other', 'Other']]) {
  const items = buckets.get(type);
  if (items?.length) out.push(`### ${title}`, ...items, '');
}
out.push(
  '### Install for testing',
  'Download `swiftget-*-chrome.zip` below, unzip it, open `chrome://extensions`, enable Developer mode, and click **Load unpacked** on the unzipped folder.',
);
if (prev) out.push('', `Full changelog: ${prev}...${tag}`);
console.log(out.join('\n'));
