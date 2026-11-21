// One-page evaluation report generator: reads eval/results/latest.json and writes
// eval/results/RESULTS.md and eval/results/README-snippet.md.
// Usage: node eval/report.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalResultsFile, OccasionResult, SideResult } from './run.ts';

export const DEFAULT_INPUT_PATH = path.resolve(import.meta.dirname, 'results', 'latest.json');
export const DEFAULT_REPORT_PATH = path.resolve(import.meta.dirname, 'results', 'RESULTS.md');
export const DEFAULT_SNIPPET_PATH = path.resolve(import.meta.dirname, 'results', 'README-snippet.md');

export const WHAT_WE_CHANGED = [
  '1. Hard dress-code rules in the plan and pick prompts (formality was the most common failure).',
  '2. The Decisions API gate drops the weakest of 4 planned looks.',
  '3. Hard filters for wedding white and novelty ties at formal events, after the critic caught them.',
  '4. The ready-made library is graded by Argon, serves only looks scoring 6+, and rebuilds weak occasions keeping the best 5.',
] as const;

export interface SideSummary {
  count: number;
  completed: number;
  avg_score: number | null;
  presentable_sets: number;
  weakest_set_avg: number | null;
  weakest_set_id: string | null;
  dress_code_breaks: number;
  over_budget_outfits: number;
  median_first_ms: number | null;
  p90_first_ms: number | null;
  median_total_ms: number | null;
  avg_usd: number | null;
  used_estimate_usd: boolean;
}

export interface WeakSetEntry {
  id: string;
  avg: number;
  min: number;
  issue: string;
}

export interface ReportOutput {
  pipeline: SideSummary;
  baseline: SideSummary;
  messyPipeline: SideSummary;
  messyBaseline: SideSummary;
  weakest: WeakSetEntry[];
  resultsMd: string;
  readmeSnippetMd: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function isSetPresentable(side: SideResult | undefined): boolean {
  if (!side || side.error) return false;
  if (typeof side.presentable_count === 'number') return side.presentable_count >= 2;
  return Boolean(side.presentable);
}

export function summarizeSide(results: OccasionResult[], key: 'pipeline' | 'baseline'): SideSummary {
  const entries = results
    .map((r) => ({ id: r.id, side: r[key] }))
    .filter((x): x is { id: string; side: SideResult } => Boolean(x.side));

  const completed = entries.filter((x) => !x.side.error);
  const validScores = completed.flatMap((x) => x.side.scores.filter((s) => s > 0));
  const avgScore = validScores.length > 0
    ? round2(validScores.reduce((s, n) => s + n, 0) / validScores.length)
    : completed.length > 0
      ? round2(completed.reduce((s, x) => s + x.side.avg, 0) / completed.length)
      : null;

  const presentableSets = entries.filter((x) => isSetPresentable(x.side)).length;

  let weakestAvg: number | null = null;
  let weakestId: string | null = null;
  for (const x of completed) {
    if (weakestAvg === null || x.side.avg < weakestAvg) {
      weakestAvg = x.side.avg;
      weakestId = x.id;
    }
  }

  const dressCodeBreaks = completed.reduce((s, x) => s + (x.side.dress_code_hits?.length ?? 0), 0);
  const overBudget = completed.reduce((s, x) => s + (x.side.over_budget ?? 0), 0);
  const firstMs = completed.map((x) => x.side.first_ms).filter((n) => Number.isFinite(n) && n > 0);
  const totalMs = completed.map((x) => x.side.total_ms).filter((n) => Number.isFinite(n) && n > 0);
  const usds = completed.map((x) => x.side.usd).filter((n) => Number.isFinite(n));

  return {
    count: entries.length,
    completed: completed.length,
    avg_score: avgScore,
    presentable_sets: presentableSets,
    weakest_set_avg: weakestAvg,
    weakest_set_id: weakestId,
    dress_code_breaks: dressCodeBreaks,
    over_budget_outfits: overBudget,
    median_first_ms: median(firstMs),
    p90_first_ms: percentile(firstMs, 90),
    median_total_ms: median(totalMs),
    avg_usd: usds.length > 0 ? usds.reduce((s, n) => s + n, 0) / usds.length : null,
    used_estimate_usd: completed.some((x) => x.side.usd_source === 'estimate'),
  };
}

function shortIssue(issue: string): string {
  const clean = issue.replace(/\s+/g, ' ').trim();
  if (clean.length <= 72) return clean;
  return `${clean.slice(0, 69).trimEnd()}...`;
}

export function findWeakestPipelineSets(results: OccasionResult[], limit = 5): WeakSetEntry[] {
  const withPipeline = results.filter((r): r is OccasionResult & { pipeline: SideResult } => Boolean(r.pipeline));
  const sorted = [...withPipeline].sort((a, b) => {
    const aErr = a.pipeline.error ? -1 : a.pipeline.avg;
    const bErr = b.pipeline.error ? -1 : b.pipeline.avg;
    if (aErr !== bErr) return aErr - bErr;
    return a.pipeline.min - b.pipeline.min;
  });

  return sorted.slice(0, limit).map((r) => {
    const p = r.pipeline;
    const topIssue = p.error
      ? `error: ${shortIssue(p.error)}`
      : p.issues[0]
        ? shortIssue(p.issues[0])
        : 'no major issue flagged';
    return {
      id: r.id,
      avg: p.avg,
      min: p.min,
      issue: topIssue,
    };
  });
}

function fmtScore(n: number | null): string {
  return n === null ? '—' : `${n.toFixed(2)} / 10`;
}

function fmtWeakest(avg: number | null, id: string | null): string {
  if (avg === null) return '—';
  return id ? `${avg.toFixed(2)} (${id})` : avg.toFixed(2);
}

function fmtSec(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`;
}

function fmtUsd(usd: number | null, estimated = false): string {
  if (usd === null) return '—';
  const base = usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`;
  return estimated ? `${base} (est.)` : base;
}

function fmtPresentable(s: SideSummary): string {
  if (s.count === 0) return '—';
  return `${s.presentable_sets} / ${s.count}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function occasionRow(r: OccasionResult): string {
  const pAvg = r.pipeline ? (r.pipeline.error ? 'ERR' : r.pipeline.avg.toFixed(2)) : '—';
  const pPres = r.pipeline ? (isSetPresentable(r.pipeline) ? 'yes' : 'no') : '—';
  const bAvg = r.baseline ? (r.baseline.error ? 'ERR' : r.baseline.avg.toFixed(2)) : '—';
  const bPres = r.baseline ? (isSetPresentable(r.baseline) ? 'yes' : 'no') : '—';
  return `| ${r.id} | ${pAvg} | ${pPres} | ${bAvg} | ${bPres} |`;
}

export function buildReport(data: EvalResultsFile): ReportOutput {
  const primaryResults = data.results.filter((r) => r.source !== 'messy');
  const messyResults = data.results.filter((r) => r.source === 'messy');

  const pipeline = summarizeSide(primaryResults, 'pipeline');
  const baseline = summarizeSide(primaryResults, 'baseline');
  const messyPipeline = summarizeSide(messyResults, 'pipeline');
  const messyBaseline = summarizeSide(messyResults, 'baseline');
  const weakest = findWeakestPipelineSets(primaryResults, 5);

  const md: string[] = [
    '# Outfits Eval: Live Pipeline vs. One-Call Baseline',
    '',
    `Run: \`${data.run_at}\` · Commit: \`${data.git_commit}\` · Test kit + demo: ${primaryResults.length} occasions (spec bar: 15 of 20 presentable sets; a set is presentable when >= 2 of 3 outfits pass Argon).`,
    '',
    '## Headline (test kit + demo)',
    '',
    '| Metric | Live Pipeline | One-Call Baseline |',
    '| --- | ---: | ---: |',
    `| Average Argon score | ${fmtScore(pipeline.avg_score)} | ${fmtScore(baseline.avg_score)} |`,
    `| Presentable sets (bar: 15/20) | ${fmtPresentable(pipeline)} | ${fmtPresentable(baseline)} |`,
    `| Weakest set (min) | ${fmtWeakest(pipeline.weakest_set_avg, pipeline.weakest_set_id)} | ${fmtWeakest(baseline.weakest_set_avg, baseline.weakest_set_id)} |`,
    `| Dress-code breaks | ${pipeline.count ? pipeline.dress_code_breaks : '—'} | ${baseline.count ? baseline.dress_code_breaks : '—'} |`,
    `| Over-budget outfits | ${pipeline.count ? pipeline.over_budget_outfits : '—'} | ${baseline.count ? baseline.over_budget_outfits : '—'} |`,
    `| Median time to first outfit | ${fmtSec(pipeline.median_first_ms)} | ${fmtSec(baseline.median_first_ms)} |`,
    `| p90 time to first outfit | ${fmtSec(pipeline.p90_first_ms)} | ${fmtSec(baseline.p90_first_ms)} |`,
    `| Median total time | ${fmtSec(pipeline.median_total_ms)} | ${fmtSec(baseline.median_total_ms)} |`,
    `| Average cost per build | ${fmtUsd(pipeline.avg_usd, pipeline.used_estimate_usd)} | ${fmtUsd(baseline.avg_usd)} |`,
    '',
  ];

  if (pipeline.used_estimate_usd) {
    md.push('_Note: one or more pipeline builds fell back to the $0.08/build cost estimate._', '');
  }

  md.push(
    '## Per Occasion (test kit + demo)',
    '',
    '| Occasion | Pipeline avg | Pipeline presentable | Baseline avg | Baseline presentable |',
    '| --- | ---: | :---: | ---: | :---: |',
  );

  for (const r of primaryResults) {
    md.push(occasionRow(r));
  }

  if (messyResults.length > 0) {
    md.push(
      '',
      '## Team-written messy briefs',
      '',
      `Separate stress-test set (${messyResults.length} team-written messy briefs, excluded from the headline above): pipeline ${fmtScore(messyPipeline.avg_score)} (${fmtPresentable(messyPipeline)} presentable) vs. baseline ${fmtScore(messyBaseline.avg_score)} (${fmtPresentable(messyBaseline)} presentable).`,
      '',
      '| Occasion | Pipeline avg | Pipeline presentable | Baseline avg | Baseline presentable |',
      '| --- | ---: | :---: | ---: | :---: |',
    );
    for (const r of messyResults) {
      md.push(occasionRow(r));
    }
  }

  md.push('', '## Where it breaks', '');
  if (weakest.length === 0) {
    md.push('- No pipeline results recorded.');
  } else {
    for (const w of weakest) {
      md.push(`- **${w.id}** (${w.avg.toFixed(2)} avg, min ${w.min}): ${w.issue}`);
    }
  }

  md.push('', '## What we changed', '');
  for (const line of WHAT_WE_CHANGED) {
    md.push(line);
  }
  md.push('');

  const pScoreWord = pipeline.avg_score !== null ? `${pipeline.avg_score.toFixed(1)}/10` : 'n/a';
  const bScoreWord = baseline.avg_score !== null ? `${baseline.avg_score.toFixed(1)}/10` : 'n/a';
  const nSets = Math.max(pipeline.count, baseline.count, primaryResults.length);

  const snippetLines = [
    '## Outfit Eval',
    `Across ${nSets} test-kit + demo occasions graded by the Argon critic, the live outfit pipeline averages ${pScoreWord} with ${pipeline.presentable_sets}/${pipeline.count} client-presentable sets, compared to ${bScoreWord} and ${baseline.presentable_sets}/${baseline.count} for a one-call Flash Lite baseline.`,
    `The pipeline had ${plural(pipeline.dress_code_breaks, 'dress-code break', 'dress-code breaks')} and ${plural(pipeline.over_budget_outfits, 'over-budget outfit', 'over-budget outfits')} (baseline: ${plural(baseline.dress_code_breaks, 'dress-code break', 'dress-code breaks')}, ${baseline.over_budget_outfits} over-budget).`,
    `Median time to first outfit is ${fmtSec(pipeline.median_first_ms)} (p90 ${fmtSec(pipeline.p90_first_ms)}), median total build time is ${fmtSec(pipeline.median_total_ms)}, and average cost is ${fmtUsd(pipeline.avg_usd, pipeline.used_estimate_usd)} per build.`,
  ];
  if (messyResults.length > 0) {
    const mpScore = messyPipeline.avg_score !== null ? `${messyPipeline.avg_score.toFixed(1)}/10` : 'n/a';
    const mbScore = messyBaseline.avg_score !== null ? `${messyBaseline.avg_score.toFixed(1)}/10` : 'n/a';
    snippetLines.push(
      `On ${messyResults.length} separate team-written messy briefs, the pipeline averages ${mpScore} (${messyPipeline.presentable_sets}/${messyPipeline.count} presentable) vs. ${mbScore} (${messyBaseline.presentable_sets}/${messyBaseline.count}) for baseline.`,
    );
  }
  snippetLines.push(
    'See `eval/results/RESULTS.md` for the full breakdown and weakest occasions.',
    'Run it yourself:',
    '`node --env-file-if-exists=.env.local eval/run.ts && node eval/report.ts`',
  );

  return {
    pipeline,
    baseline,
    messyPipeline,
    messyBaseline,
    weakest,
    resultsMd: md.join('\n'),
    readmeSnippetMd: `${snippetLines.join('\n')}\n`,
  };
}

export function generateReports(
  inputPath = DEFAULT_INPUT_PATH,
  reportPath = DEFAULT_REPORT_PATH,
  snippetPath = DEFAULT_SNIPPET_PATH,
): ReportOutput {
  const raw = readFileSync(inputPath, 'utf8');
  const data = JSON.parse(raw) as EvalResultsFile;
  const output = buildReport(data);

  mkdirSync(path.dirname(reportPath), { recursive: true });
  mkdirSync(path.dirname(snippetPath), { recursive: true });
  writeFileSync(reportPath, output.resultsMd, 'utf8');
  writeFileSync(snippetPath, output.readmeSnippetMd, 'utf8');
  return output;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = generateReports();
  console.log(`Wrote ${DEFAULT_REPORT_PATH}`);
  console.log(`Wrote ${DEFAULT_SNIPPET_PATH}\n`);
  console.log(out.readmeSnippetMd.trimEnd());
}
