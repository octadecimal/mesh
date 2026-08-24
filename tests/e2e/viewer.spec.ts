import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

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

/**
 * Sticky scrolling. The server echoes every message the browser sends into the
 * project manager pane, so these tests grow the transcript without depending on
 * how much the recorded fixture happens to contain.
 */
test.describe('the transcript follows new messages only when parked at the bottom', () => {
  test.use({ viewport: { width: 900, height: 320 } });

  const metrics = (transcript: Locator) =>
    transcript.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

  async function send(page: Page, text: string) {
    const lines = page.locator('.pane').first().locator('.line');
    const before = await lines.count();
    await page.locator('textarea').fill(text);
    await page.locator('button', { hasText: 'Send' }).click();
    await expect(lines).toHaveCount(before + 1);
  }

  /** Sends messages until the project manager transcript overflows its pane. */
  async function overflow(page: Page, transcript: Locator) {
    for (let i = 0; i < 20; i += 1) {
      const { scrollHeight, clientHeight } = await metrics(transcript);
      if (scrollHeight > clientHeight + 200) return;
      await send(page, `filler message ${i} — long enough to wrap across the pane and take up room`);
    }
    throw new Error('the transcript never overflowed its pane');
  }

  test('a transcript parked at the bottom scrolls to show a new message', async ({ page }) => {
    await page.goto('/');
    const transcript = page.locator('.pane').first().locator('.transcript');
    await overflow(page, transcript);

    await send(page, 'the newest message');

    const { scrollTop, scrollHeight, clientHeight } = await metrics(transcript);
    expect(scrollHeight - clientHeight - scrollTop).toBeLessThanOrEqual(40);
  });

  test('scrolling up holds the reading position and raises a jump button', async ({ page }) => {
    await page.goto('/');
    const transcript = page.locator('.pane').first().locator('.transcript');
    const jump = page.locator('.pane').first().locator('.jump-to-end');
    await overflow(page, transcript);

    await transcript.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(jump).toBeHidden();

    await send(page, 'a message that arrives while scrolled up');

    await expect(jump).toBeVisible();
    expect((await metrics(transcript)).scrollTop).toBe(0);
  });

  test('the jump button returns the transcript to the bottom and then hides', async ({ page }) => {
    await page.goto('/');
    const transcript = page.locator('.pane').first().locator('.transcript');
    const jump = page.locator('.pane').first().locator('.jump-to-end');
    await overflow(page, transcript);

    await transcript.evaluate((el) => el.scrollTo({ top: 0 }));
    await send(page, 'a message that arrives while scrolled up');
    await jump.click();

    await expect(jump).toBeHidden();
    const { scrollTop, scrollHeight, clientHeight } = await metrics(transcript);
    expect(scrollHeight - clientHeight - scrollTop).toBeLessThanOrEqual(40);
  });
});
