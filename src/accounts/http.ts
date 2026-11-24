// Shopper accounts over HTTP: the /api/account routes and the session cookie.
//
// server.ts owns the listener and hands requests under /api/account to `handle`. It also
// calls `callContext` when it mints a call token, to learn who (if anyone) is signed in.
// Everything that touches the database goes through the Accounts service in index.ts.
//
// Switched off unless ALICE_ACCOUNTS is on: `handle` then answers nothing and the routes
// fall through to the server's usual 404.
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cleanTicket, encodeCallMemory, toCallShopper, type CallShopper } from './call-memory.ts';
import { createAttemptLimiter, type AttemptLimiter } from './limiter.ts';
import { cleanName, emptyMemory, type ShopperMemory } from './memory.ts';
import { HashBusyError, MIN_PASSWORD_LENGTH } from './passwords.ts';
import type { Accounts, PublicAccount, SessionGrant } from './index.ts';
import { isShopSignInEnabled, type ShopSignIn } from './shop-signin.ts';

export const SESSION_COOKIE = 'alice_session';
/**
 * The name used over HTTPS. A browser only accepts a "__Host-" cookie from the exact host,
 * over HTTPS, so a page on a sibling subdomain cannot plant one.
 */
export const SECURE_SESSION_COOKIE = '__Host-alice_session';
const TICKET_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_TICKETS = 20_000;
/** Ties a pending "Sign in with Shop" to the browser that started it. */
export const SHOP_FLOW_COOKIE = 'alice_shop_flow';
/** Over HTTPS, for the same reason as the session cookie: only this exact host can set it. */
export const SECURE_SHOP_FLOW_COOKIE = '__Host-alice_shop_flow';
export const ACCOUNT_ROUTE_PREFIX = '/api/account';
export const DEFAULT_MAX_ACCOUNTS = 5000;
const MAX_CREDENTIALS_BODY_BYTES = 4 * 1024;
const MAX_MEMORY_BODY_BYTES = 24 * 1024;
const MAX_COOKIE_HEADER_LENGTH = 8 * 1024;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

type Env = Record<string, string | undefined>;

export type JsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: 'body_too_large' | 'invalid_json' };

export interface AccountHttpDeps {
  /** Returns the service, opening the database on first use. May throw. */
  getAccounts(env: Env): Accounts;
  /** The "Sign in with Shop" flow. Left out, or ALICE_ACCOUNTS_SHOP off, means no such routes. */
  getShopSignIn?(env: Env): ShopSignIn;
  sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void;
  readJsonBody(req: IncomingMessage, maxBytes: number): Promise<JsonBodyResult>;
  clientAddress(req: IncomingMessage, env: Env): string;
  originMatchesHost(origin: string | string[] | undefined, host: string | string[] | undefined): boolean;
  log(ev: string, data?: Record<string, unknown>): void;
  now?: () => number;
}

export interface CallContext {
  /** Participant name for the call token, when the signed-in shopper has one. */
  displayName: string | null;
  /** JSON for the agent dispatch metadata (see call-memory.ts). */
  dispatchMetadata: string;
  signedIn: boolean;
}

export interface AccountRoutes {
  enabled(env: Env): boolean;
  /** Answers the request and returns true, or returns false to let the server carry on. */
  handle(req: IncomingMessage, res: ServerResponse, pathname: string, env: Env): Promise<boolean>;
  /** Never throws: a broken database means "nobody is signed in", not a failed call. */
  callContext(req: IncomingMessage, env: Env): CallContext | null;
}

export function isAccountsEnabled(env: Env): boolean {
  const raw = env.ALICE_ACCOUNTS?.trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes';
}

function parseMaxAccounts(env: Env): number {
  const raw = env.ALICE_ACCOUNTS_MAX?.trim();
  if (!raw) return DEFAULT_MAX_ACCOUNTS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_ACCOUNTS;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const first = raw.split(',')[0]?.trim();
  return first || undefined;
}

/** Reads one cookie by name. Returns undefined when it is absent or the header is odd. */
export function readCookie(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (typeof raw !== 'string' || !raw || raw.length > MAX_COOKIE_HEADER_LENGTH) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value || undefined;
  }
  return undefined;
}

function isLocalHostHeader(host: string | string[] | undefined): boolean {
  const raw = (Array.isArray(host) ? host[0] : host)?.trim().toLowerCase();
  if (!raw) return false;
  const name = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}

/**
 * Whether to treat the connection as HTTPS, which decides the cookie's name and Secure
 * flag. True for a TLS socket, for a proxy that says it terminated HTTPS, and for any
 * host that is not this machine: off localhost the site is expected to be served over
 * HTTPS, and a session cookie must never travel in the clear. (So accounts do not work
 * over plain HTTP on another machine's address; that is on purpose.)
 */
export function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted === true) return true;
  if (firstHeader(req.headers['x-forwarded-proto'])?.toLowerCase() === 'https') return true;
  return !isLocalHostHeader(req.headers.host);
}

export function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

export function sessionCookieHeader(session: SessionGrant, nowMs: number, secure: boolean): string {
  // Rounded up: the server decides when a session ends, so the cookie may outlive it by
  // a fraction of a second but never ends early.
  const maxAge = Math.max(0, Math.ceil((session.expires_at - nowMs) / 1000));
  return [
    `${sessionCookieName(secure)}=${session.token}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function shopFlowCookieName(secure: boolean): string {
  return secure ? SECURE_SHOP_FLOW_COOKIE : SHOP_FLOW_COOKIE;
}

export function shopFlowCookieHeader(flowId: string, maxAgeS: number, secure: boolean): string {
  return [
    `${shopFlowCookieName(secure)}=${flowId}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeS))}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedShopFlowCookieHeader(secure: boolean): string {
  return shopFlowCookieHeader('', 0, secure);
}

export function clearedCookieHeader(secure: boolean): string {
  return [`${sessionCookieName(secure)}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : [])].join(
    '; ',
  );
}

function publicView(account: PublicAccount): Record<string, unknown> {
  return {
    email: account.email,
    name: account.display_name,
    provider: account.provider,
    created_at: account.created_at,
  };
}

export function createAccountRoutes(deps: AccountHttpDeps): AccountRoutes {
  const now = deps.now ?? (() => Date.now());
  const limiter = (max: number, windowMs: number): AttemptLimiter => createAttemptLimiter({ max, windowMs, now });

  const readsPerIp = limiter(120, 60_000);
  const signInPerIp = limiter(20, 10 * 60_000);
  // Wrong guesses are counted per address-and-visitor pair, so a stranger hammering an
  // address cannot lock its owner out from somewhere else. A looser ceiling per address
  // alone still slows a guesser who spreads over many networks.
  const signInFailuresPerPair = limiter(8, 15 * 60_000);
  const signInFailuresPerEmail = limiter(50, 60 * 60_000);
  const signUpPerIp = limiter(5, 60 * 60_000);
  const signUpGlobal = limiter(200, 60 * 60_000);
  // Refused sign-ups (bad address, short password, address already taken) are counted
  // apart from accounts actually made, so a typo does not use up the five an hour, while
  // someone probing which addresses have accounts still runs out of tries.
  const signUpRefusalsPerIp = limiter(30, 60 * 60_000);
  const writesPerAccount = limiter(60, 60_000);
  const writesPerIp = limiter(120, 60_000);
  const shopStartsPerIp = limiter(6, 10 * 60_000);
  const shopPollsPerIp = limiter(60, 60_000);
  let lastPruneMs = -Infinity;
  let warnedUnavailable = false;

  function send(
    res: ServerResponse,
    status: number,
    body: unknown,
    extra?: Record<string, string>,
  ): void {
    deps.sendJson(res, status, body, { ...NO_STORE, ...(extra ?? {}) });
  }

  function slowDown(res: ServerResponse, retryAfterS: number): void {
    const wait = Math.max(1, retryAfterS);
    send(res, 429, { error: 'slow_down', retry_after_s: wait }, { 'Retry-After': String(wait) });
  }

  /** Runs a sign-up or sign-in; answers "busy" itself when too many are already waiting. */
  async function withHashing<T>(res: ServerResponse, action: string, work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof HashBusyError)) throw err;
      deps.log('account_refused', { action, reason: 'busy' });
      send(res, 503, { error: 'busy', retry_after_s: 5 }, { 'Retry-After': '5' });
      return null;
    }
  }

  function service(env: Env): Accounts | null {
    try {
      const accounts = deps.getAccounts(env);
      const t = now();
      if (t - lastPruneMs >= PRUNE_INTERVAL_MS) {
        lastPruneMs = t;
        accounts.pruneExpired();
      }
      return accounts;
    } catch (err) {
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        console.error('[accounts] database unavailable:', (err as Error)?.message);
      }
      deps.log('account_error', { reason: 'database_unavailable' });
      return null;
    }
  }

  /**
   * Guards every request that changes something. A cross-site page cannot pass it: the
   * browser reports the request as cross-site, sends a foreign Origin, and (because the
   * cookie is SameSite=Lax) does not attach the session at all.
   */
  function sameOrigin(req: IncomingMessage): boolean {
    const fetchSite = firstHeader(req.headers['sec-fetch-site'])?.toLowerCase();
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true; // not a browser; there is no ambient cookie to abuse
    if (deps.originMatchesHost(origin, req.headers.host)) return true;
    // A proxy may rewrite Host; the host the browser actually asked for is forwarded.
    const forwardedHost = firstHeader(req.headers['x-forwarded-host']);
    return forwardedHost !== undefined && deps.originMatchesHost(origin, forwardedHost);
  }

  function isJson(req: IncomingMessage): boolean {
    const header = req.headers['content-type'];
    const raw = Array.isArray(header) ? header[0] : header;
    return typeof raw === 'string' && raw.split(';')[0]?.trim().toLowerCase() === 'application/json';
  }

  /** Runs the shared checks for a changing request and returns its JSON body, or null if it already answered. */
  async function guardedBody(
    req: IncomingMessage,
    res: ServerResponse,
    maxBytes: number,
  ): Promise<Record<string, unknown> | null> {
    if (!sameOrigin(req)) {
      deps.log('account_refused', { reason: 'bad_origin' });
      send(res, 403, { error: 'bad_origin' });
      return null;
    }
    if (!isJson(req)) {
      send(res, 415, { error: 'json_only' });
      return null;
    }
    const read = await deps.readJsonBody(req, maxBytes);
    if (!read.ok) {
      if (read.reason === 'body_too_large') {
        res.once('finish', () => req.destroy());
        send(res, 413, { error: 'body_too_large' }, { Connection: 'close' });
      } else {
        send(res, 400, { error: 'bad_request' });
      }
      return null;
    }
    return read.body;
  }

  /** The session token from the cookie that belongs to this kind of connection. */
  function sessionToken(req: IncomingMessage): string | undefined {
    return readCookie(req.headers.cookie, sessionCookieName(isSecureRequest(req)));
  }

  function currentAccount(req: IncomingMessage, accounts: Accounts): PublicAccount | null {
    return accounts.sessionAccount(sessionToken(req));
  }

  // ---- save tickets ---------------------------------------------------------------
  // One per call, made when a signed-in shopper's call token is minted. The agent gets
  // it in its job metadata and returns it with every saveMemory. A save is accepted only
  // when its ticket belongs to the same account as the browser's session, so what Alice
  // learned in one person's call can never land in another person's account (a second
  // tab that signed in as someone else, a link that points the page at a stranger's room).
  const tickets = new Map<string, { accountId: string; expiresAt: number }>();
  const ticketKey = (ticket: string): string => crypto.createHash('sha256').update(ticket, 'utf8').digest('hex');

  function issueTicket(accountId: string): string {
    const t = now();
    if (tickets.size >= MAX_TICKETS) {
      for (const [key, entry] of tickets) {
        if (entry.expiresAt <= t) tickets.delete(key);
      }
      while (tickets.size >= MAX_TICKETS) {
        const oldest = tickets.keys().next();
        if (oldest.done) break;
        tickets.delete(oldest.value);
      }
    }
    const ticket = crypto.randomBytes(24).toString('base64url');
    tickets.set(ticketKey(ticket), { accountId, expiresAt: t + TICKET_TTL_MS });
    return ticket;
  }

  function ticketAccountId(raw: unknown): string | null {
    const ticket = cleanTicket(raw);
    if (!ticket) return null;
    const key = ticketKey(ticket);
    const entry = tickets.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      tickets.delete(key);
      return null;
    }
    return entry.accountId;
  }

  function revokeTickets(accountId: string): void {
    for (const [key, entry] of tickets) {
      if (entry.accountId === accountId) tickets.delete(key);
    }
  }

  function signedInPayload(account: PublicAccount, memory: ShopperMemory): Record<string, unknown> {
    return { enabled: true, account: publicView(account), memory };
  }

  function shopSignIn(env: Env): ShopSignIn | null {
    if (!deps.getShopSignIn || !isShopSignInEnabled(env)) return null;
    try {
      return deps.getShopSignIn(env);
    } catch {
      return null;
    }
  }

  /** The three routes under /api/account/shop. Always answers. */
  async function handleShop(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
    env: Env,
    accounts: Accounts,
    shop: ShopSignIn,
    ip: string,
    secure: boolean,
  ): Promise<void> {
    const body = await guardedBody(req, res, MAX_CREDENTIALS_BODY_BYTES);
    if (!body) return;
    const flowId = readCookie(req.headers.cookie, shopFlowCookieName(secure));
    const clearFlow = clearedShopFlowCookieHeader(secure);

    if (route === '/shop/start') {
      if (!shopStartsPerIp.hit(`shop-start:${ip}`)) {
        slowDown(res, shopStartsPerIp.retryAfterS(`shop-start:${ip}`));
        return;
      }
      if (flowId) shop.cancel(flowId); // one pending sign-in per browser
      const started = await shop.start();
      if (!started.ok) {
        send(res, 503, { error: started.reason === 'busy' ? 'busy' : 'shop_unavailable' }, { 'Retry-After': '5' });
        return;
      }
      send(
        res,
        200,
        { status: 'pending', url: started.url, code: started.code, expires_in_s: started.expires_in_s, interval_s: started.interval_s },
        { 'Set-Cookie': shopFlowCookieHeader(started.flow_id, started.expires_in_s, secure) },
      );
      return;
    }

    if (route === '/shop/cancel') {
      if (flowId) shop.cancel(flowId);
      send(res, 200, { ok: true }, { 'Set-Cookie': clearFlow });
      return;
    }

    // /shop/poll
    if (!shopPollsPerIp.hit(`shop-poll:${ip}`)) {
      slowDown(res, shopPollsPerIp.retryAfterS(`shop-poll:${ip}`));
      return;
    }
    const result = await shop.poll(flowId);
    if (result.status === 'pending') {
      send(res, 200, { status: 'pending', interval_s: result.interval_s });
      return;
    }
    if (result.status !== 'signed_in') {
      deps.log('account', { action: 'shop_signin', ok: false, reason: result.status });
      send(res, 200, { status: result.status }, { 'Set-Cookie': clearFlow });
      return;
    }
    const signedIn = accounts.signInWithShop(
      { sub: result.identity.sub, email: result.identity.email, name: result.identity.name },
      { maxAccounts: parseMaxAccounts(env) },
    );
    if (!signedIn.ok) {
      deps.log('account', { action: 'shop_signin', ok: false, reason: signedIn.code });
      send(res, signedIn.code === 'accounts_full' ? 503 : 400, { error: signedIn.code }, { 'Set-Cookie': clearFlow });
      return;
    }
    // A browser that was signed in as someone else: end that session first.
    const previous = sessionToken(req);
    if (previous) accounts.signOut(previous);
    deps.log('account', { action: 'shop_signin', ok: true, created: signedIn.created });
    // Two cookies in one answer: the new session, and the spent sign-in marker cleared.
    res.setHeader('Set-Cookie', [sessionCookieHeader(signedIn.session, now(), secure), clearFlow]);
    send(res, 200, { status: 'signed_in', ...signedInPayload(signedIn.account, accounts.getMemory(signedIn.account.id)) });
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    env: Env,
  ): Promise<boolean> {
    if (pathname !== ACCOUNT_ROUTE_PREFIX && !pathname.startsWith(`${ACCOUNT_ROUTE_PREFIX}/`)) return false;
    if (!isAccountsEnabled(env)) return false;

    const method = (req.method ?? 'GET').toUpperCase();
    const route = pathname.slice(ACCOUNT_ROUTE_PREFIX.length) || '/';
    const ip = deps.clientAddress(req, env);
    const secure = isSecureRequest(req);

    const allowed: Record<string, string[]> = {
      '/': ['GET', 'DELETE'],
      '/signup': ['POST'],
      '/signin': ['POST'],
      '/signout': ['POST'],
      '/memory': ['PUT', 'DELETE'],
    };
    const shop = shopSignIn(env);
    if (shop) {
      allowed['/shop/start'] = ['POST'];
      allowed['/shop/poll'] = ['POST'];
      allowed['/shop/cancel'] = ['POST'];
    }
    const methods = allowed[route];
    if (!methods) return false; // unknown path under /api/account: the server's 404
    if (!methods.includes(method)) {
      send(res, 405, { error: 'method_not_allowed' }, { Allow: methods.join(', ') });
      return true;
    }

    const accounts = service(env);
    if (!accounts) {
      send(res, 503, { error: 'accounts_unavailable' });
      return true;
    }

    // ---- GET /api/account: who is signed in, and what Alice remembers --------------
    if (route === '/' && method === 'GET') {
      if (!readsPerIp.hit(`read:${ip}`)) {
        slowDown(res, readsPerIp.retryAfterS(`read:${ip}`));
        return true;
      }
      const account = currentAccount(req, accounts);
      const shopOn = shop !== null;
      if (!account) {
        send(res, 200, { enabled: true, account: null, min_password_length: MIN_PASSWORD_LENGTH, shop_sign_in: shopOn });
        return true;
      }
      send(res, 200, { ...signedInPayload(account, accounts.getMemory(account.id)), shop_sign_in: shopOn });
      return true;
    }

    // ---- POST /api/account/shop/*: sign in with Shop -----------------------------------
    if (shop && route.startsWith('/shop/')) {
      await handleShop(req, res, route, env, accounts, shop, ip, secure);
      return true;
    }

    // ---- POST /api/account/signup ----------------------------------------------------
    if (route === '/signup') {
      const body = await guardedBody(req, res, MAX_CREDENTIALS_BODY_BYTES);
      if (!body) return true;
      if (
        signUpPerIp.blocked(`signup:${ip}`) ||
        signUpGlobal.blocked('signup') ||
        signUpRefusalsPerIp.blocked(`signup-refused:${ip}`)
      ) {
        deps.log('account_refused', { action: 'signup', reason: 'slow_down' });
        slowDown(
          res,
          Math.max(
            signUpPerIp.retryAfterS(`signup:${ip}`),
            signUpGlobal.retryAfterS('signup'),
            signUpRefusalsPerIp.retryAfterS(`signup-refused:${ip}`),
          ),
        );
        return true;
      }
      const maxAccounts = parseMaxAccounts(env);
      if (accounts.countAccounts() >= maxAccounts) {
        deps.log('account_refused', { action: 'signup', reason: 'accounts_full' });
        send(res, 503, { error: 'accounts_full' });
        return true;
      }
      // Take the place in line before the slow part (hashing), so a burst of requests
      // that are all in flight together cannot each see "still under the limit".
      signUpPerIp.hit(`signup:${ip}`);
      signUpGlobal.hit('signup');
      const giveBack = (): void => {
        signUpPerIp.unhit(`signup:${ip}`);
        signUpGlobal.unhit('signup');
      };
      let result: Awaited<ReturnType<Accounts['signUp']>> | null;
      try {
        result = await withHashing(res, 'signup', () =>
          accounts.signUp({ email: body.email, password: body.password, display_name: body.name, max_accounts: maxAccounts }),
        );
      } catch (err) {
        giveBack();
        throw err;
      }
      if (!result) {
        giveBack(); // told "busy": no account was made
        return true;
      }
      if (!result.ok) {
        giveBack();
        signUpRefusalsPerIp.hit(`signup-refused:${ip}`);
        deps.log('account', { action: 'signup', ok: false, reason: result.code });
        if (result.code === 'accounts_full') {
          send(res, 503, { error: 'accounts_full' });
        } else if (result.code === 'email_taken') {
          send(res, 409, { error: 'email_taken' });
        } else if (result.code === 'weak_password') {
          send(res, 400, { error: 'weak_password', problem: result.problem, min_length: MIN_PASSWORD_LENGTH });
        } else {
          send(res, 400, { error: result.code });
        }
        return true;
      }
      deps.log('account', { action: 'signup', ok: true });
      send(res, 201, signedInPayload(result.account, emptyMemory()), {
        'Set-Cookie': sessionCookieHeader(result.session, now(), secure),
      });
      return true;
    }

    // ---- POST /api/account/signin ----------------------------------------------------
    if (route === '/signin') {
      const body = await guardedBody(req, res, MAX_CREDENTIALS_BODY_BYTES);
      if (!body) return true;
      const address = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : null;
      const ipKey = `signin:${ip}`;
      const pairKey = address !== null ? `signin:pair:${address}|${ip}` : null;
      const emailKey = address !== null ? `signin:email:${address}` : null;
      if (
        signInPerIp.blocked(ipKey) ||
        (pairKey !== null && signInFailuresPerPair.blocked(pairKey)) ||
        (emailKey !== null && signInFailuresPerEmail.blocked(emailKey))
      ) {
        deps.log('account_refused', { action: 'signin', reason: 'slow_down' });
        slowDown(
          res,
          Math.max(
            signInPerIp.retryAfterS(ipKey),
            pairKey !== null ? signInFailuresPerPair.retryAfterS(pairKey) : 0,
            emailKey !== null ? signInFailuresPerEmail.retryAfterS(emailKey) : 0,
          ),
        );
        return true;
      }
      // Counted as a failure up front and taken back on success, so guesses that are all
      // in flight at once cannot each pass the check above before any of them is counted.
      signInPerIp.hit(ipKey);
      if (pairKey !== null) signInFailuresPerPair.hit(pairKey);
      if (emailKey !== null) signInFailuresPerEmail.hit(emailKey);
      const uncount = (): void => {
        if (pairKey !== null) signInFailuresPerPair.unhit(pairKey);
        if (emailKey !== null) signInFailuresPerEmail.unhit(emailKey);
      };
      let result: Awaited<ReturnType<Accounts['signIn']>> | null;
      try {
        result = await withHashing(res, 'signin', () => accounts.signIn({ email: body.email, password: body.password }));
      } catch (err) {
        uncount();
        throw err;
      }
      if (!result) {
        uncount(); // told "busy": the password was never checked
        signInPerIp.unhit(ipKey);
        return true;
      }
      if (!result.ok) {
        deps.log('account', { action: 'signin', ok: false });
        send(res, 401, { error: 'bad_credentials' });
        return true;
      }
      if (pairKey !== null) signInFailuresPerPair.reset(pairKey);
      if (emailKey !== null) signInFailuresPerEmail.unhit(emailKey);
      // A browser that was signed in as someone else: end that session first.
      const previous = sessionToken(req);
      if (previous) accounts.signOut(previous);
      deps.log('account', { action: 'signin', ok: true });
      send(res, 200, signedInPayload(result.account, accounts.getMemory(result.account.id)), {
        'Set-Cookie': sessionCookieHeader(result.session, now(), secure),
      });
      return true;
    }

    // ---- POST /api/account/signout ---------------------------------------------------
    if (route === '/signout') {
      const body = await guardedBody(req, res, MAX_CREDENTIALS_BODY_BYTES);
      if (!body) return true;
      const ended = accounts.signOut(sessionToken(req));
      deps.log('account', { action: 'signout', ok: ended });
      send(res, 200, { ok: true }, { 'Set-Cookie': clearedCookieHeader(secure) });
      return true;
    }

    // Everything below needs a signed-in shopper.
    const body = await guardedBody(req, res, MAX_MEMORY_BODY_BYTES);
    if (!body) return true;
    const account = currentAccount(req, accounts);
    if (!account) {
      send(res, 401, { error: 'not_signed_in' });
      return true;
    }
    if (!writesPerAccount.hit(`write:${account.id}`) || !writesPerIp.hit(`write:${ip}`)) {
      slowDown(res, Math.max(writesPerAccount.retryAfterS(`write:${account.id}`), writesPerIp.retryAfterS(`write:${ip}`)));
      return true;
    }

    // ---- PUT /api/account/memory: add to what Alice remembers ------------------------
    if (route === '/memory' && method === 'PUT') {
      // Only the call that this account started may add to its memory.
      if (ticketAccountId(body.ticket) !== account.id) {
        deps.log('account_refused', { action: 'memory_saved', reason: 'wrong_call' });
        send(res, 403, { error: 'wrong_call' });
        return true;
      }
      let current = account;
      if (!account.display_name && Object.hasOwn(body, 'name')) {
        // Alice may fill in a missing name. She never replaces one the shopper already
        // has: a note about someone else ("her name is Maya") must not rename the account.
        const name = cleanName(body.name);
        if (name) current = accounts.setDisplayName(account.id, name) ?? account;
      }
      const memory = accounts.saveMemory(account.id, {
        department: body.department,
        sizes: body.sizes,
        facts: body.facts,
      });
      deps.log('account', { action: 'memory_saved', facts: memory.facts.length, sizes: Object.keys(memory.sizes).length });
      send(res, 200, signedInPayload(current, memory));
      return true;
    }

    // ---- DELETE /api/account/memory: forget everything --------------------------------
    if (route === '/memory' && method === 'DELETE') {
      accounts.clearMemory(account.id);
      // A call in progress still holds what it learned; stop it from saving it back.
      revokeTickets(account.id);
      deps.log('account', { action: 'memory_cleared' });
      send(res, 200, signedInPayload(account, emptyMemory()));
      return true;
    }

    // ---- DELETE /api/account: delete the account and everything stored with it -------
    if (route === '/' && method === 'DELETE') {
      accounts.deleteAccount(account.id);
      revokeTickets(account.id);
      deps.log('account', { action: 'deleted' });
      send(res, 200, { ok: true }, { 'Set-Cookie': clearedCookieHeader(secure) });
      return true;
    }

    return false;
  }

  function callContext(req: IncomingMessage, env: Env): CallContext | null {
    if (!isAccountsEnabled(env)) return null;
    let shopper: CallShopper | null = null;
    let ticket: string | null = null;
    try {
      const accounts = service(env);
      const account = accounts ? currentAccount(req, accounts) : null;
      if (accounts && account) {
        shopper = toCallShopper(account.display_name, accounts.getMemory(account.id));
        ticket = issueTicket(account.id);
      }
    } catch (err) {
      console.error('[accounts] could not read memory for a call:', (err as Error)?.message);
      shopper = null;
      ticket = null;
    }
    return {
      displayName: shopper?.name ?? null,
      dispatchMetadata: encodeCallMemory({ accounts: true, shopper, ticket }),
      signedIn: shopper !== null,
    };
  }

  return { enabled: isAccountsEnabled, handle, callContext };
}
