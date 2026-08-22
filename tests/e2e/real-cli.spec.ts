import { test, expect } from '@playwright/test';

/**
 * The browser half of Task 9 Step 4: drives the real `claude` binary end to
 * end. Opt-in, because it spends subscription quota and depends on a logged-in
 * Claude Code install.
 *
 *   MESH_E2E_REAL=1 npm run test:e2e:real
 */
test.skip(process.env.MESH_E2E_REAL !== '1', 'set MESH_E2E_REAL=1 to spend quota');

test('the project manager answers a message from the browser', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');

  await expect(page.locator('header .status')).toHaveText('open');

  await page.locator('textarea').fill('Reply with exactly: MESH_OK');
  await page.locator('button', { hasText: 'Send' }).click();

  const pmTranscript = page.locator('.pane').first().locator('.transcript');
  await expect(pmTranscript).toContainText('MESH_OK', { timeout: 90_000 });
});
