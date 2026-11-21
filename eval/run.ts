// Evaluation runner: compares the live outfit pipeline against the one-call baseline
// on the same occasions, graded by the same Argon critic and hard dress-code checks.
// Usage: node --env-file-if-exists=.env.local eval/run.ts [--only id1,id2] [--skip-baseline] [--skip-pipeline]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Brief, BuildResult, Gender, Outfit } from '../src/types.ts';
import { buildLive as defaultBuildLive } from '../src/brain/build.ts';
import { critiqueAll as defaultCritiqueAll, type Critique, type CritiqueOptions } from '../src/brain/critic.ts';
import { breaksDressCode } from '../src/brain/words.ts';
import { ledgerPath, ledgerTotal } from '../src/ledger.ts';
import {
  setCallLogSink as defaultSetCallLogSink,
  setCallRoom as defaultSetCallRoom,
  type CallLogSink,
} from '../src/store/log.ts';
import { EVAL_OCCASIONS, type EvalOccasion, type EvalSource } from './occasions.ts';
import { baselineBuild as defaultBaselineBuild, type BaselineResult } from './baseline.ts';

export const DEFAULT_RESULTS_PATH = path.resolve(import.meta.dirname, 'results', 'latest.json');
export const PIPELINE_FALLBACK_USD = 0.08;
const CONCURRENCY = 2;
const CRITIC_TIMEOUT_MS = 60000;

export interface DressCodeHit {
  outfit_index: number;
  outfit_name: string;
  slot: string;
  title: string;
}

export interface SideResult {
  scores: number[];
  presentable_count: number;
  presentable: boolean;
  avg: number;
  min: number;
  issues: string[];
  outfit_issues: string[][];
  outfit_names: string[];
  outfit_totals: number[];
  dress_code_hits: DressCodeHit[];
  over_budget: number;
  missing_shoes_or_bottom: number;
  other_department_items: number;
  first_ms: number;
  total_ms: number;
  usd: number;
  usd_source: 'ledger' | 'tokens' | 'estimate';
  outfit_count: number;
  error?: string;
}

export interface OccasionResult {
  id: string;
  gender: Gender;
  occasion: string;
  budget_usd: number;
  source: EvalSource;
  pipeline?: SideResult;
  baseline?: SideResult;
}

export interface EvalResultsFile {
  version: 1;
  run_at: string;
  git_commit: string;
  stopped_reason?: string;
  results: OccasionResult[];
}

export interface ParsedRunArgs {
  only: Set<string> | null;
  skipBaseline: boolean;
  skipPipeline: boolean;
}

export interface EvalRunOptions {
  occasions?: EvalOccasion[];
  only?: Set<string> | null;
  skipBaseline?: boolean;
  skipPipeline?: boolean;
  outPath?: string;
  concurrency?: number;
}

export interface EvalRunDeps {
  buildLive?: (brief: Brief) => Promise<BuildResult>;
  baselineBuild?: (brief: Brief) => Promise<BaselineResult>;
  critiqueAll?: (outfits: Outfit[], brief: Brief, opts?: CritiqueOptions) => Promise<Critique[]>;
  setCallRoom?: (room: string | null) => void;
  setCallLogSink?: (sink: CallLogSink | null) => void;
  readLedgerFile?: () => Promise<string>;
  gitCommit?: () => string;
  now?: () => Date;
  log?: (line: string) => void;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

let writeSeq = 0;

export function parseRunArgs(argv: string[]): ParsedRunArgs {
  let only: Set<string> | null = null;
  let skipBaseline = false;
  let skipPipeline = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--only' && argv[i + 1]) {
      only = new Set(argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg.startsWith('--only=')) {
      only = new Set(arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg === '--skip-baseline') {
      skipBaseline = true;
    } else if (arg === '--skip-pipeline') {
      skipPipeline = true;
    }
  }
  return { only, skipBaseline, skipPipeline };
}

export function getGitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isMissingShoesOrBottom(outfit: Outfit): boolean {
  const slots = new Set(outfit.pieces.map((p) => p.slot));
  const hasShoes = slots.has('shoes');
  const hasBottom = slots.has('bottom') || slots.has('dress');
  return !hasShoes || !hasBottom;
}

export function evaluateSide(
  outfits: Outfit[],
  critiques: Critique[],
  brief: Brief,
  timing: { first_ms: number; total_ms: number },
  cost: { usd: number; usd_source: SideResult['usd_source'] },
): SideResult {
  const scores = critiques.map((c) => c.score);
  const validScores = scores.filter((s) => s > 0);
  const avg = validScores.length > 0
    ? round2(validScores.reduce((sum, s) => sum + s, 0) / validScores.length)
    : 0;
  const min = validScores.length > 0 ? Math.min(...validScores) : 0;
  const presentableCount = critiques.filter((c) => c.presentable).length;

  const outfitIssues = critiques.map((c) => {
    const list = [...c.issues];
    if (c.error) list.push(`critic error: ${c.error}`);
    return list;
  });
  const issues = outfitIssues.flat();

  const dressCodeHits: DressCodeHit[] = [];
  let overBudget = 0;
  let missingShoesOrBottom = 0;
  let otherDepartmentItems = 0;

  for (let i = 0; i < outfits.length; i++) {
    const outfit = outfits[i];
    if (outfit.total > brief.budget_usd) overBudget += 1;
    if (isMissingShoesOrBottom(outfit)) missingShoesOrBottom += 1;
    for (const piece of outfit.pieces) {
      if (piece.item.department !== brief.gender) otherDepartmentItems += 1;
      if (breaksDressCode(piece.item, piece.slot, brief)) {
        dressCodeHits.push({
          outfit_index: i + 1,
          outfit_name: outfit.name,
          slot: piece.slot,
          title: piece.item.title,
        });
      }
    }
  }

  return {
    scores,
    presentable_count: presentableCount,
    presentable: presentableCount >= 2,
    avg,
    min,
    issues,
    outfit_issues: outfitIssues,
    outfit_names: outfits.map((o) => o.name),
    outfit_totals: outfits.map((o) => o.total),
    dress_code_hits: dressCodeHits,
    over_budget: overBudget,
    missing_shoes_or_bottom: missingShoesOrBottom,
    other_department_items: otherDepartmentItems,
    first_ms: timing.first_ms,
    total_ms: timing.total_ms,
    usd: round6(cost.usd),
    usd_source: cost.usd_source,
    outfit_count: outfits.length,
  };
}

function failedSide(error: unknown, totalMs: number): SideResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    scores: [],
    presentable_count: 0,
    presentable: false,
    avg: 0,
    min: 0,
    issues: [],
    outfit_issues: [],
    outfit_names: [],
    outfit_totals: [],
    dress_code_hits: [],
    over_budget: 0,
    missing_shoes_or_bottom: 0,
    other_department_items: 0,
    first_ms: 0,
    total_ms: totalMs,
    usd: 0,
    usd_source: 'estimate',
    outfit_count: 0,
    error: message,
  };
}

// Tracks pipeline-only entries written to data/cost-ledger.jsonl during active builds,
// splitting overlapping concurrent slices cleanly so the total and average stay exact.
class PipelineLedgerTracker {
  private lastLine = 0;
  private initialized = false;
  private active = new Set<string>();
  private accrued = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private readLedger: () => Promise<string>;

  constructor(readLedger: () => Promise<string>) {
    this.readLedger = readLedger;
  }

  private async readLines(): Promise<string[]> {
    try {
      const raw = await this.readLedger();
      return raw ? raw.split('\n').filter((l) => l.trim().length > 0) : [];
    } catch {
      return [];
    }
  }

  private async flushLocked(): Promise<void> {
    const lines = await this.readLines();
    if (!this.initialized) {
      this.lastLine = lines.length;
      this.initialized = true;
      return;
    }
    if (lines.length < this.lastLine) {
      this.lastLine = lines.length;
      return;
    }
    let sliceUsd = 0;
    for (let i = this.lastLine; i < lines.length; i++) {
      try {
        const row = JSON.parse(lines[i]) as { pid?: number; job?: string; usd?: number };
        if (row.pid !== process.pid) continue;
        if (typeof row.job !== 'string' || !row.job.startsWith('brain_') || row.job === 'brain_critic') continue;
        if (typeof row.usd === 'number' && Number.isFinite(row.usd)) {
          sliceUsd += row.usd;
        }
      } catch {
        // Skip malformed lines.
      }
    }
    this.lastLine = lines.length;
    if (sliceUsd > 0 && this.active.size > 0) {
      const share = sliceUsd / this.active.size;
      for (const id of this.active) {
        this.accrued.set(id, (this.accrued.get(id) ?? 0) + share);
      }
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  start(id: string): Promise<void> {
    return this.serialize(async () => {
      await this.flushLocked();
      this.active.add(id);
      this.accrued.set(id, 0);
    });
  }

  finish(id: string): Promise<number> {
    return this.serialize(async () => {
      await this.flushLocked();
      const usd = this.accrued.get(id) ?? 0;
      this.active.delete(id);
      this.accrued.delete(id);
      return usd;
    });
  }
}

function writeJsonAtomic(filePath: string, payload: EvalResultsFile): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeSeq += 1;
  const tmpPath = `${filePath}.${process.pid}.${writeSeq}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function formatSideLine(label: string, side: SideResult | undefined): string {
  if (!side) return `${label}=skipped`;
  if (side.error) return `${label}=ERR(${side.error})`;
  const scores = `[${side.scores.join(',')}]`;
  return `${label} avg=${side.avg.toFixed(2)} scores=${scores} pres=${side.presentable_count}/${side.outfit_count} first=${side.first_ms}ms total=${side.total_ms}ms $${side.usd.toFixed(4)}`;
}

export async function runEval(opts: EvalRunOptions = {}, deps: EvalRunDeps = {}): Promise<EvalResultsFile> {
  const buildLiveFn = deps.buildLive ?? defaultBuildLive;
  const baselineBuildFn = deps.baselineBuild ?? defaultBaselineBuild;
  const critiqueAllFn = deps.critiqueAll ?? defaultCritiqueAll;
  const setRoomFn = deps.setCallRoom ?? defaultSetCallRoom;
  const setSinkFn = deps.setCallLogSink ?? defaultSetCallLogSink;
  const gitCommitFn = deps.gitCommit ?? getGitCommit;
  const nowFn = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const outPath = opts.outPath ?? DEFAULT_RESULTS_PATH;
  const concurrency = Math.max(1, opts.concurrency ?? CONCURRENCY);

  const readLedger = deps.readLedgerFile ?? (async () => {
    await ledgerTotal();
    try {
      return readFileSync(ledgerPath(), 'utf8');
    } catch {
      return '';
    }
  });
  const ledgerTracker = new PipelineLedgerTracker(readLedger);

  let rateLimited = false;
  setRoomFn('eval');
  setSinkFn((_room, ev, data) => {
    if (ev === 'store_error' && data?.code === 'rate_limited') {
      rateLimited = true;
    }
  });

  const sourceOccasions = opts.occasions ?? EVAL_OCCASIONS;
  const nonEmpty = sourceOccasions.filter((o) => o.occasion.trim().length > 0);
  const selected = opts.only
    ? nonEmpty.filter((o) => opts.only!.has(o.id))
    : nonEmpty;

  const orderIndex = new Map(sourceOccasions.map((o, i) => [o.id, i]));
  const completedMap = new Map<string, OccasionResult>();

  // When running a subset with --only, preserve existing results in latest.json and merge by id.
  if (opts.only) {
    try {
      const existing = JSON.parse(readFileSync(outPath, 'utf8')) as Partial<EvalResultsFile>;
      if (Array.isArray(existing?.results)) {
        for (const r of existing.results) {
          if (r && typeof r.id === 'string') {
            completedMap.set(r.id, r);
          }
        }
      }
    } catch {
      // No existing results file yet; start fresh.
    }
  }

  const runAt = nowFn().toISOString();
  const gitCommit = gitCommitFn();

  const buildPayload = (): EvalResultsFile => {
    const ordered = [...completedMap.values()].sort(
      (a, b) => (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    const payload: EvalResultsFile = {
      version: 1,
      run_at: runAt,
      git_commit: gitCommit,
      results: ordered,
    };
    if (rateLimited) payload.stopped_reason = 'rate_limited';
    return payload;
  };

  let writeLock: Promise<void> = Promise.resolve();
  const saveProgress = (): Promise<void> => {
    const next = writeLock.then(() => {
      writeJsonAtomic(outPath, buildPayload());
    });
    writeLock = next.catch(() => undefined);
    return next;
  };

  let nextIdx = 0;
  let doneCount = 0;

  async function runOne(occ: EvalOccasion): Promise<void> {
    const brief: Brief = {
      gender: occ.gender,
      occasion: occ.occasion,
      budget_usd: occ.budget_usd,
    };
    const record: OccasionResult = {
      id: occ.id,
      gender: occ.gender,
      occasion: occ.occasion,
      budget_usd: occ.budget_usd,
      source: occ.source,
    };

    if (!opts.skipPipeline) {
      const t0 = performance.now();
      try {
        await ledgerTracker.start(occ.id);
        let built: BuildResult;
        let measuredUsd = 0;
        try {
          built = await buildLiveFn(brief);
        } finally {
          measuredUsd = await ledgerTracker.finish(occ.id);
        }
        if (built.outfits.length === 0 && built.problems.some((p) => p.startsWith('plan failed:'))) {
          record.pipeline = {
            ...failedSide(built.problems[0], built.timing.total_ms),
            usd: round6(measuredUsd),
            usd_source: measuredUsd > 0 ? 'ledger' : 'estimate',
          };
        } else {
          const critiques = await critiqueAllFn(built.outfits, brief, { timeoutMs: CRITIC_TIMEOUT_MS });
          const useFallback = measuredUsd === 0 && built.outfits.length > 0;
          const usdSource: SideResult['usd_source'] = measuredUsd > 0 ? 'ledger' : 'estimate';
          const usd = useFallback ? PIPELINE_FALLBACK_USD : measuredUsd;
          record.pipeline = evaluateSide(
            built.outfits,
            critiques,
            brief,
            { first_ms: built.timing.first_outfit_ms, total_ms: built.timing.total_ms },
            { usd, usd_source: usdSource },
          );
        }
      } catch (err) {
        record.pipeline = failedSide(err, Math.round(performance.now() - t0));
      }
    }

    if (!opts.skipBaseline) {
      const t0 = performance.now();
      try {
        const base = await baselineBuildFn(brief);
        const critiques = await critiqueAllFn(base.outfits, brief, { timeoutMs: CRITIC_TIMEOUT_MS });
        record.baseline = evaluateSide(
          base.outfits,
          critiques,
          brief,
          { first_ms: base.first_ms, total_ms: base.ms },
          { usd: base.usd, usd_source: 'tokens' },
        );
      } catch (err) {
        record.baseline = failedSide(err, Math.round(performance.now() - t0));
      }
    }

    completedMap.set(occ.id, record);
    await saveProgress();
    doneCount += 1;
    log(
      `[${doneCount}/${selected.length}] ${occ.id} | ${formatSideLine('pipeline', record.pipeline)} | ${formatSideLine('baseline', record.baseline)}`,
    );
  }

  async function worker(): Promise<void> {
    while (nextIdx < selected.length) {
      if (rateLimited) return;
      const idx = nextIdx++;
      await runOne(selected[idx]);
    }
  }

  if (selected.length === 0) {
    await saveProgress();
  } else {
    const workers = Array.from({ length: Math.min(concurrency, selected.length) }, () => worker());
    await Promise.all(workers);
    if (rateLimited) {
      await saveProgress();
      log('STOPPED: rate_limited');
    }
  }

  return buildPayload();
}

async function main(): Promise<void> {
  // Suppress buildLive's fire-and-forget background critic; eval/run.ts grades both sides explicitly.
  process.env.ALICE_CRITIC = 'off';

  const args = parseRunArgs(process.argv.slice(2));
  const payload = await runEval({
    only: args.only,
    skipBaseline: args.skipBaseline,
    skipPipeline: args.skipPipeline,
  });

  if (payload.results.length === 0) {
    console.error('No matching non-empty occasions found.');
    process.exitCode = 1;
    return;
  }
  if (payload.stopped_reason === 'rate_limited') {
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
