import { isBadEvent } from '../calllog.ts';
import type { CallLogEntry } from '../calllog.ts';

export const DEFAULT_EXPECTED_TOOLS = [
  'set_department',
  'build_outfits',
  'pick_outfit',
  'show_on_me',
  'swap_piece',
  'show_product',
  'add_to_bag',
] as const;

export const DEFAULT_SWAP_COLOR_PATTERN =
  /\b(brown|chestnut|cognac|espresso|mahogany|walnut|chocolate|cocoa|umber|sienna|whiskey|tobacco|dark\s+tan|saddle)\b/i;

export const DEFAULT_EXPECTED_SIZES: Record<string, RegExp> = {
  top: /^(?:size\s+)?(?:l|large)$/i,
  shoes: /^(?:(?:us|mens?|men's|size)\s+)*11(?:\.0)?(?:\s*[md])?$/i,
  bottom: /^(?:(?:size|waist)\s+)?(?:w\s*)?34(?:w|\s*[x/]\s*\d+)?$/i,
};

export interface CallExpectations {
  expectedTools?: readonly string[];
  restartGraceMs?: number;
  swapSlot?: string;
  swapColorPattern?: RegExp;
  expectedSizes?: Record<string, RegExp | readonly string[]>;
  occasionPattern?: RegExp;
  pickLinePattern?: RegExp;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface CallTimings {
  occasionToFirstLookSec: number | null;
  occasionToAllThreeSec: number | null;
  occasionToTryOnReadySec: number | null;
  pickToFirstWordSec: number | null;
}

export interface EvaluationReport {
  passed: boolean;
  checks: CheckResult[];
  warnings: string[];
  timings: CallTimings;
  toolCounts: Record<string, number>;
  duplicateToolCounts: Record<string, number>;
}

interface NotAddedItem {
  title: string;
  store?: string;
  reason: string;
}

const STOCK_REASON_RE =
  /\b(?:sold\s+out|out\s+of\s+stock|isn't\s+in\s+stock|not\s+in\s+stock|unavailable|no\s+longer\s+available|insufficient\s+(?:stock|inventory)|inventory)\b/i;

const NEGATION_RE =
  /\b(?:not|n't|cannot|can't|couldn't|could\s+not|wasn't|was\s+not|weren't|were\s+not|didn't|did\s+not|unable|failed|skipped|left\s+out|out\s+of\s+stock|sold\s+out|unavailable|missing|excluded|except|without|no\s+longer|isn't|aren't)\b/i;

const POSITIVE_BAG_CLAIM_RE =
  /\b(?:in\s+(?:your|the)\s+(?:bag|cart)|added(?:\s+[^.!?\n]{0,40})?\s+(?:to|into)\s+(?:your|the)\s+(?:bag|cart)|put\s+[^.!?\n]{0,40}\s+in(?:to)?\s+(?:your|the)\s+(?:bag|cart)|bagged|ready\s+(?:in\s+(?:your|the)\s+(?:bag|cart)|for\s+checkout))\b/i;

const BLANKET_BAG_CLAIM_RE =
  /\b(?:everything(?:'s|\s+is)|all\s+(?:three|four|five|\d+|the)\s+(?:pieces?|items?)|the\s+(?:whole|entire|full)\s+(?:look|outfit))\b[^.!?\n;]{0,40}\b(?:in\s+(?:your|the)\s+(?:bag|cart)|added|bagged)\b|\b(?:added|put)\s+(?:everything|all\s+(?:three|four|five|\d+|the)\s+(?:pieces?|items?)|the\s+(?:whole|entire|full)\s+(?:look|outfit))\s+(?:to|in|into)\s+(?:your|the)\s+(?:bag|cart)\b/i;

const TITLE_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'mens',
  'men',
  'womens',
  'women',
  'size',
  'color',
  'colour',
  'pack',
  'pair',
  'classic',
  'style',
  'modern',
  'slim',
  'regular',
  'relaxed',
  'fitted',
  'casual',
]);

const GARMENT_NOUNS = new Set([
  'boot',
  'boots',
  'shoe',
  'shoes',
  'loafer',
  'loafers',
  'sneaker',
  'sneakers',
  'shirt',
  'overshirt',
  'polo',
  'tee',
  'sweater',
  'knit',
  'jacket',
  'blazer',
  'coat',
  'pants',
  'trousers',
  'chino',
  'chinos',
  'jeans',
  'shorts',
  'dress',
  'skirt',
  'belt',
  'bag',
  'watch',
  'hat',
]);

function normalizeSlot(raw: string): string {
  const clean = raw.trim().toLowerCase();
  if (clean === 'shoe' || clean === 'footwear' || clean === 'boots') return 'shoes';
  if (clean === 'tops' || clean === 'shirt') return 'top';
  if (
    clean === 'bottoms' ||
    clean === 'pants' ||
    clean === 'trousers' ||
    clean === 'jeans' ||
    clean === 'waist'
  ) {
    return 'bottom';
  }
  if (clean === 'layers' || clean === 'jacket' || clean === 'coat' || clean === 'outerwear') {
    return 'layer';
  }
  if (clean === 'accessories') return 'accessory';
  if (clean === 'dresses') return 'dress';
  return clean;
}

function getBaseTimestampMs(events: readonly CallLogEntry[]): number | null {
  for (const entry of events) {
    if (typeof entry.t === 'string') {
      const parsed = Date.parse(entry.t);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function getEventMs(entry: CallLogEntry, baseTsMs: number | null): number | null {
  if (typeof entry.ms === 'number' && Number.isFinite(entry.ms)) {
    return entry.ms;
  }
  if (typeof entry.t === 'string' && baseTsMs !== null) {
    const parsed = Date.parse(entry.t);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed - baseTsMs);
    }
  }
  return null;
}

function roundSec(deltaMs: number): number {
  return Math.round((deltaMs / 1000) * 100) / 100;
}

function matchesSizeMatcher(value: string, matcher: RegExp | readonly string[]): boolean {
  const trimmed = value.trim();
  if (matcher instanceof RegExp) {
    return matcher.test(trimmed);
  }
  const lower = trimmed.toLowerCase();
  return matcher.some((allowed) => allowed.trim().toLowerCase() === lower);
}

function isStockReason(reason: string): boolean {
  return STOCK_REASON_RE.test(reason);
}

function extractNotAddedItems(events: readonly CallLogEntry[]): NotAddedItem[] {
  const items: NotAddedItem[] = [];
  for (const entry of events) {
    if (entry.ev !== 'bag') continue;
    if (!Array.isArray(entry.not_added)) continue;
    for (const raw of entry.not_added) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      const title = typeof rec.title === 'string' ? rec.title.trim() : '';
      const reason = typeof rec.reason === 'string' ? rec.reason.trim() : 'unavailable';
      const store = typeof rec.store === 'string' ? rec.store.trim() : undefined;
      if (title) {
        items.push({ title, store, reason });
      }
    }
  }
  return items;
}

function extractSignificantTitleWords(title: string): string[] {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w));
  return Array.from(new Set(words));
}

function clauseMentionsItem(clauseLower: string, itemTitle: string): boolean {
  const fullTitle = itemTitle.trim().toLowerCase();
  if (fullTitle.length > 0 && clauseLower.includes(fullTitle)) {
    return true;
  }

  const words = extractSignificantTitleWords(itemTitle);
  if (words.length === 0) return false;

  const matched = words.filter((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(clauseLower));
  if (words.length === 1) {
    return matched.length === 1;
  }
  if (matched.length >= 2) {
    return true;
  }
  return matched.length === 1 && GARMENT_NOUNS.has(matched[0]!);
}

function splitIntoClauses(text: string): string[] {
  return text
    .split(/(?:[.!?\n;]+|,\s*(?:but|however|though|although|except|while)\b)/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function findFalseBagClaims(
  events: readonly CallLogEntry[],
  lastBagIdx: number,
  notAdded: readonly NotAddedItem[],
): string[] {
  if (lastBagIdx < 0 || notAdded.length === 0) return [];

  const claims: string[] = [];
  for (let i = lastBagIdx + 1; i < events.length; i++) {
    const entry = events[i]!;
    if (entry.ev !== 'alice_said' || typeof entry.text !== 'string') continue;
    const text = entry.text.trim();
    if (!text) continue;

    const clauses = splitIntoClauses(text);
    for (const clause of clauses) {
      const clauseLower = clause.toLowerCase();
      if (BLANKET_BAG_CLAIM_RE.test(clause) && !/\b(?:except|without|minus|aside\s+from)\b/i.test(clause)) {
        claims.push(`blanket bag claim while ${notAdded.length} piece(s) not added: "${clause}"`);
        continue;
      }

      for (const item of notAdded) {
        if (!clauseMentionsItem(clauseLower, item.title)) continue;
        if (POSITIVE_BAG_CLAIM_RE.test(clause) && !NEGATION_RE.test(clause)) {
          claims.push(`claimed not-added item "${item.title}" is in bag: "${clause}"`);
        }
      }
    }
  }
  return claims;
}

function computeTimings(
  events: readonly CallLogEntry[],
  baseTsMs: number | null,
  occasionPattern: RegExp,
  pickLinePattern: RegExp,
): CallTimings {
  let occasionIdx = -1;
  let occasionMs: number | null = null;

  const buildCallIdx = events.findIndex((e) => e.ev === 'tool_call' && e.name === 'build_outfits');
  const searchEnd = buildCallIdx >= 0 ? buildCallIdx : events.length;

  for (let i = 0; i < searchEnd; i++) {
    const e = events[i]!;
    if (e.ev === 'user_said' && typeof e.text === 'string' && occasionPattern.test(e.text)) {
      occasionIdx = i;
      occasionMs = getEventMs(e, baseTsMs);
    }
  }

  if (occasionIdx === -1) {
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.ev === 'user_said' && typeof e.text === 'string' && occasionPattern.test(e.text)) {
        occasionIdx = i;
        occasionMs = getEventMs(e, baseTsMs);
        break;
      }
    }
  }

  let occasionToFirstLookSec: number | null = null;
  let occasionToAllThreeSec: number | null = null;
  let occasionToTryOnReadySec: number | null = null;

  if (occasionIdx >= 0 && occasionMs !== null) {
    const showOutfitsTimes: number[] = [];
    const buildProgressTimes: number[] = [];
    let buildDoneMs: number | null = null;
    let firstTryOnReadyMs: number | null = null;

    for (let i = occasionIdx; i < events.length; i++) {
      const e = events[i]!;
      const ms = getEventMs(e, baseTsMs);
      if (ms === null || ms < occasionMs) continue;

      if (e.ev === 'page' && e.action === 'showOutfits') {
        showOutfitsTimes.push(ms);
      } else if (e.ev === 'build_progress') {
        buildProgressTimes.push(ms);
      } else if (e.ev === 'build_done' && buildDoneMs === null) {
        buildDoneMs = ms;
      }

      if (
        firstTryOnReadyMs === null &&
        ((e.ev === 'page' && e.action === 'tryOnReady') ||
          (e.ev === 'tryon' && e.status === 'ready') ||
          e.ev === 'tryon_ready')
      ) {
        firstTryOnReadyMs = ms;
      }
    }

    const firstLookMs = showOutfitsTimes[0] ?? buildProgressTimes[0] ?? null;
    if (firstLookMs !== null) {
      occasionToFirstLookSec = roundSec(firstLookMs - occasionMs);
    }

    const allThreeMs =
      showOutfitsTimes[2] ?? buildProgressTimes[2] ?? buildDoneMs ?? null;
    if (allThreeMs !== null) {
      occasionToAllThreeSec = roundSec(allThreeMs - occasionMs);
    }

    if (firstTryOnReadyMs !== null) {
      occasionToTryOnReadySec = roundSec(firstTryOnReadyMs - occasionMs);
    }
  }

  let pickToFirstWordSec: number | null = null;
  const pickIdx = events.findIndex(
    (e) => e.ev === 'user_said' && typeof e.text === 'string' && pickLinePattern.test(e.text),
  );
  if (pickIdx >= 0) {
    const pickMs = getEventMs(events[pickIdx]!, baseTsMs);
    if (pickMs !== null) {
      for (let i = pickIdx + 1; i < events.length; i++) {
        const e = events[i]!;
        const isFirstWord =
          (e.ev === 'agent_state' && e.state === 'speaking') ||
          (e.ev === 'alice_said' && typeof e.text === 'string' && e.text.trim().length > 0);
        if (!isFirstWord) continue;
        const wordMs = getEventMs(e, baseTsMs);
        if (wordMs !== null && wordMs >= pickMs) {
          pickToFirstWordSec = roundSec(wordMs - pickMs);
          break;
        }
      }
    }
  }

  return {
    occasionToFirstLookSec,
    occasionToAllThreeSec,
    occasionToTryOnReadySec,
    pickToFirstWordSec,
  };
}

/**
 * Evaluates a parsed call log against the expected flow, error rules, swap color,
 * bag sizes, honest bag disclosures, and key latency milestones.
 */
export function evaluateCallLog(
  events: readonly CallLogEntry[],
  expectations: CallExpectations = {},
): EvaluationReport {
  const expectedTools = expectations.expectedTools ?? DEFAULT_EXPECTED_TOOLS;
  const restartGraceMs = expectations.restartGraceMs ?? 5_000;
  const swapSlot = normalizeSlot(expectations.swapSlot ?? 'shoes');
  const swapColorPattern = expectations.swapColorPattern ?? DEFAULT_SWAP_COLOR_PATTERN;
  const expectedSizes = expectations.expectedSizes ?? DEFAULT_EXPECTED_SIZES;
  const occasionPattern =
    expectations.occasionPattern ?? /rooftop|birthday|dinner|budget|three\s+hundred|\b300\b|menswear/i;
  const pickLinePattern =
    expectations.pickLinePattern ?? /second\s+one|like\s+the\s+second|look\s*(?:2|two)\b/i;

  const baseTsMs = getBaseTimestampMs(events);
  const checks: CheckResult[] = [];
  const warnings: string[] = [];

  // 1. Restart after grace period and error-class events
  const lateRestarts: string[] = [];
  const errorEvents: string[] = [];
  const pageErrors: string[] = [];

  for (const entry of events) {
    const ms = getEventMs(entry, baseTsMs);
    if (entry.ev === 'restart') {
      if (ms === null || ms > restartGraceMs) {
        const at = ms !== null ? `+${(ms / 1000).toFixed(2)}s` : 'unknown time';
        lateRestarts.push(`restart at ${at}`);
      }
      continue;
    }

    if (entry.ev === 'page_error') {
      const action = typeof entry.action === 'string' ? entry.action : 'unknown';
      const errMsg = typeof entry.error === 'string' ? entry.error : JSON.stringify(entry.error ?? '');
      pageErrors.push(`${action}: ${errMsg}`);
    }

    if (isBadEvent(entry)) {
      const evName = typeof entry.ev === 'string' ? entry.ev : 'unknown';
      const at = ms !== null ? `+${(ms / 1000).toFixed(2)}s` : '?s';
      errorEvents.push(`${evName}@${at}`);
    }
  }

  checks.push({
    name: 'no_late_restart',
    passed: lateRestarts.length === 0,
    detail: lateRestarts.length === 0 ? 'no restart after 5s' : lateRestarts.join('; '),
  });

  checks.push({
    name: 'no_error_events',
    passed: errorEvents.length === 0,
    detail: errorEvents.length === 0 ? 'no error-class events' : errorEvents.join(', '),
  });

  checks.push({
    name: 'no_page_error',
    passed: pageErrors.length === 0,
    detail: pageErrors.length === 0 ? 'no page_error events' : pageErrors.join('; '),
  });

  // 2. Expected tools ran once (excluding logged tool_duplicate events; allow add_to_bag NOT DONE size prompt)
  const toolCounts: Record<string, number> = {};
  const duplicateToolCounts: Record<string, number> = {};
  const addToBagNotDoneCallIds = new Set<string>();
  let addToBagNotDoneResults = 0;

  for (const entry of events) {
    if (entry.ev === 'tool_call' && typeof entry.name === 'string') {
      toolCounts[entry.name] = (toolCounts[entry.name] ?? 0) + 1;
    } else if (entry.ev === 'tool_duplicate' && typeof entry.name === 'string') {
      duplicateToolCounts[entry.name] = (duplicateToolCounts[entry.name] ?? 0) + 1;
    } else if (
      entry.ev === 'tool_result' &&
      entry.name === 'add_to_bag' &&
      typeof entry.text === 'string' &&
      /^NOT DONE:.*(?:size|sizes)/i.test(entry.text.trim())
    ) {
      addToBagNotDoneResults += 1;
      if (typeof entry.call_id === 'string' && entry.call_id.length > 0) {
        addToBagNotDoneCallIds.add(entry.call_id);
      }
    }
  }

  const missingTools: string[] = [];
  const extraTools: string[] = [];
  for (const tool of expectedTools) {
    const count = toolCounts[tool] ?? 0;
    if (count === 0) {
      missingTools.push(tool);
    } else if (count > 1) {
      const allowedRetries =
        tool === 'add_to_bag'
          ? Math.max(addToBagNotDoneCallIds.size, addToBagNotDoneResults)
          : 0;
      const effectiveCount = count - allowedRetries;
      if (effectiveCount !== 1) {
        extraTools.push(`${tool} (${count}x)`);
      }
    }
  }

  const toolIssues = [
    ...(missingTools.length > 0 ? [`missing: ${missingTools.join(', ')}`] : []),
    ...(extraTools.length > 0 ? [`ran more than once: ${extraTools.join(', ')}`] : []),
  ];
  checks.push({
    name: 'expected_tools',
    passed: toolIssues.length === 0,
    detail:
      toolIssues.length === 0
        ? `all ${expectedTools.length} expected tools ran once`
        : toolIssues.join('; '),
  });

  // 3. Swap result names a brown item for the shoes slot
  const swapEvents = events.filter((e) => e.ev === 'swap');
  const matchingSlotSwaps = swapEvents.filter(
    (e) => typeof e.slot === 'string' && normalizeSlot(e.slot) === swapSlot,
  );
  let swapPassed = false;
  let swapDetail = `no swap event for slot "${swapSlot}"`;

  if (matchingSlotSwaps.length > 0) {
    const lastSwap = matchingSlotSwaps[matchingSlotSwaps.length - 1]!;
    const title = typeof lastSwap.title === 'string' ? lastSwap.title : '';
    if (swapColorPattern.test(title)) {
      swapPassed = true;
      swapDetail = `${swapSlot} swapped to "${title}"`;
    } else {
      swapDetail = `${swapSlot} swap title "${title || '(empty)'}" did not match brown item`;
    }
  } else {
    const swapResult = [...events]
      .reverse()
      .find((e) => e.ev === 'tool_result' && e.name === 'swap_piece' && typeof e.text === 'string');
    if (swapResult && typeof swapResult.text === 'string') {
      const text = swapResult.text;
      if (new RegExp(`\\b${swapSlot}\\b`, 'i').test(text) && swapColorPattern.test(text)) {
        swapPassed = true;
        swapDetail = `swap_piece result matched brown ${swapSlot}`;
      } else {
        swapDetail = `swap_piece result did not name a brown ${swapSlot} item`;
      }
    }
  }

  checks.push({
    name: 'swap_brown_shoes',
    passed: swapPassed,
    detail: swapDetail,
  });

  // 4. Bag sizes match and not_added stock warnings vs non-stock failures
  const mergedSizes: Record<string, string> = {};
  for (const entry of events) {
    if (entry.ev === 'tool_call' && entry.name === 'add_to_bag') {
      const args = entry.args as Record<string, unknown> | undefined;
      const sizes = args?.sizes as Record<string, unknown> | undefined;
      if (sizes && typeof sizes === 'object') {
        for (const [k, v] of Object.entries(sizes)) {
          if (typeof v === 'string' && v.trim().length > 0) {
            mergedSizes[normalizeSlot(k)] = v.trim();
          }
        }
      }
    } else if (entry.ev === 'bag') {
      const sizes = entry.sizes as Record<string, unknown> | undefined;
      if (sizes && typeof sizes === 'object') {
        for (const [k, v] of Object.entries(sizes)) {
          if (typeof v === 'string' && v.trim().length > 0) {
            mergedSizes[normalizeSlot(k)] = v.trim();
          }
        }
      }
    }
  }

  let lastBagIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.ev === 'bag') {
      lastBagIdx = i;
      break;
    }
  }

  const sizeIssues: string[] = [];
  if (lastBagIdx < 0) {
    sizeIssues.push('no bag event logged');
  }
  for (const [slot, matcher] of Object.entries(expectedSizes)) {
    const normSlot = normalizeSlot(slot);
    const actual = mergedSizes[normSlot];
    if (!actual) {
      sizeIssues.push(`missing ${normSlot} size`);
    } else if (!matchesSizeMatcher(actual, matcher)) {
      sizeIssues.push(`${normSlot} size "${actual}" did not match expected`);
    }
  }

  const notAdded = extractNotAddedItems(events);
  const nonStockNotAdded: string[] = [];
  for (const item of notAdded) {
    const label = item.store ? `${item.title} (${item.store}): ${item.reason}` : `${item.title}: ${item.reason}`;
    if (isStockReason(item.reason)) {
      warnings.push(`not added (stock): ${label}`);
    } else {
      nonStockNotAdded.push(label);
    }
  }

  const bagIssues = [
    ...sizeIssues,
    ...(nonStockNotAdded.length > 0 ? [`not added (non-stock): ${nonStockNotAdded.join('; ')}`] : []),
  ];
  checks.push({
    name: 'bag_sizes_and_items',
    passed: bagIssues.length === 0,
    detail:
      bagIssues.length === 0
        ? `sizes matched (${Object.entries(mergedSizes)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')})`
        : bagIssues.join('; '),
  });

  // 5. Alice never claimed a not_added piece is in the bag
  const falseClaims = findFalseBagClaims(events, lastBagIdx, notAdded);
  checks.push({
    name: 'no_false_bag_claim',
    passed: falseClaims.length === 0,
    detail:
      falseClaims.length === 0
        ? notAdded.length === 0
          ? 'all pieces added'
          : 'no false bag claims after bag result'
        : falseClaims.join('; '),
  });

  const timings = computeTimings(events, baseTsMs, occasionPattern, pickLinePattern);
  const passed = checks.every((c) => c.passed);

  return {
    passed,
    checks,
    warnings,
    timings,
    toolCounts,
    duplicateToolCounts,
  };
}

export function formatSec(sec: number | null): string {
  return sec === null ? 'n/a' : `${sec.toFixed(2)}s`;
}

export function formatReport(room: string, report: EvaluationReport, consoleErrors: readonly string[] = []): string {
  const lines: string[] = [];
  lines.push(`=== Harness Report: ${room} [${report.passed ? 'PASS' : 'FAIL'}] ===`);
  for (const check of report.checks) {
    lines.push(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
  }
  if (report.warnings.length > 0) {
    lines.push('  Warnings:');
    for (const w of report.warnings) {
      lines.push(`    - ${w}`);
    }
  }
  const dupEntries = Object.entries(report.duplicateToolCounts);
  if (dupEntries.length > 0) {
    lines.push(
      `  Logged tool duplicates: ${dupEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`,
    );
  }
  lines.push('  Timings:');
  lines.push(`    occasion -> first look on page: ${formatSec(report.timings.occasionToFirstLookSec)}`);
  lines.push(`    occasion -> all three looks:    ${formatSec(report.timings.occasionToAllThreeSec)}`);
  lines.push(`    occasion -> try-on ready:       ${formatSec(report.timings.occasionToTryOnReadySec)}`);
  lines.push(`    pick look 2 -> Alice 1st word:  ${formatSec(report.timings.pickToFirstWordSec)}`);
  if (consoleErrors.length > 0) {
    lines.push(`  Browser console errors (${consoleErrors.length}):`);
    for (const err of consoleErrors.slice(0, 10)) {
      lines.push(`    - ${err}`);
    }
  }
  return lines.join('\n');
}
