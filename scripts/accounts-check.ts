// Shopper accounts, checked in a real browser:   npm run accounts:check
//
// Starts the web server on a free port with accounts switched on and a throwaway
// database, then drives the real page in Chromium at desktop (1440) and phone (390)
// width: create account, save memory the way the agent does, reload, mint a call token
// and read the note the agent would get, sign out, sign in, forget, delete, and sign in
// with Shop (against a stand-in for Shop that the script approves).
//
// It makes no model calls and no store calls (the store routes are stubbed to fail fast),
// uses made-up LiveKit keys (the token is signed locally and never used), and costs nothing.
//
//   --shots <dir>   also save a screenshot of each stage into <dir>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

import { createAliceServer } from '../server.ts';
import { decodeCallMemory } from '../src/accounts/call-memory.ts';
import type { ShopSignIn } from '../src/accounts/shop-signin.ts';

const PASSWORD = 'correct horse battery';
const FACTS = ['Likes emerald green', 'Hates wool'];

const shotsArg = process.argv.indexOf('--shots');
const shotsDir = shotsArg !== -1 ? process.argv[shotsArg + 1] : undefined;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const offline = async (): Promise<never> => {
  throw new Error('store calls are switched off in accounts-check');
};

interface Stage {
  name: string;
  ok: boolean;
  detail?: string;
}

// A stand-in for Shop's sign-in: the script decides when "the shopper approves".
const fakeShop = {
  approved: false,
  who: 'nobody',
  flows: new Set<string>(),
};
const shopSignIn: ShopSignIn = {
  async start() {
    const id = crypto.randomUUID();
    fakeShop.flows.add(id);
    return { ok: true, flow_id: id, url: 'https://accounts.shop.app/activate?user_code=TEST-CODE', code: 'TEST-CODE', expires_in_s: 600, interval_s: 1 };
  },
  async poll(id) {
    if (typeof id !== 'string' || !fakeShop.flows.has(id)) return { status: 'unknown_flow' };
    if (!fakeShop.approved) return { status: 'pending', interval_s: 1 };
    fakeShop.flows.delete(id);
    return { status: 'signed_in', identity: { sub: `shop-${fakeShop.who}`, email: `shop+${fakeShop.who}@example.com`, email_verified: true, name: 'Priya' } };
  },
  cancel(id) {
    if (typeof id === 'string') fakeShop.flows.delete(id);
  },
  pendingCount: () => fakeShop.flows.size,
};

async function runAt(browser: Browser, baseUrl: string, label: string, viewport: { width: number; height: number }, mobile: boolean): Promise<Stage[]> {
  const stages: Stage[] = [];
  // One account per run, so a failed run cannot trip the next one.
  const EMAIL = `priya+${label}@example.com`;
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('console', (msg) => {
    // The stubbed store routes answer 502, which the browser reports as a console error.
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text());
  });

  const dialog = page.locator('.panel-sheet--account');
  const status = page.locator('.account-status');

  async function stage(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      stages.push({ name, ok: true });
      if (shotsDir) {
        const file = `${label}-${String(stages.length).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
        await page.screenshot({ path: path.join(shotsDir, file) });
      }
    } catch (err) {
      stages.push({ name, ok: false, detail: err instanceof Error ? err.message.split('\n')[0] : String(err) });
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${label}-FAILED-${stages.length}.png`) }).catch(() => {});
      throw err;
    }
  }

  const openPanel = async (): Promise<void> => {
    await page.locator('.account-btn').click();
    await dialog.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.panel-layer--account')?.classList.contains('is-open'));
  };

  // What the agent would hold: the save ticket from a call token minted by this browser.
  const callNote = async () => {
    const token = await page.evaluate(async () => {
      const res = await fetch('/api/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return res.ok ? ((await res.json()) as { token: string }).token : `HTTP ${res.status}`;
    });
    assert.ok(!token.startsWith('HTTP'), `token mint failed: ${token}`);
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    return { payload, note: decodeCallMemory(payload.roomConfig.agents[0].metadata) };
  };

  const memoryRows = (): Promise<string[]> =>
    page.locator('.account-memory dt').evaluateAll((nodes) =>
      nodes.map((dt) => `${dt.textContent}: ${(dt.nextElementSibling?.textContent ?? '').trim()}`),
    );

  try {
    await stage('page loads with a Sign in button', async () => {
      await page.goto(baseUrl, { waitUntil: 'load' });
      const button = page.locator('.account-btn');
      await button.waitFor({ state: 'visible' });
      assert.equal(await button.getAttribute('aria-label'), 'Sign in');
      const box = await button.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width, 'button is inside the screen');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'no sideways scroll');
    });

    await stage('panel opens, focus lands in it, Tab stays inside', async () => {
      await openPanel();
      assert.equal(await dialog.getAttribute('aria-modal'), 'true');
      await page.waitForFunction(() => document.activeElement?.id === 'account-email');
      for (let i = 0; i < 12; i += 1) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.panel-sheet--account'))), true, 'focus left the panel');
      }
      const box = await dialog.boundingBox();
      assert.ok(box && box.x >= 0 && Math.round(box.x + box.width) <= viewport.width, 'panel fits the screen');
    });

    await stage('create account: a short password is refused with a message', async () => {
      await page.getByRole('tab', { name: 'Create account' }).click();
      await page.locator('#account-name').fill('Priya');
      await page.locator('#account-email').fill(EMAIL);
      await page.locator('#account-password').fill('short');
      await page.locator('.account-submit').click();
      await status.filter({ hasText: 'at least 10 characters' }).waitFor();
      assert.equal(await page.locator('#account-email').inputValue(), EMAIL, 'the email is kept');
      assert.equal(await page.locator('#account-password').inputValue(), '', 'the password is cleared');
    });

    await stage('create account: signs in and shows an empty memory', async () => {
      await page.locator('#account-password').fill(PASSWORD);
      await page.locator('.account-submit').click();
      await page.locator('.account-signed-in').filter({ hasText: EMAIL }).waitFor();
      assert.deepEqual(await memoryRows(), ['Name: Priya']);
      assert.equal(await page.locator('.account-btn').getAttribute('aria-label'), 'Your account');
      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === 'alice_session');
      assert.ok(session, 'session cookie set');
      assert.equal(session.httpOnly, true);
      assert.equal(session.sameSite, 'Lax');
      assert.equal(await page.evaluate(() => document.cookie.includes('alice_session')), false, 'page scripts cannot read the cookie');
    });

    await stage('saveMemory (what the agent calls) saves and shows in the panel', async () => {
      const ticket = (await callNote()).note?.ticket;
      assert.ok(ticket, 'a signed-in call has a save ticket');
      const reply = await page.evaluate(
        ([facts, t]) => (window as any).alice.handlers.saveMemory({ ticket: t, name: 'Priya', department: 'women', sizes: { top: 'M', shoes: '8' }, facts }),
        [FACTS, ticket] as const,
      );
      assert.deepEqual(reply, { ok: true });
      await page.locator('.account-notes li').nth(1).waitFor();
      assert.deepEqual(await memoryRows(), ['Name: Priya', "Shops: Women's", 'Sizes: top Mshoes 8', `Notes: ${FACTS.join('')}`]);
    });

    await stage('text from memory is shown as text, never run as markup', async () => {
      const ticket = (await callNote()).note?.ticket;
      await page.evaluate(
        (t) => (window as any).alice.handlers.saveMemory({ ticket: t, name: 'Priya', department: 'women', sizes: {}, facts: ['<img src=x onerror="window.__pwned=1">'] }),
        ticket,
      );
      await page.locator('.account-notes li').nth(2).waitFor();
      assert.equal(await page.locator('.account-notes li').nth(2).textContent(), '<img src=x onerror="window.__pwned=1">');
      assert.equal(await page.locator('.account-notes img').count(), 0);
      assert.equal(await page.evaluate(() => (window as any).__pwned), undefined);
    });

    await stage('fresh page load with the #account link: still signed in, panel opens, memory is there', async () => {
      await page.goto(`${baseUrl}/?again=1#account`, { waitUntil: 'load' });
      await page.locator('.account-btn.is-signed-in').waitFor();
      await page.waitForFunction(() => document.querySelector('.panel-layer--account')?.classList.contains('is-open'));
      await page.locator('.account-notes li').first().waitFor();
      assert.equal((await memoryRows()).length, 4);
      assert.equal(await page.evaluate(() => location.hash), '', 'the link fragment is removed once used');
    });

    await stage('call token carries the memory to the agent, signed inside the token', async () => {
      const { payload, note } = await callNote();
      assert.equal(payload.name, 'Priya');
      assert.equal(note?.accounts, true);
      assert.match(note?.ticket ?? '', /^[A-Za-z0-9_-]{32}$/);
      assert.equal(note?.shopper?.department, 'women');
      assert.deepEqual(note?.shopper?.sizes, { top: 'M', shoes: '8' });
      assert.deepEqual(note?.shopper?.facts.slice(0, 2), FACTS);
      assert.ok(!JSON.stringify(payload).includes(EMAIL), 'no email in the token');
    });

    await stage('Escape closes the panel and focus goes back to the button', async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.panel-layer--account')?.classList.contains('is-open'));
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('account-btn')), true);
      assert.equal(await page.evaluate(() => document.body.classList.contains('account-open')), false);
    });

    await stage('sign out, then a wrong password is refused', async () => {
      await openPanel();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await status.filter({ hasText: 'signed out' }).waitFor();
      assert.equal(await page.locator('.account-btn').getAttribute('aria-label'), 'Sign in');
      // Signed out: what the agent sends is dropped, not saved.
      assert.deepEqual(await page.evaluate(() => (window as any).alice.handlers.saveMemory({ ticket: 'A'.repeat(32), name: null, department: null, sizes: {}, facts: ['should not be saved'] })), { ok: true });
      await page.locator('#account-email').fill(EMAIL);
      await page.locator('#account-password').fill('wrong password here');
      await page.locator('.account-submit').click();
      await status.filter({ hasText: "don't match" }).waitFor();
    });

    await stage('sign in: the memory comes back', async () => {
      await page.locator('#account-password').fill(PASSWORD);
      await page.locator('.account-submit').click();
      await page.locator('.account-signed-in').filter({ hasText: EMAIL }).waitFor();
      const rows = await memoryRows();
      assert.equal(rows.length, 4);
      assert.ok(!rows.join(' ').includes('should not be saved'));
    });

    await stage('forget everything: asks first, then clears sizes and notes', async () => {
      await page.getByRole('button', { name: 'Forget everything' }).click();
      await page.locator('.account-confirm-text').waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
      assert.equal((await memoryRows()).length, 4, 'Cancel keeps everything');
      await page.getByRole('button', { name: 'Forget everything' }).click();
      await page.getByRole('button', { name: 'Yes, forget' }).click();
      await status.filter({ hasText: 'Forgotten' }).waitFor();
      assert.deepEqual(await memoryRows(), ['Name: Priya']);
      assert.equal(await page.getByRole('button', { name: 'Forget everything' }).isDisabled(), true);
    });

    await stage('delete account: asks first, then the account is gone', async () => {
      await page.getByRole('button', { name: 'Delete account' }).click();
      await page.getByRole('button', { name: 'Yes, delete my account' }).click();
      await status.filter({ hasText: 'deleted' }).waitFor();
      await page.locator('#account-email').fill(EMAIL);
      await page.locator('#account-password').fill(PASSWORD);
      await page.locator('.account-submit').click();
      await status.filter({ hasText: "don't match" }).waitFor();
      assert.equal((await context.cookies()).some((c) => c.name === 'alice_session'), false, 'cookie cleared');
    });

    await stage('sign in with Shop: shows the code and a link to Shop, then signs in once approved', async () => {
      fakeShop.approved = false;
      fakeShop.who = label;
      await page.getByRole('button', { name: 'Sign in with Shop' }).click();
      await page.locator('.account-shop-code').filter({ hasText: 'TEST-CODE' }).waitFor();
      const link = page.getByRole('link', { name: 'Open Shop' });
      assert.equal(await link.getAttribute('href'), 'https://accounts.shop.app/activate?user_code=TEST-CODE');
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.match((await link.getAttribute('rel')) ?? '', /noopener/);
      await status.filter({ hasText: 'Waiting for your approval' }).waitFor();
      assert.equal(await page.locator('.account-btn').getAttribute('aria-label'), 'Sign in', 'not signed in until Shop says so');
      fakeShop.approved = true;
      await page.locator('.account-signed-in').filter({ hasText: `shop+${label}@example.com` }).waitFor();
      assert.deepEqual(await memoryRows(), ['Name: Priya']);
      const names = (await context.cookies()).map((c) => c.name);
      assert.ok(names.includes('alice_session'));
      assert.ok(!names.includes('alice_shop_flow'), 'the spent sign-in marker is cleared');
    });

    await stage('a Shop sign-in can be cancelled, and closing the panel gives it up', async () => {
      await page.getByRole('button', { name: 'Sign out' }).click();
      await status.filter({ hasText: 'signed out' }).waitFor();
      fakeShop.approved = false;
      await page.getByRole('button', { name: 'Sign in with Shop' }).click();
      await page.locator('.account-shop-code').waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.locator('#account-email').waitFor();
      await page.waitForFunction(() => true);
      await page.getByRole('button', { name: 'Sign in with Shop' }).click();
      await page.locator('.account-shop-code').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.panel-layer--account')?.classList.contains('is-open'));
      await page.waitForTimeout(300);
      assert.equal(fakeShop.flows.size, 0, 'no sign-in is left waiting');
      fakeShop.approved = true;
      await page.waitForTimeout(2500);
      assert.equal(await page.locator('.account-btn').getAttribute('aria-label'), 'Sign in', 'a given-up sign-in never completes');
    });

    await stage('no errors in the browser console', async () => {
      assert.deepEqual(consoleErrors, []);
    });
  } catch {
    // The failed stage is already recorded; report it below.
  } finally {
    await context.close();
  }
  return stages;
}

async function main(): Promise<number> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-accounts-check-'));
  const server = createAliceServer({
    env: {
      ALICE_ACCOUNTS: 'on',
      ALICE_ACCOUNTS_SHOP: 'on',
      ALICE_DB_PATH: path.join(dataDir, 'alice.db'),
      LIVEKIT_URL: 'wss://example.invalid',
      LIVEKIT_API_KEY: 'APIaccountscheck',
      LIVEKIT_API_SECRET: 'not-a-real-secret-not-a-real-secret-0000',
    },
    calllog: () => {},
    store: { storefront: offline, searchMixed: offline, search: offline, getProduct: offline, sizeVariant: offline, createCart: offline },
    loadLibrary: async () => null,
    shopSignIn,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let browser: Browser | null = null;
  let failed = 0;
  try {
    browser = await chromium.launch({ headless: true });
    const runs: Array<[string, { width: number; height: number }, boolean]> = [
      ['desktop-1440', { width: 1440, height: 900 }, false],
      ['phone-390', { width: 390, height: 844 }, true],
    ];
    for (const [label, viewport, mobile] of runs) {
      const stages = await runAt(browser, baseUrl, label, viewport, mobile);
      console.log(`\n${label}`);
      for (const s of stages) {
        console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.detail ? `\n       ${s.detail}` : ''}`);
        if (!s.ok) failed += 1;
      }
    }
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(failed === 0 ? '\naccounts-check: all stages passed' : `\naccounts-check: ${failed} stage(s) FAILED`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
