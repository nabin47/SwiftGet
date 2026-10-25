import { expect, test } from './fixtures';

test('diagnostics resolves a Drive-style interstitial and measures connections', async ({ context, extensionId, serverUrl }) => {
  const size = 6 * 1024 * 1024;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/diagnostics.html`);
  await page.getByTestId('diag-input').fill(`${serverUrl}/drive/uc?id=TESTFILEID12345&size=${size}`);
  await page.getByTestId('diag-run').click();
  await expect(page.getByTestId('diag-run')).toHaveText('Run', { timeout: 90_000 });

  const report = JSON.parse((await page.getByTestId('diag-report').textContent()) ?? '{}');
  expect(report.fatal).toBeUndefined();
  expect(report.probe.totalSize).toBe(size);
  expect(report.steps).toContain('drive page: confirm');
  const check = (name: string) => report.checks.find((c: { name: string }) => c.name === name);
  expect(check('Range honored (206)').ok).toBe(true);
  expect(check('Last byte reachable').ok).toBe(true);
  expect(check('If-Range honored').ok).toBe(true);
  expect(check('Engine worker sees the same file').ok).toBe(true);
  expect(report.capture[0].reuse.rangeSupported).toBe(true);
  expect(report.connections.map((r: { connections: number }) => r.connections)).toEqual([1, 2, 4, 8]);
  for (const run of report.connections) expect(run.statuses['206']).toBe(run.connections);
  // Identifiers are redacted by default.
  expect(JSON.stringify(report)).not.toContain('6b1f4a2e');
});
