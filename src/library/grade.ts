// Grades the ready-made outfit library (sets.json) with the Argon stylist critic
// plus hard dress-code rules, writing results incrementally to grades.json next to sets.json.
// Also supports `--improve` to rebuild and pool failing sets into sets.json + grades.json.
// Usage:
//   node --env-file-if-exists=.env.local src/library/grade.ts [--only key1,key2] [--gender men|women] [--regrade]
//   node --env-file-if-exists=.env.local src/library/grade.ts --improve [--only key1,key2] [--gender men|women] [--max-attempts 3]
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Brief, BuildResult, Gender, Outfit } from '../types.ts';
import { buildLive as defaultBuildLive } from '../brain/build.ts';
import { critiqueAll as defaultCritiqueAll, type Critique, type CritiqueOptions } from '../brain/critic.ts';
import { breaksDressCode } from '../brain/words.ts';
import { setCallLogSink, setCallRoom } from '../store/log.ts';
import type { LibraryFile, LibrarySet } from './index.ts';

export interface OutfitGrade {
  name: string;
  score: number;
  presentable: boolean;
  issues: string[];
  weak_piece: { slot: string; reason: string; ask: string } | null;
}

export interface SetGrade {
  graded_at: string;
  set_built_at: number | string;
  outfits: OutfitGrade[];
  min: number;
  avg: number;
  presentable_count: number;
  pass: boolean;
}

export interface GradesFile {
  version: 1;
  graded_at: string;
  grades: Record<string, SetGrade>;
}

export interface ParsedArgs {
  only: Set<string> | null;
  genders: Gender[];
  regrade: boolean;
  improve: boolean;
  maxAttempts: number;
}

export interface GradeDeps {
  critiqueAll: (outfits: Outfit[], brief: Brief, opts?: CritiqueOptions) => Promise<Critique[]>;
  buildLive: (brief: Brief) => Promise<BuildResult>;
  log: (line: string) => void;
  now: () => Date;
}

export interface GradedOutfit {
  outfit: Outfit;
  grade: OutfitGrade;
}

export interface GradeRunSummary {
  total: number;
  graded: number;
  skipped: number;
  passed: number;
  failed: number;
  errored: number;
  failedByGender: Record<Gender, string[]>;
  lines: string[];
}

export interface ImproveRunSummary {
  total: number;
  improved: number;
  skipped: number;
  passed: number;
  failed: number;
  attempts: number;
  estimatedSpend: number;
  stopReason: 'rate_limited' | 'time fence' | 'spend cap' | null;
  lines: string[];
}

const CONCURRENCY = 4;
const IMPROVE_CONCURRENCY = 2;
const CRITIC_TIMEOUT_MS = 60000;
const COST_PER_IMPROVE_ATTEMPT_USD = 0.12;
const DEFAULT_IMPROVE_MAX_PAID_USD = 15;
const DEFAULT_IMPROVE_STOP_AT_NY = '15:50';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_SETS_PATH = path.resolve(import.meta.dirname, 'sets.json');

let writeSeq = 0;

let moduleDeps: GradeDeps = {
  critiqueAll: defaultCritiqueAll,
  buildLive: defaultBuildLive,
  log: (line: string) => console.log(line),
  now: () => new Date(),
};

export function _setDeps(overrides: Partial<GradeDeps> | null): void {
  if (!overrides) {
    moduleDeps = {
      critiqueAll: defaultCritiqueAll,
      buildLive: defaultBuildLive,
      log: (line: string) => console.log(line),
      now: () => new Date(),
    };
    return;
  }
  moduleDeps = {
    critiqueAll: overrides.critiqueAll ?? moduleDeps.critiqueAll,
    buildLive: overrides.buildLive ?? moduleDeps.buildLive,
    log: overrides.log ?? moduleDeps.log,
    now: overrides.now ?? moduleDeps.now,
  };
}

export function parseArgs(argv: string[]): ParsedArgs {
  let only: Set<string> | null = null;
  let genders: Gender[] = ['men', 'women'];
  let regrade = false;
  let improve = false;
  let maxAttempts = DEFAULT_MAX_ATTEMPTS;

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
    } else if (arg === '--regrade') {
      regrade = true;
    } else if (arg === '--improve') {
      improve = true;
    } else if (arg === '--max-attempts' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid --max-attempts: ${n}`);
      maxAttempts = n;
    } else if (arg.startsWith('--max-attempts=')) {
      const n = Number(arg.slice('--max-attempts='.length));
      if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid --max-attempts: ${n}`);
      maxAttempts = n;
    }
  }
  return { only, genders, regrade, improve, maxAttempts };
}

export function resolveSetsPath(): string {
  const override = process.env.ALICE_LIBRARY_FILE;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  return DEFAULT_SETS_PATH;
}

export function resolveGradesPath(setsFilePath: string): string {
  return path.join(path.dirname(setsFilePath), 'grades.json');
}

export function gradeKey(key: string, gender: Gender): string {
  return `${key}|${gender}`;
}

export function sameOutfitNames(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((name, i) => name === sb[i]);
}

export function variantIdKey(outfit: Outfit): string {
  return outfit.pieces
    .map((p) => p.item.variant_id || p.item.id)
    .sort()
    .join('|');
}

function hasDressCodeHit(entry: GradedOutfit, brief?: { occasion: string; gender: string }): boolean {
  if (brief && entry.outfit.pieces.some((p) => breaksDressCode(p.item, p.slot, brief))) {
    return true;
  }
  return entry.grade.issues.some((i) => i.startsWith('dress code:'));
}

function compareGradedOutfits(
  a: GradedOutfit,
  b: GradedOutfit,
  brief?: { occasion: string; gender: string },
): number {
  const aHit = hasDressCodeHit(a, brief);
  const bHit = hasDressCodeHit(b, brief);
  if (aHit !== bHit) return aHit ? 1 : -1;
  if (b.grade.score !== a.grade.score) return b.grade.score - a.grade.score;
  if (a.grade.issues.length !== b.grade.issues.length) {
    return a.grade.issues.length - b.grade.issues.length;
  }
  if (a.grade.presentable !== b.grade.presentable) {
    return a.grade.presentable ? -1 : 1;
  }
  return 0;
}

export function poolBestOutfits(
  existing: GradedOutfit[],
  incoming: GradedOutfit[],
  limit = 3,
  brief?: { occasion: string; gender: string },
): GradedOutfit[] {
  const combined = [...existing, ...incoming].sort((a, b) => compareGradedOutfits(a, b, brief));
  const seen = new Set<string>();
  const kept: GradedOutfit[] = [];

  for (const entry of combined) {
    const key = variantIdKey(entry.outfit);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
    if (kept.length >= limit) break;
  }

  return kept.map((entry, idx) => ({
    outfit: { ...structuredClone(entry.outfit), number: idx + 1 },
    grade: { ...entry.grade, issues: [...entry.grade.issues] },
  }));
}

function readLibraryFile(filePath: string): LibraryFile {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<LibraryFile>;
  return {
    version: typeof parsed?.version === 'number' ? parsed.version : 1,
    built_at: typeof parsed?.built_at === 'string' ? parsed.built_at : '',
    sets: Array.isArray(parsed?.sets) ? parsed.sets : [],
  };
}

function readExistingGrades(filePath: string): Record<string, SetGrade> {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<GradesFile>;
    if (parsed?.grades && typeof parsed.grades === 'object' && !Array.isArray(parsed.grades)) {
      return { ...parsed.grades };
    }
    return {};
  } catch {
    return {};
  }
}

function writeGradesAtomic(filePath: string, grades: Record<string, SetGrade>): void {
  const payload: GradesFile = {
    version: 1,
    graded_at: new Date().toISOString(),
    grades,
  };
  writeSeq += 1;
  const tmpPath = `${filePath}.${process.pid}.${writeSeq}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function mergeAndWriteGrade(filePath: string, id: string, grade: SetGrade): void {
  const existing = readExistingGrades(filePath);
  existing[id] = grade;
  writeGradesAtomic(filePath, existing);
}

function mergeAndWriteSet(filePath: string, entry: LibrarySet): void {
  const existing = readLibraryFile(filePath);
  const nextSets = existing.sets.filter((s) => !(s.key === entry.key && s.gender === entry.gender));
  nextSets.push(entry);

  const payload: LibraryFile = {
    version: 1,
    built_at: new Date().toISOString(),
    sets: nextSets,
  };

  writeSeq += 1;
  const tmpPath = `${filePath}.${process.pid}.${writeSeq}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function needsGrading(set: LibrarySet, existing: SetGrade | undefined, regrade: boolean): boolean {
  if (regrade) return true;
  if (!existing || !Array.isArray(existing.outfits)) return true;
  if (!sameOutfitNames(set.outfits.map((o) => o.name), existing.outfits.map((o) => o.name))) {
    return true;
  }
  if (
    typeof set.built_ms === 'number' &&
    typeof existing.set_built_at === 'number' &&
    existing.set_built_at !== set.built_ms
  ) {
    return true;
  }
  return false;
}

function isCriticError(critique: Critique): boolean {
  return critique.score === 0 && Boolean(critique.error);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function buildSetGrade(outfitGrades: OutfitGrade[], setBuiltAt: number | string): SetGrade {
  const presentableScores = outfitGrades.filter((o) => o.presentable).map((o) => o.score);
  const presentableCount = presentableScores.length;
  const presentableMin = presentableScores.length > 0 ? Math.min(...presentableScores) : 0;

  const allScores = outfitGrades.map((o) => o.score);
  const min = allScores.length > 0 ? Math.min(...allScores) : 0;
  const avg = allScores.length > 0
    ? round2(allScores.reduce((s, n) => s + n, 0) / allScores.length)
    : 0;
  const pass = presentableCount >= 2 && presentableMin >= 5;

  return {
    graded_at: new Date().toISOString(),
    set_built_at: setBuiltAt,
    outfits: outfitGrades,
    min,
    avg,
    presentable_count: presentableCount,
    pass,
  };
}

function gradeOutfitsFromCritiques(
  outfits: Outfit[],
  critiques: Critique[],
  brief: Brief,
): { graded: GradedOutfit[]; hadError: boolean; scores: (number | 'err')[]; issues: string[] } {
  const graded: GradedOutfit[] = [];
  const scores: (number | 'err')[] = [];
  const allIssues: string[] = [];
  let hadError = false;

  for (let i = 0; i < outfits.length; i++) {
    const outfit = outfits[i];
    const critique = critiques[i];
    if (!critique || isCriticError(critique)) {
      hadError = true;
      scores.push('err');
      allIssues.push(`critic error: ${critique?.error ?? 'missing critique'}`);
      continue;
    }

    const dressCodeIssues: string[] = [];
    for (const piece of outfit.pieces) {
      if (breaksDressCode(piece.item, piece.slot, brief)) {
        dressCodeIssues.push(`dress code: ${piece.item.title} (${piece.slot})`);
      }
    }

    const issues = [...critique.issues, ...dressCodeIssues];
    const presentable = critique.presentable && dressCodeIssues.length === 0;
    scores.push(critique.score);
    allIssues.push(...issues);

    graded.push({
      outfit,
      grade: {
        name: outfit.name,
        score: critique.score,
        presentable,
        issues,
        weak_piece: critique.weak_piece,
      },
    });
  }

  return { graded, hadError, scores, issues: allIssues };
}

export function evaluateSetCritiques(
  set: LibrarySet,
  critiques: Critique[],
  fileBuiltAt: string,
): { grade: SetGrade | null; hadError: boolean; scores: (number | 'err')[]; issues: string[] } {
  const brief: Brief = {
    gender: set.gender,
    occasion: set.occasion,
    budget_usd: set.budget_usd,
  };

  const evaluated = gradeOutfitsFromCritiques(set.outfits, critiques, brief);
  if (evaluated.hadError) {
    return { grade: null, hadError: true, scores: evaluated.scores, issues: evaluated.issues };
  }

  const setBuiltAt = typeof set.built_ms === 'number' ? set.built_ms : fileBuiltAt;
  const grade = buildSetGrade(
    evaluated.graded.map((g) => g.grade),
    setBuiltAt,
  );

  return {
    grade,
    hadError: false,
    scores: evaluated.scores,
    issues: evaluated.issues,
  };
}

function formatIssues(issues: string[]): string {
  return issues.length > 0 ? issues.join('; ') : 'none';
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

function pairExistingGradedOutfits(set: LibrarySet, existing: SetGrade): GradedOutfit[] {
  const byName = new Map<string, OutfitGrade[]>();
  for (const og of existing.outfits) {
    const list = byName.get(og.name) ?? [];
    list.push(og);
    byName.set(og.name, list);
  }
  const paired: GradedOutfit[] = [];
  for (const outfit of set.outfits) {
    const og = byName.get(outfit.name)?.shift();
    if (og) {
      paired.push({ outfit: structuredClone(outfit), grade: { ...og, issues: [...og.issues] } });
    }
  }
  return paired;
}

export async function runGrading(
  args: Pick<ParsedArgs, 'only' | 'genders' | 'regrade'>,
  deps: Partial<GradeDeps> = {},
): Promise<GradeRunSummary> {
  const critiqueAllFn = deps.critiqueAll ?? moduleDeps.critiqueAll;
  const logFn = deps.log ?? moduleDeps.log;
  const lines: string[] = [];
  const emit = (line: string) => {
    lines.push(line);
    logFn(line);
  };

  const setsFilePath = resolveSetsPath();
  const gradesFilePath = resolveGradesPath(setsFilePath);
  const library = readLibraryFile(setsFilePath);
  const grades = readExistingGrades(gradesFilePath);

  const selected = library.sets.filter((s) => {
    if (!args.genders.includes(s.gender)) return false;
    if (args.only && !args.only.has(s.key)) return false;
    return true;
  });

  const toGrade: LibrarySet[] = [];
  let skipped = 0;
  let passed = 0;
  let failed = 0;
  let errored = 0;
  const failedByGender: Record<Gender, string[]> = { men: [], women: [] };

  for (const set of selected) {
    const id = gradeKey(set.key, set.gender);
    const existing = grades[id];
    if (!needsGrading(set, existing, args.regrade)) {
      skipped += 1;
      if (existing.pass) {
        passed += 1;
      } else {
        failed += 1;
        failedByGender[set.gender].push(set.key);
      }
      const scores = `[${existing.outfits.map((o) => o.score).join(',')}]`;
      const issues = existing.outfits.flatMap((o) => o.issues);
      emit(`${set.key} ${set.gender} ${existing.pass ? 'pass' : 'FAIL'} scores=${scores} issues: ${formatIssues(issues)} (cached)`);
      continue;
    }
    toGrade.push(set);
  }

  let nextIdx = 0;
  let graded = 0;

  async function gradeOne(set: LibrarySet): Promise<void> {
    const brief: Brief = {
      gender: set.gender,
      occasion: set.occasion,
      budget_usd: set.budget_usd,
    };

    const critiques = await critiqueAllFn(set.outfits, brief, { timeoutMs: CRITIC_TIMEOUT_MS });
    const result = evaluateSetCritiques(set, critiques, library.built_at);
    const scoresText = `[${result.scores.join(',')}]`;

    if (result.hadError || !result.grade) {
      errored += 1;
      emit(`${set.key} ${set.gender} ERROR scores=${scoresText} issues: ${formatIssues(result.issues)}`);
      return;
    }

    const id = gradeKey(set.key, set.gender);
    grades[id] = result.grade;
    mergeAndWriteGrade(gradesFilePath, id, result.grade);
    graded += 1;

    if (result.grade.pass) {
      passed += 1;
    } else {
      failed += 1;
      failedByGender[set.gender].push(set.key);
    }

    const status = result.grade.pass ? 'pass' : 'FAIL';
    emit(`${set.key} ${set.gender} ${status} scores=${scoresText} issues: ${formatIssues(result.issues)}`);
  }

  async function worker(): Promise<void> {
    while (nextIdx < toGrade.length) {
      const idx = nextIdx++;
      await gradeOne(toGrade[idx]);
    }
  }

  const workerCount = Math.min(CONCURRENCY, toGrade.length);
  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  const total = selected.length;
  const extras: string[] = [];
  if (errored > 0) extras.push(`${errored} error`);
  if (skipped > 0) extras.push(`${skipped} cached`);
  const extraText = extras.length > 0 ? `, ${extras.join(', ')}` : '';
  emit(`Totals: ${total} sets (${passed} pass, ${failed} FAIL${extraText})`);

  for (const gender of ['men', 'women'] as const) {
    const keys = [...new Set(failedByGender[gender])];
    failedByGender[gender] = keys;
    if (keys.length > 0) {
      emit(`node --env-file-if-exists=.env.local src/library/build.ts --rebuild --only ${keys.join(',')} --gender ${gender}`);
    }
  }

  return {
    total,
    graded,
    skipped,
    passed,
    failed,
    errored,
    failedByGender,
    lines,
  };
}

export async function runImprove(
  args: Pick<ParsedArgs, 'only' | 'genders' | 'maxAttempts'>,
  deps: Partial<GradeDeps> = {},
): Promise<ImproveRunSummary> {
  const critiqueAllFn = deps.critiqueAll ?? moduleDeps.critiqueAll;
  const buildLiveFn = deps.buildLive ?? moduleDeps.buildLive;
  const logFn = deps.log ?? moduleDeps.log;
  const nowFn = deps.now ?? moduleDeps.now;

  const lines: string[] = [];
  const emit = (line: string) => {
    lines.push(line);
    logFn(line);
  };

  let stopReason: 'rate_limited' | 'time fence' | 'spend cap' | null = null;
  setCallRoom('library-improve');
  setCallLogSink((_room, ev, data) => {
    if (ev === 'store_error' && data?.code === 'rate_limited') {
      stopReason = 'rate_limited';
    }
  });

  try {
    const rawMaxPaid = process.env.ALICE_LIBRARY_MAX_PAID;
    const maxPaid =
      rawMaxPaid !== undefined && rawMaxPaid.trim() !== '' && Number.isFinite(Number(rawMaxPaid))
        ? Number(rawMaxPaid)
        : DEFAULT_IMPROVE_MAX_PAID_USD;
    const stopMinutes = parseStopMinutes(process.env.ALICE_LIBRARY_STOP_AT ?? DEFAULT_IMPROVE_STOP_AT_NY);

    const setsFilePath = resolveSetsPath();
    const gradesFilePath = resolveGradesPath(setsFilePath);
    const library = readLibraryFile(setsFilePath);
    const grades = readExistingGrades(gradesFilePath);

    const selected = library.sets.filter((s) => {
      if (!args.genders.includes(s.gender)) return false;
      if (args.only && !args.only.has(s.key)) return false;
      return true;
    });

    const toImprove: LibrarySet[] = [];
    let skipped = 0;
    let passed = 0;
    let failed = 0;
    let improved = 0;
    let totalAttempts = 0;
    let estimatedSpend = 0;

    for (const set of selected) {
      const id = gradeKey(set.key, set.gender);
      const existing = grades[id];
      if (!needsGrading(set, existing, false) && existing.pass) {
        skipped += 1;
        passed += 1;
        continue;
      }
      toImprove.push(set);
    }

    function checkStopBeforeStart(): boolean {
      if (stopReason) return true;
      if (isPastNewYorkFence(stopMinutes, nowFn())) {
        stopReason = 'time fence';
        return true;
      }
      return false;
    }

    let nextIdx = 0;

    async function improveOne(set: LibrarySet): Promise<void> {
      const id = gradeKey(set.key, set.gender);
      const brief: Brief = {
        gender: set.gender,
        occasion: set.occasion,
        budget_usd: set.budget_usd,
      };

      const existing = grades[id];
      let pool: GradedOutfit[] = [];
      let beforeScores: number[] = [];
      let initiallyGradedNow = false;

      if (!needsGrading(set, existing, false)) {
        pool = pairExistingGradedOutfits(set, existing);
        beforeScores = existing.outfits.map((o) => o.score);
      } else {
        if (checkStopBeforeStart()) return;
        const initCritiques = await critiqueAllFn(set.outfits, brief, { timeoutMs: CRITIC_TIMEOUT_MS });
        const initEval = gradeOutfitsFromCritiques(set.outfits, initCritiques, brief);
        pool = initEval.graded;
        beforeScores = pool.map((p) => p.grade.score);
        if (!initEval.hadError && pool.length > 0) {
          initiallyGradedNow = true;
          const initGrade = buildSetGrade(
            pool.map((p) => p.grade),
            typeof set.built_ms === 'number' ? set.built_ms : library.built_at,
          );
          if (initGrade.pass) {
            mergeAndWriteGrade(gradesFilePath, id, initGrade);
            passed += 1;
            const afterScores = initGrade.outfits.map((o) => o.score);
            emit(`${set.key} ${set.gender} attempts=0 scores before=[${beforeScores.join(',')}] after=[${afterScores.join(',')}] pass`);
            return;
          }
        }
      }

      const setStarted = performance.now();
      let attempts = 0;
      let currentGrade = pool.length > 0
        ? buildSetGrade(
            pool.map((p) => p.grade),
            typeof set.built_ms === 'number' ? set.built_ms : library.built_at,
          )
        : null;

      for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
        if (checkStopBeforeStart()) break;
        if (estimatedSpend + COST_PER_IMPROVE_ATTEMPT_USD > maxPaid + 1e-9) {
          stopReason = 'spend cap';
          break;
        }
        estimatedSpend = round2(estimatedSpend + COST_PER_IMPROVE_ATTEMPT_USD);
        attempts += 1;
        totalAttempts += 1;

        let buildRes: BuildResult;
        try {
          buildRes = await buildLiveFn(brief);
        } catch {
          continue;
        }

        if (!Array.isArray(buildRes?.outfits) || buildRes.outfits.length === 0) {
          continue;
        }

        const critiques = await critiqueAllFn(buildRes.outfits, brief, { timeoutMs: CRITIC_TIMEOUT_MS });
        const evaluated = gradeOutfitsFromCritiques(buildRes.outfits, critiques, brief);
        if (evaluated.graded.length === 0) {
          continue;
        }

        pool = poolBestOutfits(pool, evaluated.graded, 3, brief);
        const builtMs = Math.max(1, Math.round(performance.now() - setStarted));
        currentGrade = buildSetGrade(
          pool.map((p) => p.grade),
          builtMs,
        );

        if (currentGrade.pass) {
          break;
        }
      }

      if (attempts === 0 && !initiallyGradedNow) {
        return;
      }

      if (pool.length === 0 || !currentGrade) {
        failed += 1;
        emit(`${set.key} ${set.gender} attempts=${attempts} scores before=[${beforeScores.join(',')}] after=[] FAIL`);
        return;
      }

      if (attempts > 0) {
        const improvedAt = nowFn().toISOString();
        const builtMs = Math.max(1, Math.round(performance.now() - setStarted));
        const finalOutfits = pool.map((p, idx) => ({
          ...structuredClone(p.outfit),
          number: idx + 1,
        }));
        const updatedSet: LibrarySet = {
          ...set,
          outfits: finalOutfits,
          built_ms: builtMs,
          improved_at: improvedAt,
        };
        const finalGrade = buildSetGrade(
          pool.map((p) => p.grade),
          builtMs,
        );

        mergeAndWriteSet(setsFilePath, updatedSet);
        mergeAndWriteGrade(gradesFilePath, id, finalGrade);
        improved += 1;
        currentGrade = finalGrade;
      } else if (initiallyGradedNow) {
        mergeAndWriteGrade(gradesFilePath, id, currentGrade);
      }

      if (currentGrade.pass) {
        passed += 1;
      } else {
        failed += 1;
      }

      const afterScores = currentGrade.outfits.map((o) => o.score);
      emit(
        `${set.key} ${set.gender} attempts=${attempts} scores before=[${beforeScores.join(',')}] after=[${afterScores.join(',')}] ${currentGrade.pass ? 'pass' : 'FAIL'}`,
      );
    }

    async function worker(): Promise<void> {
      while (nextIdx < toImprove.length) {
        if (checkStopBeforeStart()) return;
        const idx = nextIdx++;
        await improveOne(toImprove[idx]);
      }
    }

    const workerCount = Math.min(IMPROVE_CONCURRENCY, toImprove.length);
    if (workerCount > 0) {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }

    emit(
      `Totals: ${selected.length} sets (${passed} pass, ${failed} FAIL, ${improved} improved, ${skipped} skipped, ${totalAttempts} attempts, $${estimatedSpend.toFixed(2)} est.)`,
    );

    if (stopReason === 'rate_limited') {
      emit('STOPPED: rate_limited');
    } else if (stopReason === 'time fence') {
      emit('STOPPED: time fence');
    } else if (stopReason === 'spend cap') {
      emit(`STOPPED: spend cap ($${estimatedSpend.toFixed(2)}/$${maxPaid.toFixed(2)})`);
    }

    return {
      total: selected.length,
      improved,
      skipped,
      passed,
      failed,
      attempts: totalAttempts,
      estimatedSpend,
      stopReason,
      lines,
    };
  } finally {
    setCallLogSink(null);
    setCallRoom(null);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.improve) {
    delete process.env.ALICE_BRAIN;
    const summary = await runImprove(args);
    if (summary.stopReason === 'rate_limited') {
      process.exitCode = 2;
    }
    return;
  }
  await runGrading(args);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
