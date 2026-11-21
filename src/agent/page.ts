import { calllog } from '../calllog.ts';
import type { PageActionName, PageActionReply, PageActions } from '../types.ts';

export const MAX_PAGE_PAYLOAD_BYTES = 15 * 1024;
export const DEFAULT_PAGE_RPC_TIMEOUT_MS = 5_000;

export type PageLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export interface RpcParticipantLike {
  performRpc(params: {
    destinationIdentity: string;
    method: string;
    payload: string;
    responseTimeout?: number;
    maxRoundTripLatency?: number;
  }): Promise<string>;
}

export interface PageRoomLike {
  name?: string;
  localParticipant?: RpcParticipantLike | null;
}

export interface PageSenderOptions {
  room: PageRoomLike;
  roomName?: string;
  shopperIdentity: () => string | null | undefined;
  log?: PageLogFn;
  responseTimeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
}

export interface PageSender {
  send<K extends PageActionName>(action: K, payload: PageActions[K]): Promise<PageActionReply>;
}

export interface TrimPayloadResult {
  json: string;
  bytes: number;
  originalBytes: number;
  trimmed: boolean;
}

function clipText(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  if (maxLen <= 0) return '';
  if (maxLen <= 3) return value.slice(0, maxLen);
  return `${value.slice(0, maxLen - 1)}…`;
}

function trimStringFields(node: unknown, keys: ReadonlySet<string>, maxLen: number): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) {
      trimStringFields(item, keys, maxLen);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (keys.has(k)) {
      if (typeof v === 'string' && v.length > maxLen) {
        obj[k] = clipText(v, maxLen);
      } else if (Array.isArray(v)) {
        if (maxLen === 0) {
          obj[k] = [];
        } else {
          obj[k] = v.map((el) => (typeof el === 'string' ? clipText(el, maxLen) : el));
        }
      }
    } else if (v && typeof v === 'object') {
      trimStringFields(v, keys, maxLen);
    }
  }
}

function clearFieldObjects(node: unknown, keys: ReadonlySet<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) {
      clearFieldObjects(item, keys);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (keys.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      obj[k] = {};
    } else if (v && typeof v === 'object') {
      clearFieldObjects(v, keys);
    }
  }
}

function trimAnyLongStrings(
  node: unknown,
  maxLen: number,
  skipKeys: ReadonlySet<string>,
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i];
      if (typeof item === 'string' && item.length > maxLen) {
        node[i] = clipText(item, maxLen);
      } else if (item && typeof item === 'object') {
        trimAnyLongStrings(item, maxLen, skipKeys);
      }
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (skipKeys.has(k)) continue;
    if (typeof v === 'string' && v.length > maxLen) {
      obj[k] = clipText(v, maxLen);
    } else if (v && typeof v === 'object') {
      trimAnyLongStrings(v, maxLen, skipKeys);
    }
  }
}

const DESCRIPTION_KEYS = new Set(['description']);
const SECONDARY_TEXT_KEYS = new Set(['story', 'why', 'difference', 'details']);
const VARIANT_MAP_KEYS = new Set(['variants_by_size']);
const PRESERVE_URL_KEYS = new Set(['url', 'image', 'id', 'variant_id', 'store_domain']);
const NO_SKIP_KEYS = new Set<string>();

/**
 * Serializes a page-action payload to JSON, trimming long text fields (starting with
 * descriptions) if the encoded payload would reach or exceed `maxBytes` (default 15 KiB).
 * Never mutates the caller's payload object.
 */
export function trimPayloadToLimit(
  payload: unknown,
  maxBytes: number = MAX_PAGE_PAYLOAD_BYTES,
): TrimPayloadResult {
  const initial = JSON.stringify(payload ?? {});
  const originalBytes = Buffer.byteLength(initial, 'utf8');
  if (originalBytes < maxBytes) {
    return { json: initial, bytes: originalBytes, originalBytes, trimmed: false };
  }

  let cloned: unknown;
  try {
    cloned = structuredClone(payload ?? {});
  } catch {
    cloned = JSON.parse(initial);
  }

  const passes: Array<() => void> = [
    () => trimStringFields(cloned, DESCRIPTION_KEYS, 240),
    () => trimStringFields(cloned, DESCRIPTION_KEYS, 120),
    () => trimStringFields(cloned, DESCRIPTION_KEYS, 40),
    () => trimStringFields(cloned, DESCRIPTION_KEYS, 0),
    () => clearFieldObjects(cloned, VARIANT_MAP_KEYS),
    () => trimStringFields(cloned, SECONDARY_TEXT_KEYS, 120),
    () => trimStringFields(cloned, SECONDARY_TEXT_KEYS, 40),
    () => trimStringFields(cloned, SECONDARY_TEXT_KEYS, 0),
    () => trimAnyLongStrings(cloned, 120, PRESERVE_URL_KEYS),
    () => trimAnyLongStrings(cloned, 40, PRESERVE_URL_KEYS),
    () => trimAnyLongStrings(cloned, 32, NO_SKIP_KEYS),
  ];

  let json = initial;
  let bytes = originalBytes;
  for (const pass of passes) {
    pass();
    json = JSON.stringify(cloned);
    bytes = Buffer.byteLength(json, 'utf8');
    if (bytes < maxBytes) {
      break;
    }
  }

  return { json, bytes, originalBytes, trimmed: true };
}

function parsePageReply(raw: string): PageActionReply {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'non-string page reply' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: 'empty page reply' };
  }
  try {
    const parsed = JSON.parse(trimmed) as { ok?: unknown; error?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') {
      return parsed.error !== undefined
        ? { ok: parsed.ok, error: String(parsed.error) }
        : { ok: parsed.ok };
    }
    return { ok: false, error: 'malformed page reply' };
  } catch {
    return { ok: false, error: 'invalid JSON page reply' };
  }
}

export function createPageSender(options: PageSenderOptions): PageSender {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const timeoutMs = options.responseTimeoutMs ?? DEFAULT_PAGE_RPC_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_PAGE_PAYLOAD_BYTES;

  const getRoomName = (): string => options.roomName || options.room?.name || 'unknown';

  return {
    async send<K extends PageActionName>(
      action: K,
      payload: PageActions[K],
    ): Promise<PageActionReply> {
      const started = nowFn();
      const roomName = getRoomName();

      let bytes = 0;
      try {
        const destinationIdentity = options.shopperIdentity()?.trim();
        if (!destinationIdentity) {
          const error = 'no shopper identity';
          logFn(roomName, 'page_error', {
            action,
            ms: Math.max(0, Math.round(nowFn() - started)),
            bytes: 0,
            error,
          });
          return { ok: false, error };
        }

        const localParticipant = options.room?.localParticipant;
        if (!localParticipant || typeof localParticipant.performRpc !== 'function') {
          const error = 'no localParticipant';
          logFn(roomName, 'page_error', {
            action,
            ms: Math.max(0, Math.round(nowFn() - started)),
            bytes: 0,
            error,
          });
          return { ok: false, error };
        }

        const prepared = trimPayloadToLimit(payload, maxBytes);
        bytes = prepared.bytes;
        if (prepared.trimmed) {
          logFn(roomName, 'page_trim', {
            action,
            original_bytes: prepared.originalBytes,
            bytes: prepared.bytes,
          });
        }

        const rawReply = await localParticipant.performRpc({
          destinationIdentity,
          method: action,
          payload: prepared.json,
          responseTimeout: timeoutMs,
        });

        const ms = Math.max(0, Math.round(nowFn() - started));
        const reply = parsePageReply(rawReply);

        if (reply.ok) {
          logFn(roomName, 'page', { action, ms, bytes, reply });
        } else {
          logFn(roomName, 'page_error', {
            action,
            ms,
            bytes,
            error: reply.error ?? 'page action returned ok:false',
            reply,
          });
        }
        return reply;
      } catch (err) {
        const ms = Math.max(0, Math.round(nowFn() - started));
        const error = err instanceof Error ? err.message : String(err);
        logFn(roomName, 'page_error', { action, ms, bytes, error });
        return { ok: false, error };
      }
    },
  };
}
