// Password hashing for shopper accounts: scrypt from node:crypto, one random salt per
// password, parameters stored next to the hash so they can be raised later.
import crypto from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

// 128 * N * r bytes of memory per hash = 32 MiB, run three times over (p). This is one of
// the scrypt settings OWASP's password storage guidance lists. Raise N when the server
// has the memory for it; older hashes are upgraded at the next sign-in.
export const DEFAULT_SCRYPT: ScryptParams = { N: 32768, r: 8, p: 3 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';

// Bounds for parameters read back from a stored hash, so a corrupted row cannot ask for
// gigabytes of memory.
const MAX_N = 1 << 20;
const MAX_R = 16;
const MAX_P = 4;

function maxmemFor(params: ScryptParams): number {
  return 128 * params.N * params.r * 2 + 1024 * 1024;
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

function validParams(params: ScryptParams): boolean {
  return (
    isPowerOfTwo(params.N) &&
    params.N <= MAX_N &&
    Number.isInteger(params.r) &&
    params.r >= 1 &&
    params.r <= MAX_R &&
    Number.isInteger(params.p) &&
    params.p >= 1 &&
    params.p <= MAX_P
  );
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params) },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export type PasswordProblem = 'too_short' | 'too_long' | 'not_text';

/** Length rules only: no forced symbols or digits. */
export function checkPassword(password: unknown): PasswordProblem | null {
  if (typeof password !== 'string') return 'not_text';
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) return 'too_short';
  // Also bound the raw string so a huge body cannot keep scrypt busy.
  if (length > MAX_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH * 4) return 'too_long';
  return null;
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<string> {
  if (!validParams(params)) throw new Error('invalid scrypt parameters');
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, params);
  return [
    PREFIX,
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: unknown): ParsedHash | null {
  if (typeof stored !== 'string' || stored.length > 512) return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const params: ScryptParams = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
  if (!validParams(params)) return null;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const key = Buffer.from(parts[5]!, 'base64url');
  if (salt.length < 8 || key.length !== KEY_LENGTH) return null;
  return { params, salt, key };
}

/** True only when the password matches. Never throws on a malformed stored hash. */
export async function verifyPassword(password: unknown, stored: unknown): Promise<boolean> {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH * 4) return false;
  const parsed = parseHash(stored);
  if (!parsed) return false;
  let candidate: Buffer;
  try {
    candidate = await derive(password, parsed.salt, parsed.params);
  } catch {
    return false;
  }
  return candidate.length === parsed.key.length && crypto.timingSafeEqual(candidate, parsed.key);
}

/** True when a stored hash uses weaker parameters than today's default. */
export function needsRehash(stored: unknown, params: ScryptParams = DEFAULT_SCRYPT): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return parsed.params.N < params.N || parsed.params.r < params.r || parsed.params.p < params.p;
}

// A real hash of a random password, made once. Sign-in verifies against it when the email
// is unknown, so "no such account" takes as long as "wrong password".
const decoyHashes = new Map<string, Promise<string>>();
export function getDecoyHash(params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const key = `${params.N}:${params.r}:${params.p}`;
  let decoy = decoyHashes.get(key);
  if (!decoy) {
    decoy = hashPassword(crypto.randomBytes(24).toString('base64url'), params);
    decoyHashes.set(key, decoy);
  }
  return decoy;
}

/** Thrown when too many password checks are already queued. The caller answers "busy". */
export class HashBusyError extends Error {
  constructor() {
    super('too many password checks are waiting');
    this.name = 'HashBusyError';
  }
}

/**
 * Runs at most `limit` hashes at a time. Each hash holds about 32 MiB, so an unbounded
 * burst of sign-in requests could otherwise exhaust a small server. At most `maxWaiting`
 * more may queue; past that the job is refused at once, so a flood cannot build an
 * endless line in front of real shoppers.
 */
export function createHashGate(limit = 2, maxWaiting = 24): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  const release = (): void => {
    running -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  return async function gated<T>(job: () => Promise<T>): Promise<T> {
    if (running >= limit) {
      if (waiting.length >= maxWaiting) throw new HashBusyError();
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running += 1;
    try {
      return await job();
    } finally {
      release();
    }
  };
}
