import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogDir, sanitizeRoomName } from '../src/calllog.ts';

export const BAD_EVENTS = new Set([
  'restart',
  'session_error',
  'tool_error',
  'page_error',
  'tavus_error',
  'media_process_exit',
  'uncaught_exception',
  'unhandled_rejection',
  'frame_error',
  'false_interruption',
]);

export const HIDDEN_BY_DEFAULT = new Set(['agent_state', 'user_state']);

export interface CallLogEntry {
  t?: string;
  ms?: number;
  pid?: number;
  ev?: string;
  [key: string]: unknown;
}

export function isBadEvent(entry: CallLogEntry): boolean {
  if (typeof entry.ev === 'string' && BAD_EVENTS.has(entry.ev)) {
    return true;
  }
  if (
    'error' in entry &&
    entry.error !== undefined &&
    entry.error !== null &&
    entry.error !== false &&
    entry.error !== ''
  ) {
    return true;
  }
  return false;
}

function formatClock(iso?: string): string {
  if (!iso) return '??:??:??.???';
  const tIdx = iso.indexOf('T');
  if (tIdx !== -1) {
    return iso.slice(tIdx + 1, tIdx + 13);
  }
  return iso.slice(0, 12);
}

function formatCompactValue(val: unknown): string {
  if (typeof val === 'string') {
    const oneLine = val.replace(/\s+/g, ' ').trim();
    const clipped = oneLine.length > 140 ? `${oneLine.slice(0, 137)}...` : oneLine;
    return JSON.stringify(clipped);
  }
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      const clipped = obj.message.length > 140 ? `${obj.message.slice(0, 137)}...` : obj.message;
      return JSON.stringify(clipped);
    }
    const serialized = JSON.stringify(val);
    return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized;
  }
  return String(val);
}

export function formatTimelineLine(entry: CallLogEntry): string {
  const prefix = isBadEvent(entry) ? '!!' : '  ';
  const clock = formatClock(entry.t);
  const secs = typeof entry.ms === 'number' ? `+${(entry.ms / 1000).toFixed(2)}s`.padStart(8) : '   ?.??s';
  const pid = typeof entry.pid === 'number' ? String(entry.pid).padStart(6) : '     ?';
  const ev = String(entry.ev ?? 'unknown').padEnd(20);

  const parts: string[] = [];
  for (const [k, v] of Object.entries(entry)) {
    if (k === 't' || k === 'ms' || k === 'pid' || k === 'ev') continue;
    parts.push(`${k}=${formatCompactValue(v)}`);
  }

  const tail = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  return `${prefix} ${clock} ${secs} [${pid}] ${ev}${tail}`;
}

export function parseCallLogFile(filePath: string): CallLogEntry[] {
  const text = readFileSync(filePath, 'utf8');
  const entries: CallLogEntry[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as CallLogEntry);
    } catch {
      entries.push({ ev: 'parse_error', error: 'invalid JSON line', raw: trimmed });
    }
  }
  return entries;
}

export interface CallSummary {
  room: string;
  filePath: string;
  startTime: string;
  mtimeMs: number;
  events: number;
  errors: number;
}

export function listCallLogs(logDir: string = getLogDir()): CallSummary[] {
  if (!existsSync(logDir)) return [];
  const files = readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
  const summaries: CallSummary[] = [];
  for (const file of files) {
    const filePath = path.join(logDir, file);
    const stat = statSync(filePath);
    const entries = parseCallLogFile(filePath);
    const errors = entries.filter(isBadEvent).length;
    const startTime = entries[0]?.t ?? new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();
    summaries.push({
      room: file.replace(/\.jsonl$/, ''),
      filePath,
      startTime,
      mtimeMs: stat.mtimeMs,
      events: entries.length,
      errors,
    });
  }
  summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return summaries;
}

export function resolveCallLogFile(roomArg: string | undefined, logDir: string = getLogDir()): string | null {
  if (!existsSync(logDir)) return null;
  if (roomArg) {
    const direct = path.join(logDir, roomArg.endsWith('.jsonl') ? roomArg : `${roomArg}.jsonl`);
    if (existsSync(direct)) return direct;
    const sanitized = path.join(logDir, `${sanitizeRoomName(roomArg)}.jsonl`);
    if (existsSync(sanitized)) return sanitized;
    return null;
  }
  const all = listCallLogs(logDir);
  return all[0]?.filePath ?? null;
}

export function renderCallTimeline(
  filePath: string,
  options: { errorsOnly?: boolean; showAll?: boolean } = {},
): string[] {
  const entries = parseCallLogFile(filePath);
  const lines: string[] = [];
  for (const entry of entries) {
    const bad = isBadEvent(entry);
    if (options.errorsOnly && !bad) continue;
    if (!options.showAll && !options.errorsOnly && typeof entry.ev === 'string' && HIDDEN_BY_DEFAULT.has(entry.ev) && !bad) {
      continue;
    }
    lines.push(formatTimelineLine(entry));
  }
  return lines;
}

export function runCli(argv: string[], logDir: string = getLogDir()): { exitCode: number; output: string } {
  let errorsOnly = false;
  let showAll = false;
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === '--errors') {
      errorsOnly = true;
    } else if (arg === '--all') {
      showAll = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional[0] === 'list') {
    const calls = listCallLogs(logDir);
    if (calls.length === 0) {
      return { exitCode: 0, output: `No call logs found in ${logDir}` };
    }
    const header = `${'ROOM'.padEnd(28)} ${'START'.padEnd(24)} ${'EVENTS'.padStart(7)} ${'ERRORS'.padStart(7)}`;
    const rows = calls.map(
      (c) =>
        `${c.room.padEnd(28)} ${c.startTime.padEnd(24)} ${String(c.events).padStart(7)} ${String(c.errors).padStart(7)}`,
    );
    return { exitCode: 0, output: [header, ...rows].join('\n') };
  }

  const filePath = resolveCallLogFile(positional[0], logDir);
  if (!filePath) {
    const msg = positional[0]
      ? `Call log not found for "${positional[0]}" in ${logDir}`
      : `No call logs found in ${logDir}`;
    return { exitCode: 1, output: msg };
  }

  const room = path.basename(filePath, '.jsonl');
  const lines = renderCallTimeline(filePath, { errorsOnly, showAll });
  const header = `=== ${room} (${filePath}) ===`;
  return { exitCode: 0, output: [header, ...lines].join('\n') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitCode, output } = runCli(process.argv.slice(2));
  if (output) {
    if (exitCode === 0) {
      console.log(output);
    } else {
      console.error(output);
    }
  }
  process.exit(exitCode);
}
