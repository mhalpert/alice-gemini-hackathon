import fs from 'node:fs';
import path from 'node:path';

export interface CostEntry {
  model: string;
  job: string;
  input_tokens?: number;
  output_tokens?: number;
  images?: number;
  usd?: number;
  ms?: number;
}

export interface LedgerTotal {
  usd: number;
  calls: number;
  by_model: Record<string, { usd: number; calls: number }>;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const pendingWrites = new Set<Promise<void>>();

export function ledgerDir(): string {
  return process.env.ALICE_LEDGER_DIR
    ? path.resolve(process.env.ALICE_LEDGER_DIR)
    : path.join(REPO_ROOT, 'data');
}

export function ledgerPath(): string {
  return path.join(ledgerDir(), 'cost-ledger.jsonl');
}

export function estimateCostUsd(entry: {
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  images?: number;
  usd?: number;
}): number {
  if (typeof entry.usd === 'number' && Number.isFinite(entry.usd)) {
    return entry.usd;
  }
  const model = entry.model.replace(/^models\//, '');
  const inTok = typeof entry.input_tokens === 'number' && Number.isFinite(entry.input_tokens) ? entry.input_tokens : 0;
  const outTok =
    typeof entry.output_tokens === 'number' && Number.isFinite(entry.output_tokens) ? entry.output_tokens : 0;
  const imgs = typeof entry.images === 'number' && Number.isFinite(entry.images) ? entry.images : 0;

  switch (model) {
    case 'gemini-3.5-flash-lite':
      return (inTok * 0.3 + outTok * 2.5) / 1_000_000;
    case 'gemini-4-hydrogen':
    case 'gemini-4-argon':
    case 'gemini-4-carbon':
      return (inTok * 1.5 + outTok * 7.5) / 1_000_000;
    case 'gemini-4-neon':
      return (inTok * 3.0 + outTok * 15.0) / 1_000_000;
    case 'gemini-decision-1':
      return (inTok * 0.1) / 1_000_000;
    case 'gemini-nano-banana-2.1':
      return imgs * 0.05;
    case 'gemini-omni-1.2-flash':
    case 'gemini-omni-1.1-flash':
    case 'gemini-omni-flash-preview':
      // Estimated ~$0.60 per video clip
      return (entry.images ?? 1) * 0.6;
    default:
      return 0;
  }
}

export function recordCost(entry: CostEntry): Promise<void> {
  const dir = ledgerDir();
  const file = path.join(dir, 'cost-ledger.jsonl');
  const usd = estimateCostUsd(entry);
  const record = {
    t: new Date().toISOString(),
    pid: process.pid,
    ...entry,
    usd,
  };
  const line = `${JSON.stringify(record)}\n`;

  const p = (async () => {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.appendFile(file, line, 'utf8');
    } catch {
      // Never throw from cost recording.
    }
  })();

  pendingWrites.add(p);
  void p.finally(() => {
    pendingWrites.delete(p);
  });
  return p;
}

export async function ledgerTotal(): Promise<LedgerTotal> {
  if (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }

  const out: LedgerTotal = { usd: 0, calls: 0, by_model: {} };
  let raw: string;
  try {
    raw = await fs.promises.readFile(ledgerPath(), 'utf8');
  } catch {
    return out;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Partial<CostEntry & { usd?: number }>;
      const model = typeof row.model === 'string' && row.model.length > 0 ? row.model : 'unknown';
      const usd = typeof row.usd === 'number' && Number.isFinite(row.usd) ? row.usd : 0;
      out.usd += usd;
      out.calls += 1;
      const bucket = out.by_model[model] ?? { usd: 0, calls: 0 };
      bucket.usd += usd;
      bucket.calls += 1;
      out.by_model[model] = bucket;
    } catch {
      // Skip malformed lines.
    }
  }

  return out;
}
