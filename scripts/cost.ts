import fs from 'node:fs';
import { ledgerPath, ledgerTotal } from '../src/ledger.ts';

function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function printTable(title: string, rows: Array<[string, number, number]>): void {
  console.log(title);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  const nameWidth = Math.max(12, ...rows.map(([name]) => name.length));
  console.log(`  ${'Name'.padEnd(nameWidth)}  ${'Calls'.padStart(6)}  ${'USD'.padStart(10)}`);
  console.log(`  ${'-'.repeat(nameWidth)}  ${'-'.repeat(6)}  ${'-'.repeat(10)}`);
  for (const [name, calls, usd] of rows) {
    console.log(
      `  ${name.padEnd(nameWidth)}  ${String(calls).padStart(6)}  ${formatUsd(usd).padStart(10)}`,
    );
  }
}

async function aggregateByJob(): Promise<Record<string, { usd: number; calls: number }>> {
  const byJob: Record<string, { usd: number; calls: number }> = {};
  let raw: string;
  try {
    raw = await fs.promises.readFile(ledgerPath(), 'utf8');
  } catch {
    return byJob;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as { job?: unknown; usd?: unknown };
      const job = typeof row.job === 'string' && row.job.length > 0 ? row.job : 'unknown';
      const usd = typeof row.usd === 'number' && Number.isFinite(row.usd) ? row.usd : 0;
      const bucket = byJob[job] ?? { usd: 0, calls: 0 };
      bucket.usd += usd;
      bucket.calls += 1;
      byJob[job] = bucket;
    } catch {
      // ignore malformed lines
    }
  }
  return byJob;
}

async function main(): Promise<void> {
  const [total, byJob] = await Promise.all([ledgerTotal(), aggregateByJob()]);

  const modelRows = Object.entries(total.by_model)
    .sort((a, b) => b[1].usd - a[1].usd)
    .map(([model, stats]): [string, number, number] => [model, stats.calls, stats.usd]);

  const jobRows = Object.entries(byJob)
    .sort((a, b) => b[1].usd - a[1].usd)
    .map(([job, stats]): [string, number, number] => [job, stats.calls, stats.usd]);

  printTable('By model:', modelRows);
  console.log('');
  printTable('By job:', jobRows);
  console.log('');
  console.log(`Grand total: ${total.calls} calls, ${formatUsd(total.usd)}`);
}

await main();
