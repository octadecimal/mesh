import { test, expect } from '@playwright/test';

/**
 * Runs against tests/fixtures/streams/subagent-conversation.ndjson, replayed by
 * tests/stubs/fake-claude.mjs. No real `claude` process, so no quota.
 *
 * These assertions cover the browser half of the viewer: everything below is
 * rendering that the API-level checks cannot reach.
 */

test('the header reports a live connection', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('header .status')).toHaveText('open');
});

test('the quota badge shows the rate limit from the stream', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('header .quota')).toContainText('five_hour: allowed');
});

test('the project manager and its subagent each get a pane', async ({ page }) => {
  await page.goto('/');

  const titles = page.locator('.pane h2');
  await expect(titles).toHaveCount(2);
  await expect(titles.nth(0)).toHaveText('Project manager');
  await expect(titles.nth(1)).toHaveText('wordcounter · Count words in a.txt');
});

test('assistant text is rendered into the project manager transcript', async ({ page }) => {
  await page.goto('/');

  const pmTranscript = page.locator('.pane').first().locator('.transcript');
  await expect(pmTranscript.locator('.line').first()).toBeVisible();
});

test('sending a message clears the composer', async ({ page }) => {
  await page.goto('/');

  const composer = page.locator('textarea');
  await composer.fill('hello from the e2e run');

  const accepted = page.waitForResponse(
    (response) => response.url().includes('/api/message') && response.status() === 202,
  );
  await page.locator('button', { hasText: 'Send' }).click();
  await accepted;

  await expect(composer).toHaveValue('');
});
