import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogDir, sanitizeRoomName } from '../src/calllog.ts';

export interface RawLogEntry {
  t?: unknown;
  ms?: unknown;
  pid?: unknown;
  ev?: unknown;
  [key: string]: unknown;
}

export interface TimingSummary {
  count: number;
  median_ms: number | null;
  worst_ms: number | null;
}

export interface LatencySummary extends TimingSummary {
  p90_ms: number | null;
}

export interface BadEventCounts {
  tool_error: number;
  page_error: number;
  restart: number;
  store_error: number;
  tryon_fail: number;
  media_process_exit: number;
  total: number;
}

export interface CallStats {
  room: string;
  start_time: string | null;
  events: number;
  malformed_lines: number;
  duration_ms: number | null;
  conversation: {
    shopper_turns: number;
    alice_turns: number;
    alice_interrupted: number;
    alice_interrupted_share: number | null;
    false_interruptions: number;
    cutoff_recovery: TimingSummary;
    response_latency: LatencySummary;
    longest_tool_silence_ms: number | null;
    longest_tool_silence_tool: string | null;
  };
  outfits: {
    builds: number;
    first_look: TimingSummary;
    all_looks: TimingSummary;
    store_searches: {
      count: number;
      live: number;
      saved: number;
      saved_exact: number;
      saved_near: number;
      empty: number;
      other: number;
      median_ms: number | null;
    };
    errors_by_tool: Record<string, number>;
  };
  media: {
    shots: {
      count: number;
      median_ms: number | null;
      product_only: number;
      cropped: number;
      original: number;
      other: number;
    };
    boards: {
      count: number;
      ok: number;
      fail: number;
      median_ms: number | null;
    };
    tryons: {
      count: number;
      started: number;
      ready: number;
      failures: number;
      median_ms: number | null;
      worst_ms: number | null;
      checks: number;
      passed_first_time: number;
      redone: number;
    };
  };
  bag: {
    calls: number;
    added: number;
    not_added: number;
    reasons: Record<string, number>;
    carts: number;
    median_ms: number | null;
    worst_ms: number | null;
    total_ms: number;
  };
  bad: BadEventCounts;
}

interface CallSamples {
  cutoffRecovery: number[];
  responseLatency: number[];
  firstLook: number[];
  allLooks: number[];
  storeSearch: number[];
  mediaShot: number[];
  mediaBoard: number[];
  tryon: number[];
  bag: number[];
}

export interface ComputedCall {
  stats: CallStats;
  samples: CallSamples;
  mtimeMs?: number;
}

export interface AllCallsStats {
  calls: CallStats[];
  totals: CallStats;
}

export function isSkippedRoom(room: string): boolean {
  return room === '_server' || room.startsWith('probe-');
}

function finiteNumber(val: unknown): number | null {
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
}

function nonNegNumber(val: unknown): number | null {
  const n = finiteNumber(val);
  return n !== null && n >= 0 ? n : null;
}

function asString(val: unknown): string | null {
  return typeof val === 'string' && val.length > 0 ? val : null;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (p === 0.5) {
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
      return Math.round(sorted[mid]!);
    }
    return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[idx]!);
}

export function summarizeTiming(values: number[]): TimingSummary {
  if (values.length === 0) {
    return { count: 0, median_ms: null, worst_ms: null };
  }
  let worst = values[0]!;
  for (let i = 1; i < values.length; i++) {
    if (values[i]! > worst) worst = values[i]!;
  }
  return {
    count: values.length,
    median_ms: percentile(values, 0.5),
    worst_ms: Math.round(worst),
  };
}

export function summarizeLatency(values: number[]): LatencySummary {
  const base = summarizeTiming(values);
  return {
    ...base,
    p90_ms: percentile(values, 0.9),
  };
}

export function parseJsonlLines(text: string): { entries: RawLogEntry[]; malformed: number } {
  const entries: RawLogEntry[] = [];
  let malformed = 0;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries.push(parsed as RawLogEntry);
      } else {
        malformed += 1;
      }
    } catch {
      malformed += 1;
    }
  }
  return { entries, malformed };
}

function extractEventTimes(entries: RawLogEntry[]): {
  times: Array<number | null>;
  startTime: string | null;
} {
  let firstIso: string | null = null;
  let firstEpochMs: number | null = null;
  for (const e of entries) {
    if (typeof e.t === 'string') {
      const parsed = Date.parse(e.t);
      if (Number.isFinite(parsed)) {
        firstIso = e.t;
        firstEpochMs = parsed;
        break;
      }
    }
  }

  const times = entries.map((e): number | null => {
    const ms = nonNegNumber(e.ms);
    if (ms !== null) return ms;
    if (typeof e.t === 'string' && firstEpochMs !== null) {
      const parsed = Date.parse(e.t);
      if (Number.isFinite(parsed)) {
        return Math.max(0, parsed - firstEpochMs);
      }
    }
    return null;
  });

  return { times, startTime: firstIso };
}

function eventDurationMs(entry: RawLogEntry): number | null {
  return nonNegNumber(entry.duration_ms);
}

function emptySamples(): CallSamples {
  return {
    cutoffRecovery: [],
    responseLatency: [],
    firstLook: [],
    allLooks: [],
    storeSearch: [],
    mediaShot: [],
    mediaBoard: [],
    tryon: [],
    bag: [],
  };
}

function incrementMap(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

export function computeCallStatsFromText(room: string, text: string): ComputedCall {
  const { entries, malformed } = parseJsonlLines(text);
  return computeCallStats(room, entries, malformed);
}

export function computeCallStats(
  room: string,
  entries: RawLogEntry[],
  malformedLines = 0,
): ComputedCall {
  const { times, startTime } = extractEventTimes(entries);
  const samples = emptySamples();

  let minTime: number | null = null;
  let maxTime: number | null = null;
  for (const t of times) {
    if (t === null) continue;
    if (minTime === null || t < minTime) minTime = t;
    if (maxTime === null || t > maxTime) maxTime = t;
  }
  const durationMs = minTime !== null && maxTime !== null ? Math.round(maxTime - minTime) : null;

  // Detect presence of state events to choose the most accurate timing signals.
  let hasAgentStateSpeaking = false;
  let hasSpeechCreated = false;
  for (const e of entries) {
    const ev = asString(e.ev);
    if (ev === 'agent_state') {
      if (asString(e.state) === 'speaking') {
        hasAgentStateSpeaking = true;
      }
    } else if (ev === 'speech_created') {
      hasSpeechCreated = true;
    }
  }

  // Conversation counters & tracking
  let shopperTurns = 0;
  let aliceTurns = 0;
  let aliceInterrupted = 0;
  let falseInterruptions = 0;

  // Shopper turn end -> Alice first word
  let pendingTurnEndMs: number | null = null;
  let pendingTurnFromUserState = false;
  let userSpeaking = false;
  let agentSpeaking = false;

  // Tool silence tracking
  interface ActiveTool {
    key: string;
    name: string;
    startMs: number | null;
  }
  const activeTools: ActiveTool[] = [];
  let toolSeq = 0;
  let silenceStartMs: number | null = null;
  let silenceToolName: string | null = null;
  let longestToolSilenceMs: number | null = null;
  let longestToolSilenceTool: string | null = null;

  const currentSilenceToolLabel = (): string | null => {
    if (activeTools.length === 0) return null;
    const names = Array.from(new Set(activeTools.map((t) => t.name)));
    return names.join(',');
  };

  const closeSilence = (nowMs: number | null): void => {
    if (silenceStartMs !== null && nowMs !== null) {
      const span = Math.max(0, Math.round(nowMs - silenceStartMs));
      if (longestToolSilenceMs === null || span > longestToolSilenceMs) {
        longestToolSilenceMs = span;
        longestToolSilenceTool = silenceToolName ?? currentSilenceToolLabel();
      }
    }
    silenceStartMs = null;
    silenceToolName = null;
  };

  const maybeStartSilence = (nowMs: number | null): void => {
    if (silenceStartMs === null && activeTools.length > 0 && !agentSpeaking && !userSpeaking && nowMs !== null) {
      silenceStartMs = nowMs;
      silenceToolName = currentSilenceToolLabel();
    }
  };

  // Outfits & store
  interface ActiveBuild {
    startMs: number | null;
    firstLookMs: number | null;
    allLooksMs: number | null;
    done: boolean;
  }
  const builds: ActiveBuild[] = [];
  let currentBuild: ActiveBuild | null = null;

  let storeSearchCount = 0;
  let storeSearchLive = 0;
  let storeSearchSavedExact = 0;
  let storeSearchSavedNear = 0;
  let storeSearchEmpty = 0;
  let storeSearchOther = 0;

  const errorsByTool: Record<string, number> = {};

  // Media
  let shotCount = 0;
  let shotProductOnly = 0;
  let shotCropped = 0;
  let shotOriginal = 0;
  let shotOther = 0;

  let boardCount = 0;
  let boardOk = 0;
  let boardFail = 0;

  let tryonStarted = 0;
  let tryonReady = 0;
  let tryonFailures = 0;
  const pendingTryonStarts = new Map<string, number[]>();

  let tryonChecks = 0;
  let tryonPassedFirst = 0;
  let tryonRedone = 0;
  const outfitRedoneInFlight = new Set<string>();

  // Bag
  let bagCalls = 0;
  let bagAdded = 0;
  let bagNotAdded = 0;
  let bagCarts = 0;
  let bagTotalMs = 0;
  const bagReasons: Record<string, number> = {};

  // Bad events
  const bad: BadEventCounts = {
    tool_error: 0,
    page_error: 0,
    restart: 0,
    store_error: 0,
    tryon_fail: 0,
    media_process_exit: 0,
    total: 0,
  };

  // Pass 1: cut-off recovery (lookahead from each interrupted alice_said)
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (asString(e.ev) === 'alice_said' && e.interrupted === true) {
      const cutoffMs = times[i]!;
      if (cutoffMs === null) continue;
      let speechCreatedMs: number | null = null;
      let recoveredMs: number | null = null;

      for (let j = i + 1; j < entries.length; j++) {
        const next = entries[j]!;
        const nextEv = asString(next.ev);
        const nextMs = times[j]!;
        if (nextMs === null || nextMs < cutoffMs) continue;

        if (nextEv === 'agent_state' && asString(next.state) === 'speaking') {
          recoveredMs = nextMs - cutoffMs;
          break;
        }
        if (nextEv === 'speech_created' && speechCreatedMs === null) {
          speechCreatedMs = nextMs;
        }
        if (nextEv === 'alice_said') {
          recoveredMs = (speechCreatedMs ?? nextMs) - cutoffMs;
          break;
        }
      }

      if (recoveredMs === null && speechCreatedMs !== null) {
        recoveredMs = speechCreatedMs - cutoffMs;
      }
      if (recoveredMs !== null && recoveredMs >= 0) {
        samples.cutoffRecovery.push(Math.round(recoveredMs));
      }
    }
  }

  // Pass 2: main timeline scan
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const ev = asString(e.ev);
    const t = times[i]!;
    if (!ev) continue;

    switch (ev) {
      case 'user_state': {
        const st = asString(e.state);
        const old = asString(e.old);
        const wasSpeaking = userSpeaking || old === 'speaking';
        const nowSpeaking = st === 'speaking';

        if (nowSpeaking) {
          closeSilence(t);
        }
        if (wasSpeaking && st !== null && !nowSpeaking) {
          if (t !== null) {
            pendingTurnEndMs = t;
            pendingTurnFromUserState = true;
          }
        }
        userSpeaking = nowSpeaking;
        if (!userSpeaking) {
          maybeStartSilence(t);
        }
        break;
      }

      case 'agent_state': {
        const st = asString(e.state);
        const old = asString(e.old);
        const wasSpeaking = agentSpeaking || old === 'speaking';
        const nowSpeaking = st === 'speaking';

        if (nowSpeaking) {
          closeSilence(t);
          if (hasAgentStateSpeaking && !wasSpeaking && pendingTurnEndMs !== null && t !== null && t >= pendingTurnEndMs) {
            samples.responseLatency.push(Math.round(t - pendingTurnEndMs));
            pendingTurnEndMs = null;
            pendingTurnFromUserState = false;
          }
        }
        agentSpeaking = nowSpeaking;
        if (!agentSpeaking) {
          maybeStartSilence(t);
        }
        break;
      }

      case 'user_said': {
        shopperTurns += 1;
        if (t !== null && !agentSpeaking) {
          // In Gemini Live realtime_llm mode, normal shopper turns emit user_said without
          // user_state speaking->listening transitions, while interruptions emit both ~1ms apart.
          const recentUserStateEnd =
            pendingTurnFromUserState &&
            pendingTurnEndMs !== null &&
            t - pendingTurnEndMs >= 0 &&
            t - pendingTurnEndMs <= 500;
          if (!recentUserStateEnd) {
            pendingTurnEndMs = t;
            pendingTurnFromUserState = false;
          }
        }
        if (activeTools.length > 0 && !userSpeaking && !agentSpeaking && t !== null) {
          closeSilence(t);
          maybeStartSilence(t);
        }
        break;
      }

      case 'speech_created': {
        if (!hasAgentStateSpeaking && hasSpeechCreated && pendingTurnEndMs !== null && t !== null && t >= pendingTurnEndMs) {
          samples.responseLatency.push(Math.round(t - pendingTurnEndMs));
          pendingTurnEndMs = null;
          pendingTurnFromUserState = false;
        }
        break;
      }

      case 'alice_said': {
        aliceTurns += 1;
        if (e.interrupted === true) {
          aliceInterrupted += 1;
        }
        if (!hasAgentStateSpeaking && !hasSpeechCreated && pendingTurnEndMs !== null && t !== null && t >= pendingTurnEndMs) {
          samples.responseLatency.push(Math.round(t - pendingTurnEndMs));
          pendingTurnEndMs = null;
          pendingTurnFromUserState = false;
        }
        if (activeTools.length > 0 && !userSpeaking && !agentSpeaking && t !== null) {
          closeSilence(t);
          maybeStartSilence(t);
        }
        break;
      }

      case 'false_interruption': {
        falseInterruptions += 1;
        break;
      }

      case 'tool_call': {
        const name = asString(e.name) ?? asString(e.tool) ?? 'unknown';
        const callId = e.call_id !== undefined && e.call_id !== null ? String(e.call_id) : `${name}#${++toolSeq}`;
        activeTools.push({ key: callId, name, startMs: t });
        maybeStartSilence(t);
        break;
      }

      case 'tool_result':
      case 'tool_error': {
        const name = asString(e.name) ?? asString(e.tool) ?? 'unknown';
        if (ev === 'tool_error') {
          bad.tool_error += 1;
          incrementMap(errorsByTool, name);
        }
        const callId = e.call_id !== undefined && e.call_id !== null ? String(e.call_id) : null;
        let idx = -1;
        if (callId !== null) {
          idx = activeTools.findIndex((a) => a.key === callId);
        }
        if (idx === -1) {
          idx = activeTools.findIndex((a) => a.name === name);
        }
        if (idx !== -1) {
          activeTools.splice(idx, 1);
          if (activeTools.length === 0) {
            closeSilence(t);
          }
        }
        break;
      }

      case 'build_start': {
        currentBuild = { startMs: t, firstLookMs: null, allLooksMs: null, done: false };
        builds.push(currentBuild);
        break;
      }

      case 'build_outfit': {
        if (currentBuild && currentBuild.firstLookMs === null) {
          const delta =
            t !== null && currentBuild.startMs !== null && t >= currentBuild.startMs
              ? Math.round(t - currentBuild.startMs)
              : nonNegNumber(e.build_ms);
          if (delta !== null) {
            currentBuild.firstLookMs = Math.round(delta);
          }
        }
        break;
      }

      case 'build_done': {
        const timingObj =
          e.timing && typeof e.timing === 'object' && !Array.isArray(e.timing)
            ? (e.timing as Record<string, unknown>)
            : null;
        if (currentBuild && !currentBuild.done) {
          currentBuild.done = true;
          const totalDelta =
            t !== null && currentBuild.startMs !== null && t >= currentBuild.startMs
              ? Math.round(t - currentBuild.startMs)
              : (nonNegNumber(timingObj?.total_ms) ?? nonNegNumber(e.build_ms));
          if (totalDelta !== null) {
            currentBuild.allLooksMs = Math.round(totalDelta);
          }
          if (currentBuild.firstLookMs === null) {
            const firstFromTiming = nonNegNumber(timingObj?.first_outfit_ms);
            if (firstFromTiming !== null && firstFromTiming > 0) {
              currentBuild.firstLookMs = Math.round(firstFromTiming);
            }
          }
          currentBuild = null;
        }
        break;
      }

      case 'store_search': {
        storeSearchCount += 1;
        const source = asString(e.source);
        if (source === 'live') storeSearchLive += 1;
        else if (source === 'saved') storeSearchSavedExact += 1;
        else if (source === 'saved-near') storeSearchSavedNear += 1;
        else if (source === 'empty') storeSearchEmpty += 1;
        else storeSearchOther += 1;

        const dur = eventDurationMs(e);
        if (dur !== null) samples.storeSearch.push(Math.round(dur));
        break;
      }

      case 'media_shot': {
        shotCount += 1;
        const source = asString(e.source);
        if (source === 'product-only' || source === 'product_only') shotProductOnly += 1;
        else if (source === 'cropped') shotCropped += 1;
        else if (source === 'original') shotOriginal += 1;
        else shotOther += 1;

        const dur = eventDurationMs(e);
        if (dur !== null) samples.mediaShot.push(Math.round(dur));
        break;
      }

      case 'media_board': {
        boardCount += 1;
        if (e.ok === false) boardFail += 1;
        else if (e.ok === true) boardOk += 1;
        const dur = eventDurationMs(e);
        if (dur !== null) samples.mediaBoard.push(Math.round(dur));
        break;
      }

      case 'tryon_start': {
        tryonStarted += 1;
        const key = e.outfit !== undefined && e.outfit !== null ? String(e.outfit) : '__default__';
        if (t !== null) {
          const arr = pendingTryonStarts.get(key) ?? [];
          arr.push(t);
          pendingTryonStarts.set(key, arr);
        }
        outfitRedoneInFlight.delete(key);
        break;
      }

      case 'tryon_ready': {
        tryonReady += 1;
        const key = e.outfit !== undefined && e.outfit !== null ? String(e.outfit) : '__default__';
        const starts = pendingTryonStarts.get(key);
        const startedAt = starts && starts.length > 0 ? starts.shift()! : null;
        const dur =
          eventDurationMs(e) ??
          (t !== null && startedAt !== null && t >= startedAt ? Math.round(t - startedAt) : null);
        if (dur !== null) samples.tryon.push(Math.round(dur));
        break;
      }

      case 'tryon_fail': {
        tryonFailures += 1;
        bad.tryon_fail += 1;
        const key = e.outfit !== undefined && e.outfit !== null ? String(e.outfit) : '__default__';
        const starts = pendingTryonStarts.get(key);
        if (starts && starts.length > 0) starts.shift();
        break;
      }

      case 'tryon_check': {
        tryonChecks += 1;
        const key = e.outfit !== undefined && e.outfit !== null ? String(e.outfit) : '__default__';
        const verdict = asString(e.verdict)?.toLowerCase() ?? asString(e.result)?.toLowerCase() ?? null;
        const passed =
          e.pass === true || e.ok === true || e.passed === true || verdict === 'pass' || verdict === 'ok';
        const failed =
          e.pass === false ||
          e.ok === false ||
          e.passed === false ||
          verdict === 'fail' ||
          verdict === 'redo' ||
          verdict === 'retry';
        const attempt = finiteNumber(e.attempt);
        const attempts = finiteNumber(e.attempts);
        const retries = finiteNumber(e.retries);
        const explicitRedone =
          e.redone === true ||
          e.retried === true ||
          e.redo === true ||
          e.retry === true ||
          (attempt !== null && attempt > 1) ||
          (attempts !== null && attempts > 1) ||
          (retries !== null && retries > 0);

        if (explicitRedone) {
          if (!outfitRedoneInFlight.has(key)) {
            tryonRedone += 1;
            outfitRedoneInFlight.add(key);
          }
          if (passed) {
            outfitRedoneInFlight.delete(key);
          }
        } else if (failed) {
          if (!outfitRedoneInFlight.has(key)) {
            tryonRedone += 1;
            outfitRedoneInFlight.add(key);
          }
        } else if (passed) {
          if (outfitRedoneInFlight.has(key)) {
            outfitRedoneInFlight.delete(key);
          } else {
            tryonPassedFirst += 1;
          }
        }
        break;
      }

      case 'store_bag': {
        bagCalls += 1;
        const added = nonNegNumber(e.added);
        const notAdded = nonNegNumber(e.not_added);
        const carts = nonNegNumber(e.carts);
        const dur = eventDurationMs(e);
        if (added !== null) bagAdded += added;
        if (notAdded !== null) bagNotAdded += notAdded;
        if (carts !== null) bagCarts += carts;
        if (dur !== null) {
          const rounded = Math.round(dur);
          samples.bag.push(rounded);
          bagTotalMs += rounded;
        }
        if (Array.isArray(e.reasons)) {
          for (const r of e.reasons) {
            const reason = asString(r);
            if (reason) incrementMap(bagReasons, reason);
          }
        } else {
          const singleReason = asString(e.reasons) ?? asString(e.reason);
          if (singleReason) incrementMap(bagReasons, singleReason);
        }
        break;
      }

      case 'page_error':
        bad.page_error += 1;
        break;

      case 'restart':
        bad.restart += 1;
        break;

      case 'store_error':
        bad.store_error += 1;
        break;

      case 'media_process_exit':
        bad.media_process_exit += 1;
        break;

      default:
        break;
    }
  }

  // Close any silence still open at end of log
  if (activeTools.length > 0 && silenceStartMs !== null && maxTime !== null) {
    closeSilence(maxTime);
  }

  for (const b of builds) {
    if (b.firstLookMs !== null) samples.firstLook.push(b.firstLookMs);
    if (b.allLooksMs !== null) samples.allLooks.push(b.allLooksMs);
  }

  bad.total =
    bad.tool_error +
    bad.page_error +
    bad.restart +
    bad.store_error +
    bad.tryon_fail +
    bad.media_process_exit;

  const tryonCount = Math.max(tryonStarted, tryonReady + tryonFailures);
  const tryonTiming = summarizeTiming(samples.tryon);
  const bagTiming = summarizeTiming(samples.bag);

  const stats: CallStats = {
    room,
    start_time: startTime,
    events: entries.length,
    malformed_lines: malformedLines,
    duration_ms: durationMs,
    conversation: {
      shopper_turns: shopperTurns,
      alice_turns: aliceTurns,
      alice_interrupted: aliceInterrupted,
      alice_interrupted_share: aliceTurns > 0 ? aliceInterrupted / aliceTurns : null,
      false_interruptions: falseInterruptions,
      cutoff_recovery: summarizeTiming(samples.cutoffRecovery),
      response_latency: summarizeLatency(samples.responseLatency),
      longest_tool_silence_ms: longestToolSilenceMs,
      longest_tool_silence_tool: longestToolSilenceTool,
    },
    outfits: {
      builds: builds.length,
      first_look: summarizeTiming(samples.firstLook),
      all_looks: summarizeTiming(samples.allLooks),
      store_searches: {
        count: storeSearchCount,
        live: storeSearchLive,
        saved: storeSearchSavedExact + storeSearchSavedNear,
        saved_exact: storeSearchSavedExact,
        saved_near: storeSearchSavedNear,
        empty: storeSearchEmpty,
        other: storeSearchOther,
        median_ms: percentile(samples.storeSearch, 0.5),
      },
      errors_by_tool: errorsByTool,
    },
    media: {
      shots: {
        count: shotCount,
        median_ms: percentile(samples.mediaShot, 0.5),
        product_only: shotProductOnly,
        cropped: shotCropped,
        original: shotOriginal,
        other: shotOther,
      },
      boards: {
        count: boardCount,
        ok: boardOk,
        fail: boardFail,
        median_ms: percentile(samples.mediaBoard, 0.5),
      },
      tryons: {
        count: tryonCount,
        started: tryonStarted,
        ready: tryonReady,
        failures: tryonFailures,
        median_ms: tryonTiming.median_ms,
        worst_ms: tryonTiming.worst_ms,
        checks: tryonChecks,
        passed_first_time: tryonPassedFirst,
        redone: tryonRedone,
      },
    },
    bag: {
      calls: bagCalls,
      added: bagAdded,
      not_added: bagNotAdded,
      reasons: bagReasons,
      carts: bagCarts,
      median_ms: bagTiming.median_ms,
      worst_ms: bagTiming.worst_ms,
      total_ms: bagTotalMs,
    },
    bad,
  };

  return { stats, samples };
}

export function aggregateCallStats(computed: ComputedCall[]): CallStats {
  const pooled = emptySamples();
  let events = 0;
  let malformed = 0;
  let durationSum = 0;
  let hasDuration = false;

  let shopperTurns = 0;
  let aliceTurns = 0;
  let aliceInterrupted = 0;
  let falseInterruptions = 0;
  let longestSilenceMs: number | null = null;
  let longestSilenceTool: string | null = null;

  let builds = 0;
  let searchCount = 0;
  let searchLive = 0;
  let searchSavedExact = 0;
  let searchSavedNear = 0;
  let searchEmpty = 0;
  let searchOther = 0;
  const errorsByTool: Record<string, number> = {};

  let shotCount = 0;
  let shotProductOnly = 0;
  let shotCropped = 0;
  let shotOriginal = 0;
  let shotOther = 0;

  let boardCount = 0;
  let boardOk = 0;
  let boardFail = 0;

  let tryonCount = 0;
  let tryonStarted = 0;
  let tryonReady = 0;
  let tryonFailures = 0;
  let tryonChecks = 0;
  let tryonPassedFirst = 0;
  let tryonRedone = 0;

  let bagCalls = 0;
  let bagAdded = 0;
  let bagNotAdded = 0;
  let bagCarts = 0;
  let bagTotalMs = 0;
  const bagReasons: Record<string, number> = {};

  const bad: BadEventCounts = {
    tool_error: 0,
    page_error: 0,
    restart: 0,
    store_error: 0,
    tryon_fail: 0,
    media_process_exit: 0,
    total: 0,
  };

  for (const item of computed) {
    const s = item.stats;
    events += s.events;
    malformed += s.malformed_lines;
    if (s.duration_ms !== null) {
      durationSum += s.duration_ms;
      hasDuration = true;
    }

    shopperTurns += s.conversation.shopper_turns;
    aliceTurns += s.conversation.alice_turns;
    aliceInterrupted += s.conversation.alice_interrupted;
    falseInterruptions += s.conversation.false_interruptions;

    if (
      s.conversation.longest_tool_silence_ms !== null &&
      (longestSilenceMs === null || s.conversation.longest_tool_silence_ms > longestSilenceMs)
    ) {
      longestSilenceMs = s.conversation.longest_tool_silence_ms;
      longestSilenceTool = s.conversation.longest_tool_silence_tool;
    }

    builds += s.outfits.builds;
    searchCount += s.outfits.store_searches.count;
    searchLive += s.outfits.store_searches.live;
    searchSavedExact += s.outfits.store_searches.saved_exact;
    searchSavedNear += s.outfits.store_searches.saved_near;
    searchEmpty += s.outfits.store_searches.empty;
    searchOther += s.outfits.store_searches.other;
    for (const [tool, count] of Object.entries(s.outfits.errors_by_tool)) {
      incrementMap(errorsByTool, tool, count);
    }

    shotCount += s.media.shots.count;
    shotProductOnly += s.media.shots.product_only;
    shotCropped += s.media.shots.cropped;
    shotOriginal += s.media.shots.original;
    shotOther += s.media.shots.other;

    boardCount += s.media.boards.count;
    boardOk += s.media.boards.ok;
    boardFail += s.media.boards.fail;

    tryonCount += s.media.tryons.count;
    tryonStarted += s.media.tryons.started;
    tryonReady += s.media.tryons.ready;
    tryonFailures += s.media.tryons.failures;
    tryonChecks += s.media.tryons.checks;
    tryonPassedFirst += s.media.tryons.passed_first_time;
    tryonRedone += s.media.tryons.redone;

    bagCalls += s.bag.calls;
    bagAdded += s.bag.added;
    bagNotAdded += s.bag.not_added;
    bagCarts += s.bag.carts;
    bagTotalMs += s.bag.total_ms;
    for (const [reason, count] of Object.entries(s.bag.reasons)) {
      incrementMap(bagReasons, reason, count);
    }

    bad.tool_error += s.bad.tool_error;
    bad.page_error += s.bad.page_error;
    bad.restart += s.bad.restart;
    bad.store_error += s.bad.store_error;
    bad.tryon_fail += s.bad.tryon_fail;
    bad.media_process_exit += s.bad.media_process_exit;
    bad.total += s.bad.total;

    pooled.cutoffRecovery.push(...item.samples.cutoffRecovery);
    pooled.responseLatency.push(...item.samples.responseLatency);
    pooled.firstLook.push(...item.samples.firstLook);
    pooled.allLooks.push(...item.samples.allLooks);
    pooled.storeSearch.push(...item.samples.storeSearch);
    pooled.mediaShot.push(...item.samples.mediaShot);
    pooled.mediaBoard.push(...item.samples.mediaBoard);
    pooled.tryon.push(...item.samples.tryon);
    pooled.bag.push(...item.samples.bag);
  }

  const tryonTiming = summarizeTiming(pooled.tryon);
  const bagTiming = summarizeTiming(pooled.bag);

  return {
    room: `TOTAL (${computed.length} ${computed.length === 1 ? 'call' : 'calls'})`,
    start_time: null,
    events,
    malformed_lines: malformed,
    duration_ms: hasDuration ? durationSum : null,
    conversation: {
      shopper_turns: shopperTurns,
      alice_turns: aliceTurns,
      alice_interrupted: aliceInterrupted,
      alice_interrupted_share: aliceTurns > 0 ? aliceInterrupted / aliceTurns : null,
      false_interruptions: falseInterruptions,
      cutoff_recovery: summarizeTiming(pooled.cutoffRecovery),
      response_latency: summarizeLatency(pooled.responseLatency),
      longest_tool_silence_ms: longestSilenceMs,
      longest_tool_silence_tool: longestSilenceTool,
    },
    outfits: {
      builds,
      first_look: summarizeTiming(pooled.firstLook),
      all_looks: summarizeTiming(pooled.allLooks),
      store_searches: {
        count: searchCount,
        live: searchLive,
        saved: searchSavedExact + searchSavedNear,
        saved_exact: searchSavedExact,
        saved_near: searchSavedNear,
        empty: searchEmpty,
        other: searchOther,
        median_ms: percentile(pooled.storeSearch, 0.5),
      },
      errors_by_tool: errorsByTool,
    },
    media: {
      shots: {
        count: shotCount,
        median_ms: percentile(pooled.mediaShot, 0.5),
        product_only: shotProductOnly,
        cropped: shotCropped,
        original: shotOriginal,
        other: shotOther,
      },
      boards: {
        count: boardCount,
        ok: boardOk,
        fail: boardFail,
        median_ms: percentile(pooled.mediaBoard, 0.5),
      },
      tryons: {
        count: tryonCount,
        started: tryonStarted,
        ready: tryonReady,
        failures: tryonFailures,
        median_ms: tryonTiming.median_ms,
        worst_ms: tryonTiming.worst_ms,
        checks: tryonChecks,
        passed_first_time: tryonPassedFirst,
        redone: tryonRedone,
      },
    },
    bag: {
      calls: bagCalls,
      added: bagAdded,
      not_added: bagNotAdded,
      reasons: bagReasons,
      carts: bagCarts,
      median_ms: bagTiming.median_ms,
      worst_ms: bagTiming.worst_ms,
      total_ms: bagTotalMs,
    },
    bad,
  };
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m${String(secs).padStart(2, '0')}s`;
}

function formatPct(share: number | null, decimals = 1): string {
  if (share === null || !Number.isFinite(share)) return '-';
  return `${(share * 100).toFixed(decimals)}%`;
}

function formatCountMap(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return 'none';
  return entries.map(([k, v]) => `${k} (${v})`).join(', ');
}

export function formatSingleCallReport(s: CallStats): string {
  const lines: string[] = [];
  const metaParts: string[] = [];
  if (s.start_time) metaParts.push(s.start_time);
  metaParts.push(`len ${formatDuration(s.duration_ms)}`);
  metaParts.push(`${s.events} events`);
  if (s.malformed_lines > 0) metaParts.push(`${s.malformed_lines} malformed`);

  lines.push(`Call: ${s.room}  (${metaParts.join(', ')})`);

  const row = (label: string, value: string): void => {
    lines.push(`  ${label.padEnd(26)} ${value}`);
  };

  lines.push('');
  lines.push('Conversation');
  row('Shopper turns', String(s.conversation.shopper_turns));
  row(
    'Alice turns',
    `${s.conversation.alice_turns}  (cut off: ${s.conversation.alice_interrupted} / ${formatPct(s.conversation.alice_interrupted_share)}, false interrupts: ${s.conversation.false_interruptions})`,
  );
  row(
    'Cut-off -> spoke again',
    s.conversation.cutoff_recovery.count > 0
      ? `med ${formatDuration(s.conversation.cutoff_recovery.median_ms)}   worst ${formatDuration(s.conversation.cutoff_recovery.worst_ms)}  (n=${s.conversation.cutoff_recovery.count})`
      : '-',
  );
  row(
    'Shopper -> Alice 1st word',
    s.conversation.response_latency.count > 0
      ? `med ${formatDuration(s.conversation.response_latency.median_ms)}   p90 ${formatDuration(s.conversation.response_latency.p90_ms)}   worst ${formatDuration(s.conversation.response_latency.worst_ms)}  (n=${s.conversation.response_latency.count})`
      : '-',
  );
  row(
    'Longest tool silence',
    s.conversation.longest_tool_silence_ms !== null
      ? `${formatDuration(s.conversation.longest_tool_silence_ms)}${s.conversation.longest_tool_silence_tool ? `  (${s.conversation.longest_tool_silence_tool})` : ''}`
      : '-',
  );

  lines.push('');
  lines.push('Outfits & Store');
  const firstLookStr =
    s.outfits.first_look.count > 1
      ? `med ${formatDuration(s.outfits.first_look.median_ms)} / worst ${formatDuration(s.outfits.first_look.worst_ms)}`
      : formatDuration(s.outfits.first_look.median_ms);
  const allLooksStr =
    s.outfits.all_looks.count > 1
      ? `med ${formatDuration(s.outfits.all_looks.median_ms)} / worst ${formatDuration(s.outfits.all_looks.worst_ms)}`
      : formatDuration(s.outfits.all_looks.median_ms);
  row('Builds', `${s.outfits.builds}  (first look: ${firstLookStr}, all looks: ${allLooksStr})`);

  const ss = s.outfits.store_searches;
  const savedDetail = ss.saved_near > 0 ? `${ss.saved} (${ss.saved_near} near)` : String(ss.saved);
  row(
    'Store searches',
    ss.count > 0
      ? `${ss.count}  (live ${ss.live}, saved ${savedDetail}, empty ${ss.empty}; med ${formatDuration(ss.median_ms)})`
      : '0',
  );
  row('Errors by tool', formatCountMap(s.outfits.errors_by_tool));

  lines.push('');
  lines.push('Media');
  const sh = s.media.shots;
  row(
    'Product shots',
    sh.count > 0
      ? `${sh.count}  (product-only ${sh.product_only}, cropped ${sh.cropped}, original ${sh.original}; med ${formatDuration(sh.median_ms)})`
      : '0',
  );
  const bd = s.media.boards;
  row(
    'Outfit boards',
    bd.count > 0
      ? `${bd.count}  (ok ${bd.ok}, fail ${bd.fail}; med ${formatDuration(bd.median_ms)})`
      : '0',
  );
  const tr = s.media.tryons;
  row(
    'Try-ons',
    tr.count > 0
      ? `${tr.count}  (ready ${tr.ready}, fail ${tr.failures}; med ${formatDuration(tr.median_ms)}, worst ${formatDuration(tr.worst_ms)})`
      : '0',
  );
  row(
    'Try-on checks',
    tr.checks > 0
      ? `${tr.checks}  (passed 1st time: ${tr.passed_first_time}, redone: ${tr.redone})`
      : '0',
  );

  lines.push('');
  lines.push('Bag');
  const bg = s.bag;
  row(
    'Bag calls',
    bg.calls > 0
      ? `${bg.calls}  (added ${bg.added}, not added ${bg.not_added}, carts ${bg.carts}; med ${formatDuration(bg.median_ms)}, total ${formatDuration(bg.total_ms)})`
      : '0',
  );
  row('Not-added reasons', formatCountMap(bg.reasons));

  lines.push('');
  lines.push('Bad Events');
  row(
    'Counts',
    `tool_error=${s.bad.tool_error}  page_error=${s.bad.page_error}  restart=${s.bad.restart}  store_error=${s.bad.store_error}  tryon_fail=${s.bad.tryon_fail}  media_process_exit=${s.bad.media_process_exit}  (total: ${s.bad.total})`,
  );

  return lines.join('\n');
}

function alignTable(headers: string[], rows: string[][], rightAlign: boolean[]): string[] {
  const widths = headers.map((h, col) => {
    let w = h.length;
    for (const r of rows) {
      const cell = r[col] ?? '';
      if (cell.length > w) w = cell.length;
    }
    return w;
  });

  const formatRow = (cells: string[]): string =>
    cells
      .map((cell, col) => (rightAlign[col] ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!)))
      .join('  ');

  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [formatRow(headers), sep, ...rows.map(formatRow)];
}

export function formatAllCallsReport(all: AllCallsStats): string {
  const headers = [
    'ROOM',
    'LEN',
    'U/A',
    'CUTOFF',
    'FI',
    'RECOV(m/w)',
    'RESP(m/p90/w)',
    'SILENCE',
    'LOOK(1/all)',
    'SRCH(L/S)',
    'SHOT(med)',
    'BRD',
    'TRY(ok/f)',
    'BAG(+/-)',
    'BAD',
  ];
  const rightAlign = [
    false,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ];

  const toRow = (s: CallStats): string[] => {
    const cut =
      s.conversation.alice_turns > 0
        ? `${s.conversation.alice_interrupted}(${formatPct(s.conversation.alice_interrupted_share, 0)})`
        : '-';
    const rec =
      s.conversation.cutoff_recovery.count > 0
        ? `${formatDuration(s.conversation.cutoff_recovery.median_ms)}/${formatDuration(s.conversation.cutoff_recovery.worst_ms)}`
        : '-';
    const resp =
      s.conversation.response_latency.count > 0
        ? `${formatDuration(s.conversation.response_latency.median_ms)}/${formatDuration(s.conversation.response_latency.p90_ms)}/${formatDuration(s.conversation.response_latency.worst_ms)}`
        : '-';
    const look =
      s.outfits.builds > 0
        ? `${formatDuration(s.outfits.first_look.median_ms)}/${formatDuration(s.outfits.all_looks.median_ms)}`
        : '-';
    const srch =
      s.outfits.store_searches.count > 0
        ? `${s.outfits.store_searches.count}(${s.outfits.store_searches.live}/${s.outfits.store_searches.saved})`
        : '0';
    const shot =
      s.media.shots.count > 0
        ? `${s.media.shots.count}(${formatDuration(s.media.shots.median_ms)})`
        : '0';
    const brd = s.media.boards.count > 0 ? formatDuration(s.media.boards.median_ms) : '-';
    const tr =
      s.media.tryons.count > 0 ? `${s.media.tryons.ready}/${s.media.tryons.failures}` : '0';
    const bag = s.bag.calls > 0 ? `${s.bag.added}/${s.bag.not_added}` : '-';

    return [
      s.room,
      formatDuration(s.duration_ms),
      `${s.conversation.shopper_turns}/${s.conversation.alice_turns}`,
      cut,
      String(s.conversation.false_interruptions),
      rec,
      resp,
      formatDuration(s.conversation.longest_tool_silence_ms),
      look,
      srch,
      shot,
      brd,
      tr,
      bag,
      String(s.bad.total),
    ];
  };

  const bodyRows = all.calls.map(toRow);
  const totalRow = toRow(all.totals);
  const tableLines = alignTable(headers, [...bodyRows, totalRow], rightAlign);
  // Insert a separator line before the TOTAL row
  const sepLine = tableLines[1]!;
  const withTotalSep = [
    ...tableLines.slice(0, tableLines.length - 1),
    sepLine,
    tableLines[tableLines.length - 1]!,
  ];

  return [...withTotalSep, '', formatSingleCallReport(all.totals)].join('\n');
}

interface LogFileInfo {
  room: string;
  filePath: string;
  mtimeMs: number;
}

function listEligibleLogs(logDir: string): { files: LogFileInfo[]; error?: string } {
  if (!existsSync(logDir)) {
    return { files: [] };
  }
  let names: string[];
  try {
    names = readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { files: [], error: `Cannot read log directory ${logDir}: ${message}` };
  }

  const files: LogFileInfo[] = [];
  for (const name of names) {
    const room = name.replace(/\.jsonl$/, '');
    if (isSkippedRoom(room)) continue;
    const filePath = path.join(logDir, name);
    try {
      const st = statSync(filePath);
      files.push({ room, filePath, mtimeMs: st.mtimeMs });
    } catch {
      // Skip unreadable file entries
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.room.localeCompare(b.room));
  return { files };
}

function resolveRoomFile(roomArg: string, logDir: string): string | null {
  const direct = path.join(logDir, roomArg.endsWith('.jsonl') ? roomArg : `${roomArg}.jsonl`);
  if (existsSync(direct)) return direct;
  const sanitized = path.join(logDir, `${sanitizeRoomName(roomArg)}.jsonl`);
  if (existsSync(sanitized)) return sanitized;
  if (roomArg.endsWith('.jsonl') && existsSync(roomArg)) return roomArg;
  return null;
}

export function runCli(
  argv: string[],
  logDir: string = getLogDir(),
): { exitCode: number; output: string } {
  let allFlag = false;
  let jsonFlag = false;
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === '--all') {
      allFlag = true;
    } else if (arg === '--json') {
      jsonFlag = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (allFlag) {
    const { files, error } = listEligibleLogs(logDir);
    if (error) {
      return { exitCode: 1, output: error };
    }
    if (files.length === 0) {
      if (jsonFlag) {
        const empty: AllCallsStats = { calls: [], totals: aggregateCallStats([]) };
        return { exitCode: 0, output: JSON.stringify(empty, null, 2) };
      }
      return { exitCode: 0, output: `No call logs found in ${logDir}` };
    }

    const computed: ComputedCall[] = [];
    for (const f of files) {
      try {
        const text = readFileSync(f.filePath, 'utf8');
        const c = computeCallStatsFromText(f.room, text);
        c.mtimeMs = f.mtimeMs;
        computed.push(c);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { exitCode: 1, output: `Cannot read ${f.filePath}: ${message}` };
      }
    }

    // Sort chronologically (oldest -> newest) so progression across calls is clear.
    computed.sort((a, b) => {
      const ta = a.stats.start_time ? Date.parse(a.stats.start_time) : (a.mtimeMs ?? 0);
      const tb = b.stats.start_time ? Date.parse(b.stats.start_time) : (b.mtimeMs ?? 0);
      return ta - tb || a.stats.room.localeCompare(b.stats.room);
    });

    const result: AllCallsStats = {
      calls: computed.map((c) => c.stats),
      totals: aggregateCallStats(computed),
    };

    if (jsonFlag) {
      return { exitCode: 0, output: JSON.stringify(result, null, 2) };
    }
    return { exitCode: 0, output: formatAllCallsReport(result) };
  }

  let filePath: string | null = null;
  let roomName: string;

  if (positional[0]) {
    if (!existsSync(logDir) && !existsSync(positional[0])) {
      return { exitCode: 1, output: `Call log not found for "${positional[0]}" in ${logDir}` };
    }
    filePath = resolveRoomFile(positional[0], logDir);
    if (!filePath) {
      return { exitCode: 1, output: `Call log not found for "${positional[0]}" in ${logDir}` };
    }
    roomName = path.basename(filePath, '.jsonl');
  } else {
    const { files, error } = listEligibleLogs(logDir);
    if (error) {
      return { exitCode: 1, output: error };
    }
    if (files.length === 0) {
      return { exitCode: 1, output: `No call logs found in ${logDir}` };
    }
    filePath = files[0]!.filePath;
    roomName = files[0]!.room;
  }

  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, output: `Cannot read ${filePath}: ${message}` };
  }

  const { stats } = computeCallStatsFromText(roomName, text);
  if (jsonFlag) {
    return { exitCode: 0, output: JSON.stringify(stats, null, 2) };
  }
  return { exitCode: 0, output: formatSingleCallReport(stats) };
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
