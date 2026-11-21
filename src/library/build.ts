// Pre-builds popular occasion sets using the live builder, embeds their occasion + wordings,
// and saves each kept set incrementally to src/library/sets.json.
// Usage: node --env-file-if-exists=.env.local src/library/build.ts [--tier base|premium] [--only key1,key2] [--gender men|women] [--resume|--rebuild]
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Brief, BuildResult, Gender } from '../types.ts';
import { buildLive as defaultBuildLive } from '../brain/build.ts';
import { setCallRoom, setCallLogSink } from '../store/log.ts';
import { OCCASIONS, type LibraryOccasion } from './occasions.ts';
import { embed as defaultEmbed, occasionText } from './embed.ts';
import { PREMIUM_TIER_SUFFIX, type LibraryFile, type LibrarySet } from './index.ts';

const CONCURRENCY = 3;
const COST_PER_ATTEMPT_USD = 0.09;
const DEFAULT_MAX_PAID_USD = 30;
const DEFAULT_STOP_AT_NY = '15:50';
const PREMIUM_BUDGET_MIN = 450;
const PREMIUM_BUDGET_MAX = 1500;
const PREMIUM_BUDGET_MULTIPLIER = 2.5;
const BAD_PROBLEM_RE = /over budget|incomplete|only \d complete/i;
const DEFAULT_SETS_PATH = path.resolve(import.meta.dirname, 'sets.json');

export type BuildTier = 'base' | 'premium';

interface Task {
  occ: LibraryOccasion;
  gender: Gender;
  key: string;
  budgetUsd: number;
}

export interface ParsedArgs {
  only: Set<string> | null;
  genders: Gender[];
  resume: boolean;
  tier: BuildTier;
}

export interface BuildDeps {
  buildLive?: (brief: Brief) => Promise<BuildResult>;
  embed?: (texts: string[]) => Promise<number[][]>;
  log?: (line: string) => void;
  occasions?: LibraryOccasion[];
  now?: () => Date;
}

export interface BuildRunSummary {
  total: number;
  kept: number;
  failed: number;
  skipped: number;
  stopReason: 'rate_limited' | 'time fence' | null;
  lines: string[];
}

export function premiumBudget(base: Pick<LibraryOccasion, 'budget'>, gender: Gender): number {
  const baseUsd = base.budget[gender] ?? base.budget.men ?? base.budget.women;
  const scaled = Math.round((baseUsd * PREMIUM_BUDGET_MULTIPLIER) / 10) * 10;
  return Math.min(PREMIUM_BUDGET_MAX, Math.max(PREMIUM_BUDGET_MIN, scaled));
}

export function tierKey(baseKey: string, tier: BuildTier): string {
  return tier === 'premium' ? `${baseKey}${PREMIUM_TIER_SUFFIX}` : baseKey;
}

export function tierBudget(occ: Pick<LibraryOccasion, 'budget'>, gender: Gender, tier: BuildTier): number {
  if (tier === 'premium') return premiumBudget(occ, gender);
  return occ.budget[gender] ?? occ.budget.men ?? occ.budget.women;
}

function parseTier(raw: string): BuildTier {
  const t = raw.trim().toLowerCase();
  if (t !== 'base' && t !== 'premium') throw new Error(`Invalid --tier: ${raw}`);
  return t;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let only: Set<string> | null = null;
  let genders: Gender[] = ['men', 'women'];
  let resume = true;
  let tier: BuildTier = 'base';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--only' && argv[i + 1]) {
      only = new Set(argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg.startsWith('--only=')) {
      only = new Set(arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg === '--gender' && argv[i + 1]) {
      const g = argv[++i].trim().toLowerCase();
      if (g !== 'men' && g !== 'women') throw new Error(`Invalid --gender: ${g}`);
      genders = [g];
    } else if (arg.startsWith('--gender=')) {
      const g = arg.slice('--gender='.length).trim().toLowerCase();
      if (g !== 'men' && g !== 'women') throw new Error(`Invalid --gender: ${g}`);
      genders = [g];
    } else if (arg === '--tier' && argv[i + 1]) {
      tier = parseTier(argv[++i]);
    } else if (arg.startsWith('--tier=')) {
      tier = parseTier(arg.slice('--tier='.length));
    } else if (arg === '--resume') {
      resume = true;
    } else if (arg === '--rebuild') {
      resume = false;
    }
  }
  return { only, genders, resume, tier };
}

function setsPath(): string {
  const override = process.env.ALICE_LIBRARY_FILE;
  if (override && override.trim().length > 0) return path.resolve(override);
  return DEFAULT_SETS_PATH;
}

function readExistingSets(): LibrarySet[] {
  try {
    const raw = readFileSync(setsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LibraryFile>;
    return Array.isArray(parsed?.sets) ? parsed.sets : [];
  } catch {
    return [];
  }
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

function isKept(result: BuildResult, budgetUsd: number): boolean {
  if (result.outfits.length !== 3) return false;
  if (result.outfits.some((o) => o.total > budgetUsd)) return false;
  if (result.problems.some((p) => BAD_PROBLEM_RE.test(p))) return false;
  return true;
}

function mergeAndWriteSet(entry: LibrarySet): void {
  const filePath = setsPath();
  const existingSets = readExistingSets();
  const nextSets = existingSets.filter((s) => !(s.key === entry.key && s.gender === entry.gender));
  nextSets.push(entry);

  const payload: LibraryFile = {
    version: 1,
    built_at: new Date().toISOString(),
    sets: nextSets,
  };

  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function formatTotals(result: BuildResult): string {
  return `[${result.outfits.map((o) => `$${o.total}`).join(', ')}]`;
}

function formatElapsed(startedAt: number): string {
  const sec = Math.max(0, Math.round((performance.now() - startedAt) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function parseStopMinutes(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'off' || trimmed === 'none') return null;
  const m = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function isPastNewYorkFence(stopMinutes: number | null, nowDate: Date): boolean {
  if (stopMinutes === null) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(nowDate);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m >= stopMinutes;
}

async function loadAllOccasions(): Promise<LibraryOccasion[]> {
  let extras: LibraryOccasion[] = [];
  try {
    const mod = (await import('./occasions-extra.ts')) as { EXTRA_OCCASIONS?: unknown };
    if (Array.isArray(mod?.EXTRA_OCCASIONS)) {
      extras = mod.EXTRA_OCCASIONS as LibraryOccasion[];
    }
  } catch {
    // occasions-extra.ts is optional and may not exist yet
  }

  const seen = new Set<string>();
  const combined: LibraryOccasion[] = [];
  for (const occ of [...OCCASIONS, ...extras]) {
    if (!occ?.key || seen.has(occ.key)) continue;
    seen.add(occ.key);
    combined.push(occ);
  }
  return combined;
}

export async function runBuild(
  args: ParsedArgs,
  deps: BuildDeps = {},
): Promise<BuildRunSummary> {
  const buildLiveFn = deps.buildLive ?? defaultBuildLive;
  const embedFn = deps.embed ?? defaultEmbed;
  const logFn = deps.log ?? ((line: string) => console.log(line));
  const nowFn = deps.now ?? (() => new Date());

  const lines: string[] = [];
  const emit = (line: string) => {
    lines.push(line);
    logFn(line);
  };

  let stopReason: 'rate_limited' | 'time fence' | null = null;
  setCallRoom('library-build');
  setCallLogSink((_room, ev, data) => {
    if (ev === 'store_error' && data?.code === 'rate_limited') {
      stopReason = 'rate_limited';
    }
  });

  try {
    const maxAttempts = Math.max(1, Math.floor(Number(process.env.ALICE_LIBRARY_ATTEMPTS ?? 2)) || 2);
    const rawMaxPaid = process.env.ALICE_LIBRARY_MAX_PAID;
    const maxPaid =
      rawMaxPaid !== undefined && rawMaxPaid.trim() !== '' && Number.isFinite(Number(rawMaxPaid))
        ? Number(rawMaxPaid)
        : DEFAULT_MAX_PAID_USD;
    const stopMinutes = parseStopMinutes(process.env.ALICE_LIBRARY_STOP_AT ?? DEFAULT_STOP_AT_NY);

    const allOccasions = deps.occasions ?? (await loadAllOccasions());
    const selected = args.only
      ? allOccasions.filter((o) => args.only!.has(o.key) || args.only!.has(tierKey(o.key, args.tier)))
      : allOccasions;
    if (selected.length === 0) {
      return { total: 0, kept: 0, failed: 0, skipped: 0, stopReason: null, lines };
    }

    const existingSets = readExistingSets();
    const existingKeys = args.resume
      ? new Set(existingSets.map((s) => `${s.key}:${s.gender}`))
      : new Set<string>();

    const tasks: Task[] = [];
    let skipped = 0;
    for (const occ of selected) {
      for (const gender of args.genders) {
        if (occ.genders && !occ.genders.includes(gender)) continue;
        const key = tierKey(occ.key, args.tier);
        if (args.resume && existingKeys.has(`${key}:${gender}`)) {
          skipped += 1;
          continue;
        }
        const budgetUsd = tierBudget(occ, gender, args.tier);
        tasks.push({ occ, gender, key, budgetUsd });
      }
    }

    if (tasks.length === 0) {
      emit('All selected sets are already present in sets.json (use --rebuild to force).');
      return { total: 0, kept: 0, failed: 0, skipped, stopReason: null, lines };
    }

    const runStarted = performance.now();
    let estimatedSpend = 0;
    let nextIdx = 0;
    let completed = 0;
    let keptCount = 0;
    let failedCount = 0;
    const totalTasks = tasks.length;

    function checkStopBeforeStart(): boolean {
      if (stopReason) return true;
      if (isPastNewYorkFence(stopMinutes, nowFn())) {
        stopReason = 'time fence';
        return true;
      }
      return false;
    }

    async function runOne(task: Task): Promise<void> {
      const { occ, gender, key, budgetUsd } = task;
      const brief: Brief = { gender, occasion: occ.occasion, budget_usd: budgetUsd };

      let lastResult: BuildResult | null = null;
      let kept = false;
      let builtMs = 0;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (checkStopBeforeStart()) return;

        if (estimatedSpend + COST_PER_ATTEMPT_USD > maxPaid + 1e-9) {
          completed += 1;
          failedCount += 1;
          emit(
            `[${completed}/${totalTasks}] ${key} ${gender} failed $${estimatedSpend.toFixed(2)} ${formatElapsed(runStarted)} totals=${lastResult ? formatTotals(lastResult) : '[]'} first_outfit_ms=${lastResult?.timing.first_outfit_ms ?? 0} problems=["spend cap reached ($${estimatedSpend.toFixed(2)}/$${maxPaid.toFixed(2)})"]`,
          );
          return;
        }
        estimatedSpend += COST_PER_ATTEMPT_USD;

        const t0 = performance.now();
        let result: BuildResult;
        try {
          result = await buildLiveFn(brief);
        } catch (err) {
          builtMs = Math.round(performance.now() - t0);
          lastResult = {
            outfits: [],
            source: 'live',
            timing: { first_outfit_ms: 0, total_ms: builtMs },
            problems: [`buildLive threw: ${(err as Error)?.message ?? String(err)}`],
          };
          continue;
        }
        builtMs = Math.round(performance.now() - t0);
        lastResult = result;

        if (isKept(result, budgetUsd)) {
          kept = true;
          break;
        }
      }

      if (!kept || !lastResult) {
        completed += 1;
        failedCount += 1;
        const probs = lastResult?.problems ?? ['no build result'];
        emit(
          `[${completed}/${totalTasks}] ${key} ${gender} failed $${estimatedSpend.toFixed(2)} ${formatElapsed(runStarted)} totals=${lastResult ? formatTotals(lastResult) : '[]'} first_outfit_ms=${lastResult?.timing.first_outfit_ms ?? 0} problems=${JSON.stringify(probs)}`,
        );
        return;
      }

      let vectors: number[][] | null = null;
      if (args.tier === 'premium') {
        const baseSet = readExistingSets().find(
          (s) => s.key === occ.key && s.gender === gender && Array.isArray(s.vectors) && s.vectors.length > 0,
        );
        if (baseSet) {
          vectors = structuredClone(baseSet.vectors);
        }
      }

      if (!vectors) {
        const texts = [...new Set([
          occasionText(gender, occ.occasion),
          ...occ.wordings.map((w) => occasionText(gender, w)),
        ])];
        try {
          const rawVectors = await embedFn(texts);
          vectors = rawVectors.map((vec) => vec.map(round5));
        } catch (err) {
          completed += 1;
          failedCount += 1;
          emit(
            `[${completed}/${totalTasks}] ${key} ${gender} failed $${estimatedSpend.toFixed(2)} ${formatElapsed(runStarted)} totals=${formatTotals(lastResult)} first_outfit_ms=${lastResult.timing.first_outfit_ms} problems=${JSON.stringify([`embed failed: ${(err as Error)?.message ?? String(err)}`])}`,
          );
          return;
        }
      }

      const entry: LibrarySet = {
        key,
        gender,
        occasion: occ.occasion,
        budget_usd: budgetUsd,
        outfits: lastResult.outfits,
        vectors,
        built_ms: builtMs,
      };

      mergeAndWriteSet(entry);
      completed += 1;
      keptCount += 1;
      emit(
        `[${completed}/${totalTasks}] ${key} ${gender} kept $${estimatedSpend.toFixed(2)} ${formatElapsed(runStarted)} totals=${formatTotals(lastResult)} first_outfit_ms=${lastResult.timing.first_outfit_ms}`,
      );
    }

    async function worker(): Promise<void> {
      while (nextIdx < tasks.length) {
        if (checkStopBeforeStart()) return;
        const idx = nextIdx++;
        await runOne(tasks[idx]);
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker());
    await Promise.all(workers);

    if (stopReason === 'rate_limited') {
      emit('STOPPED: rate_limited');
    } else if (stopReason === 'time fence') {
      emit('STOPPED: time fence');
    }

    return {
      total: totalTasks,
      kept: keptCount,
      failed: failedCount,
      skipped,
      stopReason,
      lines,
    };
  } finally {
    setCallLogSink(null);
    setCallRoom(null);
  }
}

async function main(): Promise<void> {
  // Ensure ALICE_BRAIN is unset as specified; buildLive does not need it.
  delete process.env.ALICE_BRAIN;

  const args = parseArgs(process.argv.slice(2));
  const summary = await runBuild(args);
  if (summary.total === 0 && summary.skipped === 0 && summary.lines.length === 0) {
    console.error('No matching occasions found.');
    process.exitCode = 1;
    return;
  }

  if (summary.stopReason === 'rate_limited') {
    process.exitCode = 2;
  } else if (summary.stopReason === 'time fence') {
    process.exitCode = 0;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
