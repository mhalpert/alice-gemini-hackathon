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

  // Patch (b): schedule FINAL results of priority tools as INTERRUPT, everything else WHEN_IDLE.
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
        if (typeof fr.name === 'string' && INTERRUPT_TOOL_NAMES.has(fr.name)) {
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
