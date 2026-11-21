import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { recordCost } from '../ledger.ts';

export const CAPSULE_AGENT_ID = 'antigravity-preview-09-2026';
export const CAPSULE_MAX_TOKENS = '150000';
export const CAPSULE_REMOTE_TOOLS_DIR = '/workspace/capsule';

export const CAPSULE_ALLOWLIST = [
  { domain: 'mcp.shop.com' },
  { domain: 'pypi.org' },
  { domain: 'files.pythonhosted.org' },
] as const;

export interface CapsuleEnvironmentState {
  environment_id: string;
  last_interaction_id: string | null;
  tools_version: string;
  created_at: string;
}

export interface CapsuleApiClient {
  environments: {
    create: (params: Record<string, unknown>) => Promise<{ id?: string; [k: string]: unknown }>;
    get: (id: string, params?: Record<string, unknown>) => Promise<{ id?: string; state?: string; [k: string]: unknown }>;
    files: {
      upload: (params: {
        environment: string;
        path: string;
        file: Uint8Array | Buffer | Blob | string;
        mime_type?: string;
        overwrite?: boolean;
      }) => Promise<unknown>;
      list?: (params: { environment: string; path?: string }) => Promise<unknown>;
      download?: (params: { environment: string; path: string }) => Promise<ArrayBuffer | Uint8Array>;
    };
  };
  interactions: {
    create: (params: Record<string, unknown>) => Promise<any>;
  };
}

export interface EnsureEnvironmentOptions {
  client?: CapsuleApiClient;
  statePath?: string;
  toolsDir?: string;
  setupModel?: string;
  forceRebuild?: boolean;
}

export interface EnsureEnvironmentResult {
  state: CapsuleEnvironmentState;
  rebuilt: boolean;
  ms: number;
  upload_mode?: 'sdk_upload' | 'setup_interaction';
}

export interface WarmCapsuleResult {
  ok: boolean;
  environment_id: string | null;
  rebuilt: boolean;
  ms: number;
  error?: string;
}

export interface WarmCapsuleHandle {
  started: boolean;
  ready: Promise<WarmCapsuleResult>;
}

const DEFAULT_TOOLS_DIR = path.resolve(import.meta.dirname, 'tools');
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
let inFlightDefaultWarm: Promise<EnsureEnvironmentResult> | null = null;

export function defaultEnvironmentStatePath(): string {
  return path.join(REPO_ROOT, 'data', 'capsule', 'environment.json');
}

export function loadEnvLocalOnce(): void {
  if (process.env.GOOGLE_API_KEY) return;
  try {
    process.loadEnvFile(path.join(REPO_ROOT, '.env.local'));
  } catch {
    // .env.local optional
  }
}

export function createCapsuleClient(): CapsuleApiClient {
  loadEnvLocalOnce();
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GOOGLE_API_KEY in environment or .env.local');
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
  }) as unknown as CapsuleApiClient;
}

export function listLocalToolFiles(toolsDir: string = DEFAULT_TOOLS_DIR): Array<{ name: string; fullPath: string; content: Buffer }> {
  const entries = fs
    .readdirSync(toolsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.endsWith('.pyc'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  return entries.map((name) => {
    const fullPath = path.join(toolsDir, name);
    return { name, fullPath, content: fs.readFileSync(fullPath) };
  });
}

export function computeToolsVersion(toolsDir: string = DEFAULT_TOOLS_DIR): string {
  const hash = crypto.createHash('sha256');
  for (const file of listLocalToolFiles(toolsDir)) {
    hash.update(file.name);
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function readEnvironmentState(statePath: string = defaultEnvironmentStatePath()): CapsuleEnvironmentState | null {
  try {
    if (!fs.existsSync(statePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<CapsuleEnvironmentState>;
    if (
      typeof parsed.environment_id === 'string' &&
      parsed.environment_id.length > 0 &&
      typeof parsed.tools_version === 'string' &&
      parsed.tools_version.length > 0
    ) {
      return {
        environment_id: parsed.environment_id,
        last_interaction_id:
          typeof parsed.last_interaction_id === 'string' ? parsed.last_interaction_id : null,
        tools_version: parsed.tools_version,
        created_at: typeof parsed.created_at === 'string' ? parsed.created_at : new Date().toISOString(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeEnvironmentState(
  state: CapsuleEnvironmentState,
  statePath: string = defaultEnvironmentStatePath(),
): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function updateEnvironmentInteraction(
  interactionId: string,
  statePath: string = defaultEnvironmentStatePath(),
): void {
  try {
    const existing = readEnvironmentState(statePath);
    if (!existing) return;
    writeEnvironmentState(
      { ...existing, last_interaction_id: interactionId },
      statePath,
    );
  } catch {
    // Never throw on state bookmark update
  }
}

async function isEnvironmentAlive(client: CapsuleApiClient, envId: string): Promise<boolean> {
  try {
    const env = await client.environments.get(envId);
    if (!env || !env.id) return false;
    const stateStr = String(env.state ?? '').toUpperCase();
    if (stateStr.includes('DELETED') || stateStr.includes('FAILED') || stateStr.includes('EXPIRED')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function recordInteractionCost(model: string, res: any, elapsedMs: number): void {
  const usage = res?.usage ?? {};
  const inputTokens = Number(usage.total_input_tokens ?? 0);
  const outputTokens = Number(usage.total_output_tokens ?? 0);
  const thoughtTokens = Number(usage.total_thought_tokens ?? 0);
  if (inputTokens > 0 || outputTokens > 0 || thoughtTokens > 0) {
    void recordCost({
      model,
      job: 'capsule',
      input_tokens: inputTokens,
      output_tokens: outputTokens + thoughtTokens,
      ms: elapsedMs,
    });
  }
}

async function setupViaUpload(
  client: CapsuleApiClient,
  files: Array<{ name: string; content: Buffer }>,
  setupModel: string,
): Promise<{ environment_id: string; last_interaction_id: string | null }> {
  const created = await client.environments.create({
    network: { allowlist: [...CAPSULE_ALLOWLIST] },
  });
  const envId = created?.id;
  if (!envId) {
    throw new Error('environments.create did not return an environment id');
  }

  for (const f of files) {
    await client.environments.files.upload({
      environment: envId,
      path: `capsule/${f.name}`,
      file: new Uint8Array(f.content.buffer, f.content.byteOffset, f.content.byteLength),
      mime_type: f.name.endsWith('.md') ? 'text/markdown' : 'text/plain',
      overwrite: true,
    });
  }

  // Run one short setup interaction to ensure /workspace/capsule path + install ortools + run self-test
  const t0 = Date.now();
  const res = await client.interactions.create({
    agent: CAPSULE_AGENT_ID,
    environment: envId,
    agent_config: {
      type: 'antigravity',
      model: setupModel,
      max_total_tokens: '40000',
    },
    input: `Run ONE shell command to finalize the capsule sandbox and reply with ONLY "READY":
\`\`\`bash
set -e
mkdir -p /workspace/capsule /workspace/capsule_state
if [ ! -f /workspace/capsule/capsule.py ] && [ -f ./capsule/capsule.py ]; then cp -r ./capsule/* /workspace/capsule/; fi
if [ ! -f /workspace/capsule/capsule.py ] && [ -f /capsule/capsule.py ]; then cp -r /capsule/* /workspace/capsule/; fi
python3 -c "import ortools" 2>/dev/null || pip install --quiet ortools
python3 /workspace/capsule/capsule.py self-test
\`\`\``,
  });
  recordInteractionCost(setupModel, res, Date.now() - t0);

  return {
    environment_id: res?.environment_id || envId,
    last_interaction_id: typeof res?.id === 'string' ? res.id : null,
  };
}

async function setupViaInteractionFallback(
  client: CapsuleApiClient,
  files: Array<{ name: string; content: Buffer }>,
  setupModel: string,
): Promise<{ environment_id: string; last_interaction_id: string | null }> {
  const writeBlocks = files
    .map((f) => {
      const b64 = f.content.toString('base64');
      return `python3 -c "import base64,pathlib; pathlib.Path('/workspace/capsule/${f.name}').write_bytes(base64.b64decode('${b64}'))"`;
    })
    .join('\n');

  const t0 = Date.now();
  const res = await client.interactions.create({
    agent: CAPSULE_AGENT_ID,
    environment: {
      type: 'remote',
      network: { allowlist: [...CAPSULE_ALLOWLIST] },
    },
    agent_config: {
      type: 'antigravity',
      model: setupModel,
      max_total_tokens: '60000',
    },
    input: `Run ONE shell command to install the capsule tools and OR-Tools, then reply with ONLY "READY":
\`\`\`bash
set -e
mkdir -p /workspace/capsule /workspace/capsule_state
${writeBlocks}
python3 -c "import ortools" 2>/dev/null || pip install --quiet ortools
python3 /workspace/capsule/capsule.py self-test
\`\`\``,
  });
  recordInteractionCost(setupModel, res, Date.now() - t0);

  const envId = res?.environment_id;
  if (!envId) {
    throw new Error('Setup interaction did not return an environment_id');
  }

  return {
    environment_id: envId,
    last_interaction_id: typeof res?.id === 'string' ? res.id : null,
  };
}

export async function ensureEnvironment(
  opts: EnsureEnvironmentOptions = {},
): Promise<EnsureEnvironmentResult> {
  const isDefaultCall = !opts.client && !opts.statePath && !opts.toolsDir && !opts.forceRebuild;
  if (isDefaultCall && inFlightDefaultWarm) {
    return inFlightDefaultWarm;
  }

  const run = async (): Promise<EnsureEnvironmentResult> => {
    const t0 = Date.now();
    const toolsDir = opts.toolsDir ?? DEFAULT_TOOLS_DIR;
    const statePath = opts.statePath ?? defaultEnvironmentStatePath();
    const setupModel = opts.setupModel ?? process.env.ALICE_MODEL_CAPSULE ?? 'gemini-4-hydrogen';
    const client = opts.client ?? createCapsuleClient();
    const toolsVersion = computeToolsVersion(toolsDir);

    if (!opts.forceRebuild) {
      const existing = readEnvironmentState(statePath);
      if (existing && existing.tools_version === toolsVersion) {
        const alive = await isEnvironmentAlive(client, existing.environment_id);
        if (alive) {
          return {
            state: existing,
            rebuilt: false,
            ms: Math.max(0, Date.now() - t0),
          };
        }
      }
    }

    const files = listLocalToolFiles(toolsDir);
    let created: { environment_id: string; last_interaction_id: string | null };
    let uploadMode: 'sdk_upload' | 'setup_interaction' = 'sdk_upload';

    try {
      created = await setupViaUpload(client, files, setupModel);
    } catch {
      uploadMode = 'setup_interaction';
      created = await setupViaInteractionFallback(client, files, setupModel);
    }

    const state: CapsuleEnvironmentState = {
      environment_id: created.environment_id,
      last_interaction_id: created.last_interaction_id,
      tools_version: toolsVersion,
      created_at: new Date().toISOString(),
    };
    writeEnvironmentState(state, statePath);

    return {
      state,
      rebuilt: true,
      ms: Math.max(0, Date.now() - t0),
      upload_mode: uploadMode,
    };
  };

  if (isDefaultCall) {
    const p = run().finally(() => {
      if (inFlightDefaultWarm === p) {
        inFlightDefaultWarm = null;
      }
    });
    inFlightDefaultWarm = p;
    return p;
  }

  return run();
}

/**
 * Safe to call at worker start: returns immediately without throwing and warms
 * the remote capsule sandbox in the background.
 */
export function warmCapsule(opts: EnsureEnvironmentOptions = {}): WarmCapsuleHandle {
  const t0 = Date.now();
  const ready: Promise<WarmCapsuleResult> = Promise.resolve()
    .then(() => ensureEnvironment(opts))
    .then((res) => ({
      ok: true,
      environment_id: res.state.environment_id,
      rebuilt: res.rebuilt,
      ms: Math.max(0, Date.now() - t0),
    }))
    .catch((err) => ({
      ok: false,
      environment_id: null,
      rebuilt: false,
      ms: Math.max(0, Date.now() - t0),
      error: err instanceof Error ? err.message : String(err),
    }));

  // Prevent unhandled rejection when caller ignores the returned handle
  ready.catch(() => {});

  return { started: true, ready };
}
