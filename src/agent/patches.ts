import * as google from '@livekit/agents-plugin-google';
import { calllog } from '../calllog.ts';

const { FunctionResponseScheduling } = google.realtime;

export const INTERRUPT_TOOL_NAMES = new Set([
  'add_to_bag',
  'show_on_me',
  'swap_piece',
  'pick_outfit',
  'build_outfits',
  'show_product',
]);

export const SILENT_TOOL_NAMES = new Set([
  'set_department',
  'remember',
]);

export const DEFAULT_REPEAT_WINDOW_MS = 20_000;
export const REPEAT_PREFIX_CHARS = 60;

export const REQUIRED_PATCH_METHODS = [
  'startNewGeneration',
  'handleInputSpeechStarted',
  'getToolResultsForRealtime',
] as const;

const PATCHED_SYMBOL = Symbol.for('alice.realtimeSessionPatched');

export interface FunctionResponseLike {
  id?: string;
  name?: string;
  response?: Record<string, unknown>;
  willContinue?: boolean;
  scheduling?: string;
}

export interface ToolResultsLike {
  functionResponses?: FunctionResponseLike[];
}

export interface PatchableRealtimeSession {
  startNewGeneration?: (...args: unknown[]) => unknown;
  handleInputSpeechStarted?: (...args: unknown[]) => unknown;
  getToolResultsForRealtime?: (ctx: unknown, vertexai: boolean) => ToolResultsLike | undefined;
  sendClientEvent?: (event: unknown) => void;
  activeSession?: {
    sendToolResponse?: (params: { functionResponses: FunctionResponseLike[] }) => Promise<void> | void;
    sendClientContent?: (params: {
      turns?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
      turnComplete?: boolean;
    }) => Promise<void> | void;
  };
  [PATCHED_SYMBOL]?: boolean;
}

export type PatchLogFn = (room: string, ev: string, data?: Record<string, unknown>) => void;

export interface PatchResult {
  ok: boolean;
  missing: string[];
  patched: string[];
  alreadyPatched: boolean;
}

export function applyRealtimeSessionPatches(
  rtSession: unknown,
  options: {
    room: string;
    log?: PatchLogFn;
    errorLog?: (...args: unknown[]) => void;
  },
): PatchResult {
  const logFn = options.log ?? calllog;
  const errorLog = options.errorLog ?? console.error;

  if (!rtSession || typeof rtSession !== 'object') {
    const missing = [...REQUIRED_PATCH_METHODS];
    const message = `CRITICAL PATCH CHECK FAILED: RealtimeSession is missing or not an object (missing: ${missing.join(', ')})`;
    errorLog(message);
    logFn(options.room, 'session_error', {
      source: 'patch_check',
      error: message,
      missing,
    });
    return { ok: false, missing, patched: [], alreadyPatched: false };
  }

  const target = rtSession as PatchableRealtimeSession;
  if (target[PATCHED_SYMBOL]) {
    return { ok: true, missing: [], patched: [], alreadyPatched: true };
  }

  const missing: string[] = [];
  for (const method of REQUIRED_PATCH_METHODS) {
    if (typeof target[method] !== 'function') {
      missing.push(method);
    }
  }

  if (missing.length > 0) {
    const message = `CRITICAL PATCH CHECK FAILED: RealtimeSession is missing expected method(s): ${missing.join(', ')}`;
    errorLog(message);
    logFn(options.room, 'session_error', {
      source: 'patch_check',
      error: message,
      missing,
    });
  }

  const patched: string[] = [];

  // Patch (a): suppress synthetic handleInputSpeechStarted while startNewGeneration runs.
  if (
    typeof target.startNewGeneration === 'function' &&
    typeof target.handleInputSpeechStarted === 'function'
  ) {
    const origStartNewGeneration = target.startNewGeneration;
    target.startNewGeneration = function (this: PatchableRealtimeSession, ...args: unknown[]) {
      const savedHandleInputSpeechStarted = this.handleInputSpeechStarted;
      this.handleInputSpeechStarted = () => {};
      try {
        return origStartNewGeneration.apply(this, args);
      } finally {
        this.handleInputSpeechStarted = savedHandleInputSpeechStarted;
      }
    };
    patched.push('startNewGeneration');
  }

  // Patch (b): schedule SILENT tools as SILENT, final results of priority tools as INTERRUPT, everything else WHEN_IDLE.
  if (typeof target.getToolResultsForRealtime === 'function') {
    const origGetToolResultsForRealtime = target.getToolResultsForRealtime;
    target.getToolResultsForRealtime = function (
      this: PatchableRealtimeSession,
      ctx: unknown,
      vertexai: boolean,
    ): ToolResultsLike | undefined {
      const result = origGetToolResultsForRealtime.call(this, ctx, vertexai);
      if (vertexai || !result?.functionResponses) {
        return result;
      }

      for (const fr of result.functionResponses) {
        if (fr.willContinue === true) {
          continue;
        }
        if (typeof fr.name === 'string' && SILENT_TOOL_NAMES.has(fr.name)) {
          fr.scheduling = FunctionResponseScheduling.SILENT;
        } else if (typeof fr.name === 'string' && INTERRUPT_TOOL_NAMES.has(fr.name)) {
          fr.scheduling = FunctionResponseScheduling.INTERRUPT;
        } else if (fr.scheduling !== FunctionResponseScheduling.SILENT) {
          fr.scheduling = FunctionResponseScheduling.WHEN_IDLE;
        }
      }

      return result;
    };
    patched.push('getToolResultsForRealtime');
  }

  if (missing.length === 0) {
    target[PATCHED_SYMBOL] = true;
  }

  return {
    ok: missing.length === 0,
    missing,
    patched,
    alreadyPatched: false,
  };
}

/**
 * Send an interim `willContinue: true` function response note to Gemini Live
 * through the plugin's RealtimeSession. Uses `sendClientEvent` (serialized
 * through the plugin's messageChannel + sessionLock) with fallback to
 * `activeSession.sendToolResponse`.
 */
export function sendInterimToolNote(
  rtSession: unknown,
  params: { callId: string; name: string; note: string },
): boolean {
  if (!rtSession || typeof rtSession !== 'object') return false;
  const target = rtSession as PatchableRealtimeSession;
  const functionResponse: FunctionResponseLike = {
    id: params.callId || undefined,
    name: params.name,
    response: { output: params.note },
    willContinue: true,
    scheduling: FunctionResponseScheduling.WHEN_IDLE,
  };

  try {
    if (typeof target.sendClientEvent === 'function') {
      target.sendClientEvent({
        type: 'tool_response',
        value: {
          functionResponses: [functionResponse],
        },
      });
      return true;
    }
    if (typeof target.activeSession?.sendToolResponse === 'function') {
      void Promise.resolve(
        target.activeSession.sendToolResponse({
          functionResponses: [functionResponse],
        }),
      ).catch(() => {});
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Normalises a spoken line for near-duplicate comparison (lowercase, strip punctuation,
 * collapse whitespace).
 */
export function normalizeSpokenText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns true when two normalised spoken lines are equal or share the same
 * first 60 characters.
 */
export function isNearDuplicateLine(prevNorm: string, nextNorm: string): boolean {
  if (!prevNorm || !nextNorm) return false;
  if (prevNorm === nextNorm) return true;
  if (prevNorm.length >= REPEAT_PREFIX_CHARS && nextNorm.length >= REPEAT_PREFIX_CHARS) {
    return prevNorm.slice(0, REPEAT_PREFIX_CHARS) === nextNorm.slice(0, REPEAT_PREFIX_CHARS);
  }
  return false;
}

export interface RepeatDetectorOptions {
  room: string;
  windowMs?: number;
  log?: PatchLogFn;
  now?: () => number;
}

export interface RepeatDetector {
  onAssistantMessage(text: string): boolean;
  reset(): void;
}

/**
 * Logs `repeat_detected` (logging only) whenever a finished Alice line is
 * near-identical to her previous finished line within 20 s.
 */
export function createRepeatDetector(options: RepeatDetectorOptions): RepeatDetector {
  const logFn = options.log ?? calllog;
  const nowFn = options.now ?? (() => Date.now());
  const windowMs = Math.max(0, options.windowMs ?? DEFAULT_REPEAT_WINDOW_MS);

  let previous: { text: string; norm: string; at: number } | null = null;

  return {
    onAssistantMessage(text: string): boolean {
      const clean = typeof text === 'string' ? text.trim() : '';
      const norm = normalizeSpokenText(clean);
      if (!norm) return false;

      const now = nowFn();
      let repeated = false;

      if (previous && now - previous.at <= windowMs && isNearDuplicateLine(previous.norm, norm)) {
        repeated = true;
        logFn(options.room, 'repeat_detected', {
          text: clean,
          previous: previous.text,
          delta_ms: Math.max(0, Math.round(now - previous.at)),
        });
      }

      previous = { text: clean, norm, at: now };
      return repeated;
    },

    reset(): void {
      previous = null;
    },
  };
}
