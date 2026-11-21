import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { getCallLogPath, getLogDir } from '../../src/calllog.ts';
import { REPO_ROOT } from '../../src/media/pure.ts';
import { parseCallLogFile } from '../calllog.ts';
import { evaluateCallLog, formatReport, formatSec } from './evaluate.ts';
import type { EvaluationReport } from './evaluate.ts';
import {
  HARNESS_DIR,
  SHOPPER_WAV_PATH,
  SHOPPER_Y4M_PATH,
  getWavDurationSeconds,
  resolveMainRepoRoot,
} from './make-media.ts';

const DEFAULT_URL = 'http://localhost:3000';
const DEFAULT_TAIL_SEC = 20;
const SCREENSHOT_INTERVAL_MS = 8_000;
const CONNECT_TIMEOUT_MS = 25_000;
const LOG_WAIT_MS = 4_000;

interface RunOptions {
  url: string;
  runs: number;
  tailSec: number;
  audioPath: string;
  videoPath: string;
}

interface SingleRunOutcome {
  runIndex: number;
  room: string | null;
  passed: boolean;
  report: EvaluationReport | null;
  consoleErrors: string[];
  error?: string;
}

function loadEnvIfNeeded(): void {
  const mainRoot = resolveMainRepoRoot();
  const candidates = [
    path.join(REPO_ROOT, '.env.local'),
    '.env.local',
    ...(mainRoot ? [path.join(mainRoot, '.env.local')] : []),
  ];
  for (const candidate of candidates) {
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      // Env file may not exist.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage(): void {
  console.log(
    [
      'Usage: npm run harness [-- --runs N] [--url URL] [--tail SEC]',
      '',
      'Prerequisites:',
      '  1. Install Chromium for Playwright: npx playwright install chromium',
      '  2. Generate shopper audio/video:    npm run harness:media',
      '  3. Start server and agent worker:   npm start  &  npm run agent',
      '',
      'Options:',
      '  --runs N      Repeat the call N times (default: 1)',
      '  --url URL     Override call page URL (or set HARNESS_URL; default: http://localhost:3000)',
      '  --tail SEC    Seconds to stay on call after audio finishes (default: 20)',
      '  --help, -h    Show this help message',
    ].join('\n'),
  );
}

function parseCliArgs(argv: string[]): RunOptions | null {
  let runs = 1;
  let url = (process.env.HARNESS_URL || DEFAULT_URL).trim();
  let tailSec = DEFAULT_TAIL_SEC;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      printUsage();
      return null;
    }
    if (arg === '--runs' && argv[i + 1]) {
      runs = Number(argv[++i]);
      if (!Number.isInteger(runs) || runs < 1) {
        throw new Error(`--runs must be a positive integer, got "${argv[i]}"`);
      }
    } else if (arg === '--url' && argv[i + 1]) {
      url = argv[++i]!.trim();
    } else if (arg === '--tail' && argv[i + 1]) {
      tailSec = Number(argv[++i]);
      if (!Number.isFinite(tailSec) || tailSec < 0) {
        throw new Error(`--tail must be a non-negative number, got "${argv[i]}"`);
      }
    }
  }

  return {
    url: url.replace(/\/+$/, ''),
    runs,
    tailSec,
    audioPath: path.resolve(SHOPPER_WAV_PATH),
    videoPath: path.resolve(SHOPPER_Y4M_PATH),
  };
}

async function checkServerReachable(baseUrl: string): Promise<void> {
  const healthUrl = `${baseUrl}/healthz`;
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      throw new Error(`GET ${healthUrl} returned HTTP ${res.status}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Call server is not reachable at ${baseUrl} (${reason}). Start it with "npm start" and "npm run agent" (or set HARNESS_URL).`,
    );
  }
}

function checkMediaFiles(audioPath: string, videoPath: string): number {
  if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) {
    throw new Error(`Missing shopper audio at ${audioPath}. Run "npm run harness:media" first.`);
  }
  if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size === 0) {
    throw new Error(`Missing shopper video at ${videoPath}. Run "npm run harness:media" first.`);
  }
  return getWavDurationSeconds(audioPath);
}

function candidateLogDirs(): string[] {
  const dirs = [getLogDir()];
  const mainRoot = resolveMainRepoRoot();
  if (mainRoot && !process.env.ALICE_LOG_DIR) {
    const mainLogs = path.join(mainRoot, 'data', 'logs');
    if (!dirs.includes(mainLogs)) dirs.push(mainLogs);
  }
  return dirs;
}

function findNewestLogSince(sinceMs: number): string | null {
  let newestRoom: string | null = null;
  let newestMtime = sinceMs - 1;
  for (const dir of candidateLogDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const stat = fs.statSync(path.join(dir, file));
      if (stat.mtimeMs >= newestMtime) {
        newestMtime = stat.mtimeMs;
        newestRoom = file.replace(/\.jsonl$/, '');
      }
    }
  }
  return newestRoom;
}

async function waitForLogFile(room: string, timeoutMs: number): Promise<string | null> {
  const primary = getCallLogPath(room);
  const fileName = path.basename(primary);
  const candidates = candidateLogDirs().map((dir) => path.join(dir, fileName));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
        return candidate;
      }
    }
    await sleep(250);
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function runSingleCall(
  runIndex: number,
  totalRuns: number,
  opts: RunOptions,
  audioDurationSec: number,
): Promise<SingleRunOutcome> {
  const consoleErrors: string[] = [];
  let roomName: string | null = null;
  const startedAtMs = Date.now();

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${opts.audioPath}%noloop`,
        `--use-file-for-fake-video-capture=${opts.videoPath}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not launch Playwright Chromium (${msg}). Run "npx playwright install chromium" and retry.`,
    );
  }

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['microphone', 'camera'],
    });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(`pageerror: ${err.message}`);
    });
    page.on('response', async (res) => {
      try {
        const u = new URL(res.url());
        if (u.pathname === '/api/token' && res.status() === 200) {
          const json = (await res.json()) as { room?: unknown; roomName?: unknown };
          const found =
            typeof json.room === 'string'
              ? json.room
              : typeof json.roomName === 'string'
                ? json.roomName
                : null;
          if (found) roomName = found;
        }
      } catch {
        // Ignore non-JSON or closed response bodies.
      }
    });

    console.log(`[harness] run ${runIndex}/${totalRuns}: opening ${opts.url}`);
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });

    const talkBtn = page.locator('.call-start__talk');
    await talkBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await talkBtn.click();

    const passcodeInput = page.locator('.call-start__passcode');
    const liveBody = page.locator('body.call-live');

    const outcome = await Promise.race([
      liveBody.waitFor({ state: 'attached', timeout: CONNECT_TIMEOUT_MS }).then(() => 'live' as const),
      passcodeInput
        .waitFor({ state: 'visible', timeout: CONNECT_TIMEOUT_MS })
        .then(() => 'passcode' as const),
    ]);

    if (outcome === 'passcode') {
      const passcode = process.env.ALICE_PASSCODE;
      if (!passcode) {
        throw new Error('Server requested a passcode, but ALICE_PASSCODE is not set.');
      }
      await passcodeInput.fill(passcode);
      await talkBtn.click();
      await liveBody.waitFor({ state: 'attached', timeout: CONNECT_TIMEOUT_MS });
    }

    if (!roomName) {
      await sleep(500);
      roomName = findNewestLogSince(startedAtMs) ?? `unknown-${Date.now()}`;
    }

    const callDir = path.join(HARNESS_DIR, roomName);
    fs.mkdirSync(callDir, { recursive: true });
    const pageLogPath = path.join(callDir, 'page.log');
    const totalWaitSec = Math.ceil(audioDurationSec + opts.tailSec);
    const liveStartedMs = Date.now();
    const endAtMs = liveStartedMs + totalWaitSec * 1000;

    console.log(
      `[harness] run ${runIndex}/${totalRuns}: live in room ${roomName}; capturing every 8s for ${totalWaitSec}s (audio ${audioDurationSec.toFixed(1)}s + ${opts.tailSec}s)`,
    );

    let shotIndex = 0;
    const captureFrame = async (): Promise<void> => {
      shotIndex += 1;
      const elapsedSec = ((Date.now() - liveStartedMs) / 1000).toFixed(1);
      const shotFile = path.join(callDir, `shot-${String(shotIndex).padStart(3, '0')}.png`);
      try {
        await page.screenshot({ path: shotFile });
        const visibleText = await page.evaluate(() => document.body?.innerText ?? '');
        const entry = `\n--- shot-${String(shotIndex).padStart(3, '0')} (+${elapsedSec}s, ${new Date().toISOString()}) ---\n${visibleText.trim()}\n`;
        fs.appendFileSync(pageLogPath, entry, 'utf8');
      } catch (err) {
        consoleErrors.push(
          `capture error at +${elapsedSec}s: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    await captureFrame();
    while (Date.now() < endAtMs) {
      const remaining = endAtMs - Date.now();
      const waitMs = Math.min(SCREENSHOT_INTERVAL_MS, Math.max(0, remaining));
      if (waitMs > 0) await sleep(waitMs);
      if (Date.now() <= endAtMs + 500) {
        await captureFrame();
      }
    }

    // End the call cleanly via the End control (or the page's call.end hook).
    try {
      const endBtn = page.locator('button[data-act="end"]');
      if (await endBtn.isVisible()) {
        await endBtn.click();
      } else {
        const toggle = page.locator('.controls-toggle');
        if (await toggle.isVisible()) {
          await toggle.click();
        }
        if (await endBtn.isVisible()) {
          await endBtn.click();
        } else {
          await page.evaluate(async () => {
            const w = window as unknown as { alice?: { call?: { end?: () => Promise<void> } } };
            await w.alice?.call?.end?.();
          });
        }
      }
    } catch {
      // Closing the browser disconnects LiveKit even if the button was unavailable.
    }

    await sleep(2_500);
    if (consoleErrors.length > 0) {
      fs.writeFileSync(path.join(callDir, 'console-errors.log'), `${consoleErrors.join('\n')}\n`, 'utf8');
    }
    await context.close();
  } finally {
    await browser.close();
  }

  const logPath = roomName ? await waitForLogFile(roomName, LOG_WAIT_MS) : null;
  if (!logPath) {
    const expectedPath = roomName ? getCallLogPath(roomName) : getLogDir();
    const errMsg = `Call log not found at ${expectedPath}. If the server/worker runs from another directory, set ALICE_LOG_DIR to its data/logs path.`;
    console.error(`[harness] ${errMsg}`);
    return {
      runIndex,
      room: roomName,
      passed: false,
      report: null,
      consoleErrors,
      error: errMsg,
    };
  }

  const events = parseCallLogFile(logPath);
  const report = evaluateCallLog(events);
  console.log(formatReport(roomName!, report, consoleErrors));

  return {
    runIndex,
    room: roomName,
    passed: report.passed,
    report,
    consoleErrors,
  };
}

function formatRunOneLiner(outcome: SingleRunOutcome, totalRuns: number): string {
  const room = outcome.room ?? 'unknown';
  if (!outcome.report) {
    return `Run ${outcome.runIndex}/${totalRuns} [${room}]: FAIL (${outcome.error ?? 'no report'})`;
  }
  const failedNames = outcome.report.checks.filter((c) => !c.passed).map((c) => c.name);
  const status = outcome.passed ? 'PASS' : `FAIL (${failedNames.join(', ')})`;
  const t = outcome.report.timings;
  return `Run ${outcome.runIndex}/${totalRuns} [${room}]: ${status} | 1st=${formatSec(t.occasionToFirstLookSec)} all3=${formatSec(t.occasionToAllThreeSec)} tryon=${formatSec(t.occasionToTryOnReadySec)} pick2word=${formatSec(t.pickToFirstWordSec)} | warnings=${outcome.report.warnings.length} console_err=${outcome.consoleErrors.length}`;
}

async function main(): Promise<void> {
  loadEnvIfNeeded();
  const opts = parseCliArgs(process.argv.slice(2));
  if (!opts) return;

  await checkServerReachable(opts.url);
  const audioDurationSec = checkMediaFiles(opts.audioPath, opts.videoPath);

  const outcomes: SingleRunOutcome[] = [];
  for (let i = 1; i <= opts.runs; i++) {
    const outcome = await runSingleCall(i, opts.runs, opts, audioDurationSec);
    outcomes.push(outcome);
  }

  if (opts.runs > 1) {
    console.log('\n=== Multi-Run Summary ===');
    for (const outcome of outcomes) {
      console.log(formatRunOneLiner(outcome, opts.runs));
    }
  }

  const allPassed = outcomes.every((o) => o.passed);
  process.exit(allPassed ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[harness] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
