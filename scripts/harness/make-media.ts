import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { REPO_ROOT, tryonDir } from '../../src/media/pure.ts';

export interface ScriptLine {
  silenceSec: number;
  text: string;
}

export const TTS_MODEL = 'gemini-3.8-flash-tts';
export const TTS_VOICE = 'Puck';
export const TTS_SAMPLE_RATE = 24_000;
export const CHROMIUM_AUDIO_RATE = 48_000;
export const CHROMIUM_AUDIO_CHANNELS = 1;

export const SHOPPER_SCRIPT: readonly ScriptLine[] = [
  { silenceSec: 12, text: "Hi Alice, I'm Sam." },
  {
    silenceSec: 14,
    text: "I'm shopping menswear. It's for a rooftop birthday dinner this Saturday in New York, and my budget is three hundred dollars.",
  },
  { silenceSec: 45, text: 'I like the second one.' },
  { silenceSec: 30, text: 'Show me what it looks like on me.' },
  { silenceSec: 35, text: 'Swap the shoes for brown boots.' },
  { silenceSec: 30, text: 'Tell me more about those boots.' },
  { silenceSec: 25, text: 'Large in tops, size eleven shoes, bag it.' },
  { silenceSec: 25, text: 'A thirty four waist.' },
  { silenceSec: 20, text: "That's it, thanks Alice." },
];

export const HARNESS_DIR = path.join(REPO_ROOT, 'data', 'harness');
export const SHOPPER_WAV_PATH = path.join(HARNESS_DIR, 'shopper.wav');
export const SHOPPER_Y4M_PATH = path.join(HARNESS_DIR, 'shopper.y4m');

const RATE_LIMIT_DELAYS_MS = [2000, 5000, 10000];

/**
 * Resolves the main repository root when running inside a git worktree so shared
 * untracked assets (.env.local, data/tryon, data/logs) can be found as fallbacks.
 */
export function resolveMainRepoRoot(): string | null {
  const dotGit = path.join(REPO_ROOT, '.git');
  try {
    const stat = fs.statSync(dotGit);
    if (!stat.isFile()) return null;
    const raw = fs.readFileSync(dotGit, 'utf8').trim();
    const match = raw.match(/^gitdir:\s*(.+)$/i);
    if (!match?.[1]) return null;
    const gitDir = path.resolve(REPO_ROOT, match[1].trim());
    const idx = gitDir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
    if (idx === -1) return null;
    return gitDir.slice(0, idx);
  } catch {
    return null;
  }
}

function loadEnvIfNeeded(): void {
  if (process.env.GOOGLE_API_KEY) return;
  const mainRoot = resolveMainRepoRoot();
  const candidates = [
    path.join(REPO_ROOT, '.env.local'),
    '.env.local',
    ...(mainRoot ? [path.join(mainRoot, '.env.local')] : []),
  ];
  for (const candidate of candidates) {
    try {
      process.loadEnvFile(candidate);
      if (process.env.GOOGLE_API_KEY) return;
    } catch {
      // Env file may not exist in this location.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  const e = err as { status?: number; code?: number | string; message?: string } | null;
  if (e?.status === 429 || e?.status === 503 || e?.code === 429 || e?.code === 503) {
    return true;
  }
  const msg = String(e?.message ?? err ?? '');
  return /\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|rate.?limit/i.test(msg);
}

function runFfmpeg(args: string[], input?: Buffer): Buffer {
  const res = spawnSync('ffmpeg', args, {
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`ffmpeg failed to start: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const stderr = (res.stderr ?? Buffer.alloc(0)).toString('utf8').trim();
    throw new Error(`ffmpeg exited ${res.status}: ${stderr.slice(-500)}`);
  }
  return res.stdout ?? Buffer.alloc(0);
}

function parseSampleRateFromMime(mimeType: string): number {
  const match = mimeType.match(/rate=(\d+)/i);
  if (match?.[1]) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return TTS_SAMPLE_RATE;
}

/**
 * Normalizes a TTS audio chunk into raw 24 kHz mono signed 16-bit little-endian PCM.
 */
function normalizeTo24kMonoPcm(rawData: Buffer, mimeType: string): Buffer {
  const isRiffWav = rawData.length >= 12 && rawData.subarray(0, 4).toString('ascii') === 'RIFF';
  const lowerMime = mimeType.toLowerCase();

  if (!isRiffWav && (lowerMime.includes('audio/l16') || lowerMime.includes('audio/pcm') || !lowerMime)) {
    const rate = parseSampleRateFromMime(mimeType);
    if (rate === TTS_SAMPLE_RATE) {
      return rawData;
    }
    return runFfmpeg(
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        's16le',
        '-ar',
        String(rate),
        '-ac',
        '1',
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ar',
        String(TTS_SAMPLE_RATE),
        '-ac',
        '1',
        'pipe:1',
      ],
      rawData,
    );
  }

  return runFfmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ar',
      String(TTS_SAMPLE_RATE),
      '-ac',
      '1',
      'pipe:1',
    ],
    rawData,
  );
}

/**
 * Encodes signed 16-bit little-endian mono PCM into a canonical 44-byte RIFF/WAVE buffer.
 */
export function buildPcmWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Reads the playback duration in seconds of a PCM WAV file by parsing its fmt and data chunks.
 */
export function getWavDurationSeconds(wavPath: string): number {
  const buf = fs.readFileSync(wavPath);
  if (buf.length < 44 || buf.subarray(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error(`Not a valid WAV file: ${wavPath}`);
  }
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.subarray(offset, offset + 4).toString('ascii');
    const size = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (id === 'fmt ' && bodyStart + 12 <= buf.length) {
      byteRate = buf.readUInt32LE(bodyStart + 8);
    } else if (id === 'data') {
      dataSize = size;
    }
    offset = bodyStart + size + (size % 2);
  }

  if (byteRate <= 0 || dataSize <= 0) {
    throw new Error(`Could not determine WAV duration from ${wavPath}`);
  }
  return dataSize / byteRate;
}

async function synthesizeLine(ai: GoogleGenAI, text: string): Promise<Buffer> {
  let retryAttempt = 0;
  let normalRetriesLeft = 1;

  while (true) {
    try {
      const response = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ role: 'user', parts: [{ text }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: TTS_VOICE },
            },
          },
        },
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const audioParts = parts.filter(
        (p) => p.inlineData && typeof p.inlineData.data === 'string' && p.inlineData.data.length > 0,
      );

      if (audioParts.length === 0) {
        throw new Error(`TTS model ${TTS_MODEL} returned no audio data`);
      }

      const pcmChunks = audioParts.map((p) => {
        const buf = Buffer.from(p.inlineData!.data!, 'base64');
        return normalizeTo24kMonoPcm(buf, p.inlineData!.mimeType ?? '');
      });
      return Buffer.concat(pcmChunks);
    } catch (err) {
      if (isRetryableError(err) && retryAttempt < RATE_LIMIT_DELAYS_MS.length) {
        const delayMs = RATE_LIMIT_DELAYS_MS[retryAttempt++]!;
        console.warn(`[harness:media] transient TTS error, retrying in ${delayMs}ms...`);
        await sleep(delayMs);
        continue;
      }
      if (normalRetriesLeft > 0) {
        normalRetriesLeft -= 1;
        console.warn('[harness:media] TTS request failed, retrying once...');
        await sleep(1000);
        continue;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

async function generateShopperAudio(outPath: string, script: readonly ScriptLine[]): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is required to synthesize shopper audio.');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: 'v1beta' },
  });
  const pcmSegments: Buffer[] = [];
  const bytesPerSecond24k = TTS_SAMPLE_RATE * 2;

  for (let i = 0; i < script.length; i++) {
    const line = script[i]!;
    if (line.silenceSec > 0) {
      pcmSegments.push(Buffer.alloc(Math.round(line.silenceSec * bytesPerSecond24k)));
    }
    const t0 = Date.now();
    const pcm = await synthesizeLine(ai, line.text);
    const clipSec = (pcm.length / bytesPerSecond24k).toFixed(2);
    console.log(
      `[harness:media] line ${i + 1}/${script.length} (+${line.silenceSec}s silence, ${clipSec}s speech, ${Date.now() - t0}ms): "${line.text}"`,
    );
    pcmSegments.push(pcm);
  }

  const wav24k = buildPcmWav(Buffer.concat(pcmSegments), TTS_SAMPLE_RATE, 1);
  const tmp24kPath = path.join(path.dirname(outPath), `.shopper-24k-${process.pid}.wav`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(tmp24kPath, wav24k);

  try {
    // Convert to canonical 48 kHz 16-bit mono PCM WAV for Chromium fake audio capture.
    runFfmpeg([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      tmp24kPath,
      '-ar',
      String(CHROMIUM_AUDIO_RATE),
      '-ac',
      String(CHROMIUM_AUDIO_CHANNELS),
      '-c:a',
      'pcm_s16le',
      '-map_metadata',
      '-1',
      '-fflags',
      '+bitexact',
      outPath,
    ]);
  } finally {
    fs.rmSync(tmp24kPath, { force: true });
  }

  const totalSec = getWavDurationSeconds(outPath);
  console.log(
    `[harness:media] wrote ${outPath} (${CHROMIUM_AUDIO_RATE} Hz mono s16le, ${totalSec.toFixed(1)}s)`,
  );
}

function findTestShopperImage(): string | null {
  const dirs = [tryonDir()];
  const mainRoot = resolveMainRepoRoot();
  if (mainRoot && !process.env.ALICE_TRYON_DIR) {
    dirs.push(path.join(mainRoot, 'data', 'tryon'));
  }
  for (const dir of dirs) {
    for (const name of ['test-shopper-men.jpg', 'test-shopper-women.jpg']) {
      const candidate = path.join(dir, name);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && stat.size > 0) {
          return candidate;
        }
      } catch {
        // Candidate does not exist.
      }
    }
  }
  return null;
}

function generateShopperVideo(outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const imagePath = findTestShopperImage();

  if (imagePath) {
    runFfmpeg([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-framerate',
      '10',
      '-i',
      imagePath,
      '-t',
      '10',
      '-vf',
      'scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2:color=0xe8e8e8,setsar=1',
      '-pix_fmt',
      'yuv420p',
      '-f',
      'yuv4mpegpipe',
      outPath,
    ]);
    console.log(`[harness:media] wrote ${outPath} from ${imagePath} (640x480, 10 fps, 10s)`);
    return;
  }

  runFfmpeg([
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'smptebars=size=640x480:rate=10',
    '-t',
    '10',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'yuv4mpegpipe',
    outPath,
  ]);
  console.log(
    `[harness:media] note: no generated test shopper image found in ${tryonDir()}; wrote synthetic colour-bars video to ${outPath} (640x480, 10 fps, 10s)`,
  );
}

function hasNonEmptyFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log(
      [
        'Usage: npm run harness:media [-- --force]',
        '',
        'Generates shopper audio (data/harness/shopper.wav) via Gemini TTS and',
        'shopper video (data/harness/shopper.y4m) via ffmpeg.',
        'Skips existing files unless --force is passed.',
      ].join('\n'),
    );
    return;
  }

  const force = args.has('--force');
  loadEnvIfNeeded();

  if (force || !hasNonEmptyFile(SHOPPER_WAV_PATH)) {
    await generateShopperAudio(SHOPPER_WAV_PATH, SHOPPER_SCRIPT);
  } else {
    const dur = getWavDurationSeconds(SHOPPER_WAV_PATH);
    console.log(`[harness:media] skipping ${SHOPPER_WAV_PATH} (exists, ${dur.toFixed(1)}s; use --force to regenerate)`);
  }

  if (force || !hasNonEmptyFile(SHOPPER_Y4M_PATH)) {
    generateShopperVideo(SHOPPER_Y4M_PATH);
  } else {
    console.log(`[harness:media] skipping ${SHOPPER_Y4M_PATH} (exists; use --force to regenerate)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[harness:media] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
