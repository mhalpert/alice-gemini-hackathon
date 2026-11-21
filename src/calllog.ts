import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const MAX_STRING_LEN = 2000;

const startTimeCache = new Map<string, number>();

export function sanitizeRoomName(room: string): string {
  if (typeof room !== 'string') return 'unknown';
  const cleaned = room
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._]+/, '')
    .replace(/_+$/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

export function getLogDir(): string {
  const override = process.env.ALICE_LOG_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.resolve(process.cwd(), 'data', 'logs');
}

export function getCallLogPath(room: string): string {
  return path.join(getLogDir(), `${sanitizeRoomName(room)}.jsonl`);
}

const SECRET_ENV_VARS = [
  'GOOGLE_API_KEY',
  'GOOGLE_TRYON_API_KEY',
  'LIVEKIT_API_SECRET',
  'TAVUS_API_KEY',
  'ALICE_PASSCODE',
] as const;
const MIN_ENV_SECRET_LEN = 12;
const REDACT_PRE_TRUNCATE_LEN = MAX_STRING_LEN + 512;
const GOOGLE_KEY_RE = /AIza[0-9A-Za-z_-]{20,}/g;
const QUERY_KEY_RE = /([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"'<>]+/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

export function redactSecrets(text: string): string {
  if (text.length === 0) return text;
  let out = text;

  for (const name of SECRET_ENV_VARS) {
    const val = process.env[name];
    if (typeof val === 'string' && val.length >= MIN_ENV_SECRET_LEN && out.includes(val)) {
      out = out.split(val).join(`[redacted:${name}]`);
    }
  }

  out = out.replace(GOOGLE_KEY_RE, '[redacted:google-key]');
  out = out.replace(QUERY_KEY_RE, '$1[redacted]');
  out = out.replace(JWT_RE, '[redacted:jwt]');

  return out;
}

function truncateString(str: string): string {
  return str.length > MAX_STRING_LEN ? str.slice(0, MAX_STRING_LEN) : str;
}

function sanitizeString(str: string): string {
  const bounded =
    str.length > REDACT_PRE_TRUNCATE_LEN ? str.slice(0, REDACT_PRE_TRUNCATE_LEN) : str;
  return truncateString(redactSecrets(bounded));
}

export function sanitizeValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return sanitizeString(value.toString());
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Error) {
    const out: { message: string; stack?: string } = {
      message: sanitizeString(typeof value.message === 'string' ? value.message : String(value)),
    };
    if (typeof value.stack === 'string') {
      out.stack = sanitizeString(value.stack);
    }
    return out;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        try {
          arr.push(sanitizeValue(value[i], seen));
        } catch {
          arr.push('[Unreadable]');
        }
      }
      return arr;
    }

    const out: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(value as Record<string, unknown>);
    } catch {
      return '[Unreadable]';
    }
    for (const key of keys) {
      try {
        const sanitized = sanitizeValue((value as Record<string, unknown>)[key], seen);
        if (sanitized !== undefined) {
          out[key] = sanitized;
        }
      } catch {
        out[key] = '[Unreadable]';
      }
    }
    return out;
  }

  return sanitizeString(String(value));
}

function getOrInitStartTime(filePath: string, nowMs: number): number {
  const cached = startTimeCache.get(filePath);
  if (cached !== undefined) return cached;

  let startMs = nowMs;
  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf8');
      const nl = content.indexOf('\n');
      const firstLine = (nl === -1 ? content : content.slice(0, nl)).trim();
      if (firstLine.length > 0) {
        const parsed = JSON.parse(firstLine) as { t?: unknown };
        if (typeof parsed.t === 'string') {
          const parsedMs = Date.parse(parsed.t);
          if (Number.isFinite(parsedMs)) {
            startMs = parsedMs;
          }
        }
      }
    } catch {
      // Fall back to nowMs if unreadable or malformed.
    }
  }

  startTimeCache.set(filePath, startMs);
  return startMs;
}

export function calllog(room: string, ev: string, data?: Record<string, unknown>): void {
  try {
    const dir = getLogDir();
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sanitizeRoomName(room)}.jsonl`);

    const nowMs = Date.now();
    const startMs = getOrInitStartTime(filePath, nowMs);
    const ms = Math.max(0, nowMs - startMs);
    const t = new Date(nowMs).toISOString();

    const record: Record<string, unknown> = {
      t,
      ms,
      pid: process.pid,
      ev: truncateString(String(ev)),
    };

    if (data && typeof data === 'object') {
      const sanitized = sanitizeValue(data);
      if (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
        for (const [key, val] of Object.entries(sanitized as Record<string, unknown>)) {
          if (key === 't' || key === 'pid' || key === 'ev') continue;
          if (key === 'ms') {
            if (!('duration_ms' in record)) {
              record.duration_ms = val;
            }
            continue;
          }
          record[key] = val;
        }
      }
    }

    appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // calllog must never throw.
  }
}

export function startCallLog(room: string): { restarted: boolean; prevPid?: number } {
  let prevPid: number | undefined;
  try {
    const filePath = getCallLogPath(room);
    if (existsSync(filePath)) {
      const lines = readFileSync(filePath, 'utf8').split('\n');
      for (const raw of lines) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { pid?: unknown };
          if (typeof parsed.pid === 'number' && parsed.pid !== process.pid) {
            prevPid = parsed.pid;
          }
        } catch {
          // Ignore malformed lines.
        }
      }
    }
  } catch {
    // Never throw.
  }

  calllog(room, 'job_start');
  if (prevPid !== undefined) {
    calllog(room, 'restart', { prev_pid: prevPid });
    return { restarted: true, prevPid };
  }
  return { restarted: false };
}

export function installCrashLogging(room: string): () => void {
  const onUncaughtMonitor = (err: Error, origin: string) => {
    calllog(room, 'uncaught_exception', { error: err, origin });
  };

  const onUnhandledRejection = (reason: unknown) => {
    calllog(room, 'unhandled_rejection', {
      error: reason instanceof Error ? reason : String(reason),
    });
  };

  const onExit = (code: number) => {
    calllog(room, 'process_exit', { code });
  };

  process.on('uncaughtExceptionMonitor', onUncaughtMonitor);
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('exit', onExit);

  return () => {
    process.off('uncaughtExceptionMonitor', onUncaughtMonitor);
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('exit', onExit);
  };
}
