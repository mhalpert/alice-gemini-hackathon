import { critiqueAll as defaultCritiqueAll, type Critique, type CritiqueOptions } from '../brain/critic.ts';
import { breaksDressCode } from '../brain/words.ts';
import { estimateCostUsd, recordCost } from '../ledger.ts';
import { getProduct, lookup } from '../store/index.ts';
import type { LookupEntry, ProductDetail } from '../store/catalog.ts';
import { getCallRoom, logEvent } from '../store/log.ts';
import { storeNameForDomain } from '../store/stores.ts';
import type { Brief, Gender, Item, Outfit, Piece } from '../types.ts';
import {
  CAPSULE_AGENT_ID,
  CAPSULE_MAX_TOKENS,
  CAPSULE_REMOTE_TOOLS_DIR,
  createCapsuleClient,
  ensureEnvironment,
  updateEnvironmentInteraction,
  warmCapsule,
  type CapsuleApiClient,
} from './environment.ts';

export { ensureEnvironment, warmCapsule } from './environment.ts';
export type {
  CapsuleApiClient,
  CapsuleEnvironmentState,
  WarmCapsuleHandle,
  WarmCapsuleResult,
} from './environment.ts';

export const DEFAULT_CAPSULE_MODEL = 'gemini-4-hydrogen';
const CRITIC_TIMEOUT_MS = 8000;

export interface CapsuleBrief {
  gender: Gender;
  plans: string;
  sizes: Record<string, string>;
  budget_usd: number;
  owned?: string[];
  max_stores?: number;
}

export interface CapsuleStep {
  t_ms: number;
  kind: string;
  text: string;
}

export interface CapsuleStoreLayer {
  lookup: (ids: string[]) => Promise<Map<string, LookupEntry>>;
  getProduct: (id: string) => Promise<ProductDetail | null>;
}

export interface CapsuleCriticEntry {
  day: string;
  score: number;
  presentable: boolean;
  issues: string[];
}

export interface CapsuleDressCodeNote {
  day: string;
  title: string;
  reason: string;
}

export type CritiqueAllFn = (
  outfits: Outfit[],
  brief: Brief,
  opts?: CritiqueOptions,
) => Promise<Critique[]>;

export interface CapsuleOptions {
  onStep?: (s: CapsuleStep) => void;
  model?: string;
  client?: CapsuleApiClient;
  statePath?: string;
  toolsDir?: string;
  store?: CapsuleStoreLayer;
  critiqueAll?: CritiqueAllFn;
  skipCritic?: boolean;
  /** Allow callers/scripts to run even when ALICE_CAPSULE env switch is off. */
  force?: boolean;
}

export interface CapsuleCertificateCheck {
  name: string;
  ok: boolean;
  advisory?: boolean;
}

export interface CapsuleCertificate {
  all_sizes_in_stock: boolean;
  within_budget: boolean;
  checks: CapsuleCertificateCheck[];
}

export interface CapsuleResult {
  ok: boolean;
  outfits: Outfit[];
  pieces: Piece[];
  total_usd: number;
  stores: string[];
  mix_and_match_count: number;
  certificate: CapsuleCertificate;
  searched: number;
  timings: { total_ms: number; agent_ms: number; tools_ms: number };
  explanation: string;
  problems: string[];
  critic?: CapsuleCriticEntry[];
  dress_code_notes?: CapsuleDressCodeNote[];
  model?: string;
  environment_id?: string;
  interaction_id?: string;
  cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    thought_tokens: number;
    cached_tokens: number;
  };
  brief?: CapsuleBrief;
}

export interface RawPipelinePiece {
  slot?: string;
  title?: string;
  store?: string;
  store_domain?: string;
  price_usd?: number;
  url?: string;
  image?: string;
  id?: string;
  variant_id?: string;
  size_label?: string;
}

export interface RawPipelineOwned {
  id?: string;
  slot?: string;
  title?: string;
  size_label?: string;
}

export interface RawPipelineOutfit {
  day?: string;
  dress_code?: string;
  notes?: string;
  piece_ids?: string[];
  total_new_usd?: number;
}

export interface RawPipelineOutput {
  ok?: boolean;
  infeasible?: boolean;
  error?: string;
  pieces?: RawPipelinePiece[];
  owned_pieces_used?: RawPipelineOwned[];
  outfits?: RawPipelineOutfit[];
  total_usd?: number;
  stores?: string[];
  mix_and_match_count?: number;
  certificate?: {
    all_sizes_in_stock?: boolean;
    within_budget?: boolean;
    checks?: Array<string | { name?: string; ok?: boolean }>;
  };
  searched?: number;
  timings?: {
    fetch_s?: number;
    size_check_s?: number;
    solve_s?: number;
    verify_s?: number;
    total_s?: number;
  };
  explanation?: string;
}

export function isCapsuleEnabled(raw: string | undefined = process.env.ALICE_CAPSULE): boolean {
  const norm = (raw ?? '').trim().toLowerCase();
  return norm === 'on' || norm === '1' || norm === 'true';
}

export function resolveCapsuleModel(explicit?: string): string {
  return explicit?.trim() || process.env.ALICE_MODEL_CAPSULE?.trim() || DEFAULT_CAPSULE_MODEL;
}

function emptyFailure(
  t0: number,
  problems: string[],
  extra?: Partial<CapsuleResult>,
): CapsuleResult {
  return {
    ok: false,
    outfits: [],
    pieces: [],
    total_usd: 0,
    stores: [],
    mix_and_match_count: 0,
    certificate: {
      all_sizes_in_stock: false,
      within_budget: false,
      checks: [],
    },
    searched: 0,
    timings: { total_ms: Math.max(0, Date.now() - t0), agent_ms: 0, tools_ms: 0 },
    explanation: '',
    problems,
    ...extra,
  };
}

function cleanImageUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(?:width|height)$/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export function extractExplanationFromReply(rawText: string): string {
  const trimmed = (rawText ?? '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/^DONE\b[\s:.\-]*/i, '').trim();
}

export function parseAgentOutput(rawText: string): {
  pipeline: RawPipelineOutput | null;
  explanation: string;
} {
  const trimmed = (rawText ?? '').trim();
  if (!trimmed) return { pipeline: null, explanation: '' };

  // Try extracting fenced JSON block first, keeping any prose outside as explanation.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/i;
  const fenceMatch = fenceRe.exec(trimmed);
  if (fenceMatch && fenceMatch[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim()) as RawPipelineOutput;
      const before = trimmed.slice(0, fenceMatch.index).trim();
      const after = trimmed.slice(fenceMatch.index + fenceMatch[0].length).trim();
      const prose = extractExplanationFromReply([before, after].filter(Boolean).join(' ').trim());
      const explanation =
        (typeof parsed.explanation === 'string' && parsed.explanation.trim()) || prose;
      return { pipeline: parsed, explanation };
    } catch {
      // fall through to brace scanning
    }
  }

  // Scan balanced outermost JSON object from first '{'
  const start = trimmed.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]!;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else {
        if (ch === '"') inString = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
    }
    if (end > start) {
      const jsonStr = trimmed.slice(start, end + 1);
      try {
        const parsed = JSON.parse(jsonStr) as RawPipelineOutput;
        const before = trimmed.slice(0, start).trim();
        const after = trimmed.slice(end + 1).trim();
        const prose = extractExplanationFromReply([before, after].filter(Boolean).join(' ').trim());
        const explanation =
          (typeof parsed.explanation === 'string' && parsed.explanation.trim()) || prose;
        return { pipeline: parsed, explanation };
      } catch {
        // fall through
      }
    }
  }

  return { pipeline: null, explanation: extractExplanationFromReply(trimmed) };
}

function normalizeSlotForContract(rawSlot: string): string {
  const s = (rawSlot || 'accessory').toLowerCase();
  if (s === 'swim_shorts') return 'bottom';
  if (
    s === 'top' ||
    s === 'bottom' ||
    s === 'dress' ||
    s === 'layer' ||
    s === 'shoes' ||
    s === 'bag' ||
    s === 'jewelry'
  ) {
    return s;
  }
  return 'accessory';
}

export async function mapPipelineToCapsuleResult(
  pipeline: RawPipelineOutput,
  brief: CapsuleBrief,
  meta: {
    explanation: string;
    totalMs: number;
    interactionMs: number;
    model: string;
    environmentId: string;
    interactionId?: string;
    costUsd?: number;
    usage?: CapsuleResult['usage'];
  },
  store: CapsuleStoreLayer = { lookup, getProduct },
): Promise<CapsuleResult> {
  const rawPieces = Array.isArray(pipeline.pieces) ? pipeline.pieces : [];
  const rawOwned = Array.isArray(pipeline.owned_pieces_used) ? pipeline.owned_pieces_used : [];
  const rawOutfits = Array.isArray(pipeline.outfits) ? pipeline.outfits : [];
  const problems: string[] = [];

  if (pipeline.error) {
    problems.push(String(pipeline.error));
  }

  // Enrich every new piece with full Item fields via our own store layer (lookup + getProduct fallback)
  const variantIds = rawPieces
    .map((p) => (typeof p.variant_id === 'string' ? p.variant_id : ''))
    .filter(Boolean);

  let lookupMap = new Map<string, LookupEntry>();
  if (variantIds.length > 0) {
    try {
      lookupMap = await store.lookup(variantIds);
    } catch {
      problems.push('store lookup failed during enrichment');
    }
  }

  const pieceById = new Map<string, Piece>();
  const enrichedPieces: Piece[] = [];

  await Promise.all(
    rawPieces.map(async (rp, idx) => {
      const vid = String(rp.variant_id ?? '');
      const pid = String(rp.id ?? vid ?? `piece-${idx}`);
      const slot = normalizeSlotForContract(String(rp.slot ?? 'accessory'));
      const lookupEntry = lookupMap.get(vid) ?? lookupMap.get(pid);
      let baseItem = lookupEntry?.item ?? null;

      let detail: ProductDetail | null = null;
      if (!baseItem || !baseItem.image || baseItem.sizes.length === 0) {
        try {
          detail = vid ? await store.getProduct(vid) : null;
        } catch {
          detail = null;
        }
      }

      const sizeLabel = String(rp.size_label ?? '').trim();
      const detailSizeOpt = detail?.options?.find((o) => /size|waist|shoe/i.test(o.name));
      const detailSizes = detailSizeOpt
        ? detailSizeOpt.values.filter((v) => v.available).map((v) => v.label)
        : [];
      const sizes =
        baseItem && baseItem.sizes.length > 0
          ? baseItem.sizes
          : detailSizes.length > 0
            ? detailSizes
            : sizeLabel
              ? [sizeLabel]
              : [];

      const variantsBySize: Record<string, string> = {
        ...(baseItem?.variants_by_size ?? {}),
        ...(sizeLabel && vid ? { [sizeLabel]: vid } : {}),
      };

      const storeDomain = baseItem?.store_domain || String(rp.store_domain ?? '');
      const storeName =
        baseItem?.store ||
        (rp.store && rp.store.trim()) ||
        storeNameForDomain(storeDomain);

      // URL must remain untouched from store layer (or pipeline's untouched MCP URL)
      const url = baseItem?.url || detail?.variant?.url || String(rp.url ?? '');
      const image = cleanImageUrl(baseItem?.image || detail?.images?.[0] || String(rp.image ?? ''));
      const price =
        typeof rp.price_usd === 'number' && Number.isFinite(rp.price_usd)
          ? rp.price_usd
          : (lookupEntry?.price ?? detail?.variant?.price ?? baseItem?.price ?? 0);

      const item: Item = {
        id: baseItem?.id || detail?.id || pid,
        variant_id: vid || baseItem?.variant_id || pid,
        title: baseItem?.title || detail?.title || String(rp.title ?? ''),
        price: Math.round(price * 100) / 100,
        url,
        image,
        store: storeName,
        store_domain: storeDomain,
        rating: baseItem?.rating ?? null,
        rating_count: baseItem?.rating_count ?? null,
        sizes,
        variants_by_size: variantsBySize,
        description: baseItem?.description || detail?.description || '',
        department: brief.gender,
      };

      const piece: Piece = {
        slot,
        why: sizeLabel ? `${rp.slot ?? slot} in size ${sizeLabel}` : `${rp.slot ?? slot}`,
        item,
      };
      pieceById.set(pid, piece);
      if (item.id && item.id !== pid) pieceById.set(item.id, piece);
      if (item.variant_id) pieceById.set(item.variant_id, piece);
      enrichedPieces[idx] = piece;
    }),
  );

  // Build owned Piece entries so day outfits reference full Piece/Item objects
  for (const ow of rawOwned) {
    const id = String(ow.id ?? '');
    if (!id) continue;
    const slot = normalizeSlotForContract(String(ow.slot ?? 'accessory'));
    const title = String(ow.title ?? id);
    const sz = String(ow.size_label ?? 'Owned');
    const ownedItem: Item = {
      id,
      variant_id: id,
      title,
      price: 0,
      url: '',
      image: '',
      store: 'Owned',
      store_domain: 'owned',
      rating: null,
      rating_count: null,
      sizes: [sz],
      variants_by_size: {},
      description: 'Already owned by shopper.',
      department: brief.gender,
    };
    pieceById.set(id, {
      slot,
      why: 'Owned piece from your wardrobe',
      item: ownedItem,
    });
  }

  const finalPieces = enrichedPieces.filter(Boolean);

  const outfits: Outfit[] = rawOutfits.map((ro, idx) => {
    const pids = Array.isArray(ro.piece_ids) ? ro.piece_ids : [];
    const dayPieces: Piece[] = [];
    for (const pid of pids) {
      const found = pieceById.get(String(pid));
      if (found) dayPieces.push(found);
    }
    const dayNewSum =
      Math.round(
        dayPieces.reduce((sum, p) => sum + (p.item.store_domain === 'owned' ? 0 : p.item.price), 0) *
          100,
      ) / 100;
    const dressCode = String(ro.dress_code ?? 'casual').replace(/_/g, ' ');
    const notes = String(ro.notes ?? '').trim();
    const pieceNames = dayPieces.map((p) => p.item.title).join(' + ');
    return {
      number: idx + 1,
      name: String(ro.day ?? `Day ${idx + 1}`),
      difference: notes ? `${dressCode} — ${notes}` : dressCode,
      story: pieceNames ? `Paired ${pieceNames}.` : dressCode,
      pieces: dayPieces,
      total: dayNewSum,
    };
  });

  const rawChecks = Array.isArray(pipeline.certificate?.checks) ? pipeline.certificate!.checks! : [];
  const checks: CapsuleCertificateCheck[] = rawChecks.map((c) => {
    if (typeof c === 'string') {
      return { name: c, ok: true };
    }
    return {
      name: String(c?.name ?? 'check'),
      ok: Boolean(c?.ok),
    };
  });

  const certificate: CapsuleCertificate = {
    all_sizes_in_stock: Boolean(pipeline.certificate?.all_sizes_in_stock),
    within_budget: Boolean(pipeline.certificate?.within_budget),
    checks,
  };

  const totalUsd =
    typeof pipeline.total_usd === 'number' && Number.isFinite(pipeline.total_usd)
      ? Math.round(pipeline.total_usd * 100) / 100
      : Math.round(finalPieces.reduce((s, p) => s + p.item.price, 0) * 100) / 100;

  const stores =
    Array.isArray(pipeline.stores) && pipeline.stores.length > 0
      ? pipeline.stores.map(String)
      : Array.from(new Set(finalPieces.map((p) => p.item.store).filter(Boolean))).sort();

  const t = pipeline.timings ?? {};
  const toolsSec =
    typeof t.total_s === 'number' && Number.isFinite(t.total_s)
      ? t.total_s
      : Number(t.fetch_s ?? 0) +
        Number(t.size_check_s ?? 0) +
        Number(t.solve_s ?? 0) +
        Number(t.verify_s ?? 0);
  const toolsMs = Math.max(0, Math.round(toolsSec * 1000));
  const agentMs = Math.max(0, meta.interactionMs - toolsMs);

  const ok = Boolean(pipeline.ok) && outfits.length > 0 && checks.every((c) => c.ok);
  if (!ok && problems.length === 0) {
    const failedChecks = checks.filter((c) => !c.ok).map((c) => c.name);
    problems.push(
      failedChecks.length > 0
        ? `verification failed: ${failedChecks.join(', ')}`
        : 'capsule pipeline did not succeed',
    );
  }

  return {
    ok,
    outfits,
    pieces: finalPieces,
    total_usd: totalUsd,
    stores,
    mix_and_match_count: Number(pipeline.mix_and_match_count ?? 0),
    certificate,
    searched: Number(pipeline.searched ?? 0),
    timings: {
      total_ms: Math.max(0, Math.round(meta.totalMs)),
      agent_ms: agentMs,
      tools_ms: toolsMs,
    },
    explanation: meta.explanation,
    problems,
    model: meta.model,
    environment_id: meta.environmentId,
    interaction_id: meta.interactionId,
    cost_usd: meta.costUsd,
    usage: meta.usage,
    brief,
  };
}

function buildPackPrompt(brief: CapsuleBrief): string {
  const ownedLine =
    Array.isArray(brief.owned) && brief.owned.length > 0
      ? brief.owned.join('; ')
      : 'none';
  const maxStores = brief.max_stores ?? 2;

  return `Capsule tools are installed at ${CAPSULE_REMOTE_TOOLS_DIR} (do NOT read the .py files or README).

SHOPPER BRIEF:
- Gender: ${brief.gender}
- Plans: ${brief.plans}
- Sizes: ${JSON.stringify(brief.sizes)}
- Budget: $${brief.budget_usd} max total
- Max stores: ${maxStores}
- Already owns ($0): ${ownedLine}

DO THIS IN ONE SHELL COMMAND:
1. Write /workspace/spec.json with: gender, sizes, days ([{name, dress_code ("casual"|"beach"|"smart_casual"|"black_tie_optional"), needs (array of slots), allow_swim_bottom?, notes}]), owned ([{slot, description, colour, leather?, formal?}]; split any suit into layer + bottom), budget_usd, max_stores, max_new_pieces (9), queries ({}), excludes ([]).
2. Immediately run: python3 ${CAPSULE_REMOTE_TOOLS_DIR}/capsule.py run /workspace/spec.json
3. Only if SUMMARY shows ok=false infeasible=true, relax in order in the same command and re-run \`capsule.py resolve /workspace/spec.json\`: (1) max_new_pieces +2, (2) max_stores +1. Note what you relaxed.
4. Do NOT print JSON. Reply with ONLY the word DONE on line 1, followed by a two-sentence explanation of the chosen capsule (and any relaxations).`;
}

function buildRepackPrompt(change: string, previous: CapsuleResult): string {
  const dayNames = previous.outfits.map((o, i) => `${i}: ${o.name}`).join(', ');
  return `Capsule tools are at ${CAPSULE_REMOTE_TOOLS_DIR}; existing spec is /workspace/spec.json (days: ${dayNames}). Do NOT read the .py files.

CHANGE: ${change}

DO THIS IN ONE SHELL COMMAND:
1. Update /workspace/spec.json for the change:
   - Keep unchanged days fixed via "fixed_days" (0-based indices).
   - For any black-tie-optional / formal day set "dress_code": "black_tie_optional" and "needs": ["top","bottom","shoes","layer","tie"] (men) or ["dress","shoes"] (women), and mark casual owned items (linen suit, brown loafers) "formal": false while white dress shirt is "formal": true.
2. Immediately run: python3 ${CAPSULE_REMOTE_TOOLS_DIR}/capsule.py resolve /workspace/spec.json
3. If SUMMARY shows ok=false infeasible=true, relax in order in ONE shell loop and re-run \`capsule.py resolve /workspace/spec.json\`: (1) max_new_pieces +2, (2) max_stores +1. Note what you relaxed.
4. Do NOT print JSON. Reply with ONLY the word DONE on line 1, followed by a two-sentence explanation.`;
}

function extractStepLinesFromResult(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const m = /^\s*STEP:\s*(.+?)\s*$/i.exec(rawLine);
    if (m && m[1]) {
      out.push(m[1]);
    }
  }
  return out;
}

async function runAgentInteraction(params: {
  client: CapsuleApiClient;
  environmentId: string;
  previousInteractionId?: string | null;
  model: string;
  input: string;
  t0: number;
  emitStep: (kind: string, text: string) => void;
}): Promise<{
  outputText: string;
  interactionId?: string;
  environmentId: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    thought_tokens: number;
    cached_tokens: number;
  };
  costUsd: number;
  interactionMs: number;
}> {
  const tStart = Date.now();
  const req: Record<string, unknown> = {
    agent: CAPSULE_AGENT_ID,
    environment: params.environmentId,
    agent_config: {
      type: 'antigravity',
      model: params.model,
      max_total_tokens: CAPSULE_MAX_TOKENS,
    },
    input: params.input,
    stream: true,
  };
  if (params.previousInteractionId) {
    req.previous_interaction_id = params.previousInteractionId;
  }

  const rawResp = await params.client.interactions.create(req);

  let finalInteraction: any = null;
  let collectedText = '';
  const emittedSteps = new Set<string>();

  const emitOnce = (kind: string, text: string) => {
    const key = `${kind}:${text}`;
    if (emittedSteps.has(key)) return;
    emittedSteps.add(key);
    params.emitStep(kind, text);
  };

  const inspectExecCall = (payload: unknown) => {
    const argStr = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
    if (argStr.includes('capsule.py resolve')) {
      emitOnce('run', 're-solving capsule in sandbox');
    } else if (argStr.includes('capsule.py run')) {
      emitOnce('run', 'running capsule pipeline in sandbox');
    } else if (argStr.includes('spec.json')) {
      emitOnce('spec', 'writing capsule spec');
    }
  };
  const inspectExecResult = (payload: unknown) => {
    const resStr = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
    for (const line of extractStepLinesFromResult(resStr)) {
      emitOnce('tool', line);
    }
  };

  if (rawResp && typeof rawResp[Symbol.asyncIterator] === 'function') {
    for await (const ev of rawResp as AsyncIterable<any>) {
      const et = String(ev?.event_type ?? '');
      if (et === 'step.delta') {
        const d = ev.delta ?? {};
        if (d.type === 'text' && typeof d.text === 'string') {
          collectedText += d.text;
        } else if (d.type === 'code_execution_call') {
          inspectExecCall(d.arguments ?? d.code ?? d);
        } else if (d.type === 'code_execution_result') {
          inspectExecResult(d.result ?? d.output ?? d);
        }
      } else if (et === 'step.stop' || et === 'step.start') {
        const st = ev.step ?? {};
        if (st.type === 'code_execution_call') {
          inspectExecCall(st.arguments ?? st.code ?? st);
        } else if (st.type === 'code_execution_result') {
          inspectExecResult(st.result ?? st.output ?? st);
        }
      } else if (et === 'interaction.completed') {
        finalInteraction = ev.interaction;
        if (Array.isArray(finalInteraction?.steps)) {
          for (const st of finalInteraction.steps) {
            if (st?.type === 'code_execution_result') {
              inspectExecResult(st.result ?? st.output ?? st);
            }
          }
        }
      }
    }
  } else {
    finalInteraction = rawResp;
    collectedText = String(rawResp?.output_text ?? '');
    if (Array.isArray(rawResp?.steps)) {
      for (const st of rawResp.steps) {
        if (st?.type === 'code_execution_result') {
          inspectExecResult(st.result ?? st.output ?? st);
        }
      }
    }
  }

  const interactionMs = Math.max(0, Date.now() - tStart);
  const usageObj = finalInteraction?.usage ?? {};
  const inputTokens = Number(usageObj.total_input_tokens ?? 0);
  const outputTokens = Number(usageObj.total_output_tokens ?? 0);
  const thoughtTokens = Number(usageObj.total_thought_tokens ?? 0);
  const cachedTokens = Number(usageObj.total_cached_tokens ?? 0);
  const billableOut = outputTokens + thoughtTokens;

  await recordCost({
    model: params.model,
    job: 'capsule',
    input_tokens: inputTokens,
    output_tokens: billableOut,
    ms: interactionMs,
  });
  const costUsd = estimateCostUsd({
    model: params.model,
    input_tokens: inputTokens,
    output_tokens: billableOut,
  });

  const outputText = String(finalInteraction?.output_text || collectedText || '');
  return {
    outputText,
    interactionId: typeof finalInteraction?.id === 'string' ? finalInteraction.id : undefined,
    environmentId: String(finalInteraction?.environment_id || params.environmentId),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      thought_tokens: thoughtTokens,
      cached_tokens: cachedTokens,
    },
    costUsd,
    interactionMs,
  };
}

async function downloadPipelineOutput(
  client: CapsuleApiClient,
  environmentId: string,
): Promise<RawPipelineOutput | null> {
  if (typeof client.environments?.files?.download !== 'function') return null;
  for (const remotePath of [
    'workspace/capsule_state/final_output.json',
    'capsule_state/final_output.json',
  ]) {
    try {
      const bytes = await client.environments.files.download({
        environment: environmentId,
        path: remotePath,
      });
      const text = Buffer.from(bytes).toString('utf8');
      return JSON.parse(text) as RawPipelineOutput;
    } catch {
      // try next path
    }
  }
  return null;
}

function findDressCodeNotes(
  outfits: Outfit[],
  brief: CapsuleBrief,
): CapsuleDressCodeNote[] {
  const notes: CapsuleDressCodeNote[] = [];
  const seen = new Set<string>();
  for (const outfit of outfits) {
    const dayOccasion = `${outfit.name} (${outfit.difference})`;
    for (const piece of outfit.pieces) {
      if (piece.item.store_domain === 'owned') continue;
      if (
        breaksDressCode(piece.item, piece.slot, {
          occasion: dayOccasion,
          gender: brief.gender,
        })
      ) {
        const key = `${piece.item.title}|${outfit.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          notes.push({
            day: outfit.name,
            title: piece.item.title,
            reason: `breaks the dress code for ${outfit.name}`,
          });
        }
      }
    }
  }
  return notes;
}

function buildQuickOutfitsForCritic(pipeline: RawPipelineOutput, brief: CapsuleBrief): Outfit[] | null {
  const rawPieces = Array.isArray(pipeline.pieces) ? pipeline.pieces : [];
  const rawOwned = Array.isArray(pipeline.owned_pieces_used) ? pipeline.owned_pieces_used : [];
  const rawOutfits = Array.isArray(pipeline.outfits) ? pipeline.outfits : [];
  if (rawOutfits.length === 0 || rawPieces.length === 0) return null;
  if (!rawPieces.every((p) => typeof p.image === 'string' && p.image.length > 0)) return null;

  const byId = new Map<string, Piece>();
  for (const rp of rawPieces) {
    const id = String(rp.id ?? rp.variant_id ?? '');
    if (!id) continue;
    const slot = normalizeSlotForContract(String(rp.slot ?? 'accessory'));
    const piece: Piece = {
      slot,
      why: slot,
      item: {
        id,
        variant_id: String(rp.variant_id ?? id),
        title: String(rp.title ?? ''),
        price: Number(rp.price_usd ?? 0),
        url: String(rp.url ?? ''),
        image: cleanImageUrl(String(rp.image ?? '')),
        store: String(rp.store ?? ''),
        store_domain: String(rp.store_domain ?? ''),
        rating: null,
        rating_count: null,
        sizes: rp.size_label ? [String(rp.size_label)] : [],
        variants_by_size: {},
        description: '',
        department: brief.gender,
      },
    };
    byId.set(id, piece);
    if (rp.variant_id) byId.set(String(rp.variant_id), piece);
  }
  for (const ow of rawOwned) {
    const id = String(ow.id ?? '');
    if (!id) continue;
    const slot = normalizeSlotForContract(String(ow.slot ?? 'accessory'));
    byId.set(id, {
      slot,
      why: 'Owned piece',
      item: {
        id,
        variant_id: id,
        title: String(ow.title ?? id),
        price: 0,
        url: '',
        image: '',
        store: 'Owned',
        store_domain: 'owned',
        rating: null,
        rating_count: null,
        sizes: [],
        variants_by_size: {},
        description: '',
        department: brief.gender,
      },
    });
  }

  return rawOutfits.map((ro, idx) => {
    const pieces = (Array.isArray(ro.piece_ids) ? ro.piece_ids : [])
      .map((pid) => byId.get(String(pid)))
      .filter((p): p is Piece => Boolean(p));
    return {
      number: idx + 1,
      name: String(ro.day ?? `Day ${idx + 1}`),
      difference: String(ro.dress_code ?? 'casual').replace(/_/g, ' '),
      story: '',
      pieces,
      total: Number(ro.total_new_usd ?? 0),
    };
  });
}

async function evaluateCritic(
  outfits: Outfit[],
  brief: CapsuleBrief,
  opts: CapsuleOptions,
): Promise<CapsuleCriticEntry[] | null> {
  if (opts.skipCritic || outfits.length === 0) return null;

  const critiqueAllFn = opts.critiqueAll ?? defaultCritiqueAll;
  const criticBrief: Brief = {
    gender: brief.gender,
    occasion: brief.plans,
    budget_usd: brief.budget_usd,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const critiques = await Promise.race<Critique[] | null>([
      critiqueAllFn(outfits, criticBrief, {
        timeoutMs: CRITIC_TIMEOUT_MS,
        room: getCallRoom() ?? undefined,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CRITIC_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);

    if (!Array.isArray(critiques) || critiques.length !== outfits.length) {
      return null;
    }
    if (critiques.some((c) => c.error || !Number.isFinite(c.score) || c.score <= 0)) {
      return null;
    }

    return outfits.map((outfit, idx) => ({
      day: outfit.name,
      score: critiques[idx]!.score,
      presentable: Boolean(critiques[idx]!.presentable),
      issues: Array.isArray(critiques[idx]!.issues) ? critiques[idx]!.issues : [],
    }));
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function attachAdvisoryReports(
  result: CapsuleResult,
  brief: CapsuleBrief,
  criticEntries: CapsuleCriticEntry[] | null,
  emitStep: (kind: string, text: string) => void,
): void {
  const dressCodeNotes = findDressCodeNotes(result.outfits, brief);
  result.dress_code_notes = dressCodeNotes;
  if (dressCodeNotes.length > 0) {
    emitStep(
      'dress_code',
      `dress-code note: ${dressCodeNotes.map((n) => `${n.title} (${n.day})`).join('; ')}`,
    );
  }

  if (criticEntries && criticEntries.length > 0) {
    const allSixPlus = criticEntries.every((e) => e.score >= 6);
    result.critic = criticEntries;
    result.certificate.checks.push({
      name: 'critic_all_6_plus',
      ok: allSixPlus,
      advisory: true,
    });
    emitStep(
      'critic',
      `critic scored ${criticEntries.map((e) => `${e.score}/10`).join(', ')} (${allSixPlus ? 'all >= 6' : 'below 6'})`,
    );
  }
}

export async function packCapsule(
  brief: CapsuleBrief,
  opts: CapsuleOptions = {},
): Promise<CapsuleResult> {
  const t0 = Date.now();
  const model = resolveCapsuleModel(opts.model);

  if (!opts.force && !isCapsuleEnabled()) {
    return emptyFailure(t0, ['capsule is switched off'], {
      model,
      brief,
    });
  }

  const emitStep = (kind: string, text: string) => {
    const step: CapsuleStep = { t_ms: Math.max(0, Date.now() - t0), kind, text };
    logEvent('capsule_step', { t_ms: step.t_ms, kind: step.kind, text: step.text });
    try {
      opts.onStep?.(step);
    } catch {
      // Never throw from callback
    }
  };

  logEvent('capsule_start', {
    mode: 'pack',
    model,
    gender: brief.gender,
    budget_usd: brief.budget_usd,
  });

  try {
    const client = opts.client ?? createCapsuleClient();
    const envRes = await ensureEnvironment({
      client,
      statePath: opts.statePath,
      toolsDir: opts.toolsDir,
      setupModel: model,
    });

    if (envRes.rebuilt) {
      emitStep('env', `prepared capsule sandbox (${(envRes.ms / 1000).toFixed(1)}s)`);
    }

    const run = await runAgentInteraction({
      client,
      environmentId: envRes.state.environment_id,
      model,
      input: buildPackPrompt(brief),
      t0,
      emitStep,
    });

    if (run.interactionId) {
      updateEnvironmentInteraction(run.interactionId, opts.statePath);
    }

    // Download final_output.json from sandbox first; fall back to parsing agent reply if download fails
    let pipeline = await downloadPipelineOutput(client, run.environmentId);
    let explanation = extractExplanationFromReply(run.outputText);
    if (!pipeline) {
      const parsed = parseAgentOutput(run.outputText);
      pipeline = parsed.pipeline;
      if (parsed.explanation) explanation = parsed.explanation;
    }

    if (!pipeline) {
      const errMsg = 'Could not read pipeline JSON from sandbox or agent reply';
      logEvent('capsule_fail', { mode: 'pack', model, error: errMsg, ms: Date.now() - t0 });
      return emptyFailure(t0, [errMsg], {
        model,
        environment_id: run.environmentId,
        interaction_id: run.interactionId,
        cost_usd: run.costUsd,
        usage: run.usage,
        explanation,
        brief,
      });
    }

    // Start critic in parallel with store enrichment/verification when images are already in final_output.json
    const quickOutfits = pipeline.ok ? buildQuickOutfitsForCritic(pipeline, brief) : null;
    const parallelCriticPromise = quickOutfits
      ? evaluateCritic(quickOutfits, brief, opts)
      : null;

    const result = await mapPipelineToCapsuleResult(
      pipeline,
      brief,
      {
        explanation,
        totalMs: Date.now() - t0,
        interactionMs: run.interactionMs,
        model,
        environmentId: run.environmentId,
        interactionId: run.interactionId,
        costUsd: run.costUsd,
        usage: run.usage,
      },
      opts.store,
    );

    // Report-only dress-code notes and critic (never triggers a re-solve; capped at 8 s)
    const criticEntries = result.ok
      ? await (parallelCriticPromise ?? evaluateCritic(result.outfits, brief, opts))
      : null;
    attachAdvisoryReports(result, brief, criticEntries, emitStep);
    result.timings.total_ms = Math.max(0, Date.now() - t0);

    logEvent(result.ok ? 'capsule_done' : 'capsule_fail', {
      mode: 'pack',
      model,
      ok: result.ok,
      pieces: result.pieces.length,
      outfits: result.outfits.length,
      total_usd: result.total_usd,
      searched: result.searched,
      ms: result.timings.total_ms,
      tools_ms: result.timings.tools_ms,
      agent_ms: result.timings.agent_ms,
    });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent('capsule_fail', { mode: 'pack', model, error: message, ms: Date.now() - t0 });
    return emptyFailure(t0, [message], { model, brief });
  }
}

export async function repackCapsule(
  previous: CapsuleResult,
  change: string,
  opts: CapsuleOptions = {},
): Promise<CapsuleResult> {
  const t0 = Date.now();
  const model = resolveCapsuleModel(opts.model ?? previous.model);
  const brief = previous.brief ?? {
    gender: 'men',
    plans: change,
    sizes: {},
    budget_usd: 450,
  };

  if (!opts.force && !isCapsuleEnabled()) {
    return emptyFailure(t0, ['capsule is switched off'], {
      model,
      brief,
    });
  }

  const emitStep = (kind: string, text: string) => {
    const step: CapsuleStep = { t_ms: Math.max(0, Date.now() - t0), kind, text };
    logEvent('capsule_step', { t_ms: step.t_ms, kind: step.kind, text: step.text });
    try {
      opts.onStep?.(step);
    } catch {
      // Never throw from callback
    }
  };

  logEvent('capsule_start', {
    mode: 'repack',
    model,
    change,
  });

  try {
    const client = opts.client ?? createCapsuleClient();
    let environmentId = previous.environment_id;
    let previousInteractionId = previous.interaction_id ?? null;

    if (!environmentId) {
      const envRes = await ensureEnvironment({
        client,
        statePath: opts.statePath,
        toolsDir: opts.toolsDir,
        setupModel: model,
      });
      environmentId = envRes.state.environment_id;
      previousInteractionId = envRes.state.last_interaction_id;
    }

    const run = await runAgentInteraction({
      client,
      environmentId,
      previousInteractionId,
      model,
      input: buildRepackPrompt(change, previous),
      t0,
      emitStep,
    });

    if (run.interactionId) {
      updateEnvironmentInteraction(run.interactionId, opts.statePath);
    }

    let pipeline = await downloadPipelineOutput(client, run.environmentId);
    let explanation = extractExplanationFromReply(run.outputText);
    if (!pipeline) {
      const parsed = parseAgentOutput(run.outputText);
      pipeline = parsed.pipeline;
      if (parsed.explanation) explanation = parsed.explanation;
    }

    if (!pipeline) {
      const errMsg = 'Could not read pipeline JSON from sandbox or agent reply';
      logEvent('capsule_fail', { mode: 'repack', model, error: errMsg, ms: Date.now() - t0 });
      return emptyFailure(t0, [errMsg], {
        model,
        environment_id: run.environmentId,
        interaction_id: run.interactionId,
        cost_usd: run.costUsd,
        usage: run.usage,
        explanation,
        brief,
      });
    }

    const quickOutfits = pipeline.ok ? buildQuickOutfitsForCritic(pipeline, brief) : null;
    const parallelCriticPromise = quickOutfits
      ? evaluateCritic(quickOutfits, brief, opts)
      : null;

    const result = await mapPipelineToCapsuleResult(
      pipeline,
      brief,
      {
        explanation,
        totalMs: Date.now() - t0,
        interactionMs: run.interactionMs,
        model,
        environmentId: run.environmentId,
        interactionId: run.interactionId,
        costUsd: run.costUsd,
        usage: run.usage,
      },
      opts.store,
    );

    // Strictly ONE sandbox run per repack; dress-code notes and critic are report-only
    const criticEntries = result.ok
      ? await (parallelCriticPromise ?? evaluateCritic(result.outfits, brief, opts))
      : null;
    attachAdvisoryReports(result, brief, criticEntries, emitStep);
    result.timings.total_ms = Math.max(0, Date.now() - t0);

    logEvent(result.ok ? 'capsule_done' : 'capsule_fail', {
      mode: 'repack',
      model,
      ok: result.ok,
      pieces: result.pieces.length,
      outfits: result.outfits.length,
      total_usd: result.total_usd,
      searched: result.searched,
      ms: result.timings.total_ms,
      tools_ms: result.timings.tools_ms,
      agent_ms: result.timings.agent_ms,
    });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent('capsule_fail', { mode: 'repack', model, error: message, ms: Date.now() - t0 });
    return emptyFailure(t0, [message], { model, brief });
  }
}
