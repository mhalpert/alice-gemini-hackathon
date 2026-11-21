import type { BagOut, CartResult, Gender, Outfit, Piece } from '../types.ts';
import type { ProductDetail, SizeVariantOpts, SizeVariantResult } from './catalog.ts';
import type { CartLineInput, CreateCartOpts, StoreCartResponse } from './cart.ts';
import { getProduct, sizeVariant } from './catalog.ts';
import { createCart } from './cart.ts';
import { storeNameForDomain } from './stores.ts';
import { logEvent } from './log.ts';
import {
  isSizeConverted,
  matchSizeDetail,
  matchSizeLabel,
  parseWaistInseam,
} from './sizing.ts';
import type { MatchSizeOptions } from './sizing.ts';

export { matchSizeLabel, isSizeConverted };
export type { MatchSizeOptions };

export interface BagLineAdded {
  variant_id: string;
  title?: string;
  size?: string | null;
  asked_size?: string | null;
  size_converted?: boolean;
  note?: string;
  slot: string;
  image: string;
  price: number;
  item_id: string;
}

export interface BagLineNotAdded {
  variant_id: string;
  title?: string;
  size?: string | null;
  asked_size?: string | null;
  size_converted?: boolean;
  note?: string;
  reason: string;
  slot: string;
  image: string;
  price: number;
  item_id: string;
}

export interface BagStoreDeps {
  getProduct(id: string): Promise<ProductDetail | null>;
  sizeVariant(variantId: string, size: string, opts?: SizeVariantOpts): Promise<SizeVariantResult>;
  createCart(
    storeDomain: string,
    lines: CartLineInput[],
    opts?: CreateCartOpts,
  ): Promise<StoreCartResponse>;
  now?: () => number;
  recoveryCapMs?: number;
}

const ONE_SIZE_LABEL_RE =
  /^(?:one\s*si?ze?(?:\s*fits\s*(?:all|most))?|one\s*sz|onesz|1\s*sz|1\s*size|o\.?\/?s\.?|osfa|osfm|free\s*size|no\s*size|nosize|n\/a|uni(?:sex)?|standard|default(?:\s*title)?)$/i;

const DEFAULT_RECOVERY_CAP_MS = 4000;

function isOneSizeOption(
  sizeOption: { name: string; values: { label: string }[] } | undefined,
): boolean {
  if (!sizeOption || sizeOption.values.length === 0) return true;
  if (sizeOption.values.length === 1) {
    return ONE_SIZE_LABEL_RE.test(sizeOption.values[0].label.trim());
  }
  return false;
}

function pickSize(sizes: Record<string, string> | undefined, ...keys: string[]): string | undefined {
  if (!sizes || typeof sizes !== 'object') return undefined;
  const lowered = new Map<string, string>();
  for (const [k, v] of Object.entries(sizes)) {
    if (typeof v === 'string' && v.trim()) {
      lowered.set(k.trim().toLowerCase(), v.trim());
    }
  }
  for (const key of keys) {
    const val = lowered.get(key.toLowerCase());
    if (val) return val;
  }
  return undefined;
}

function sizeForSlot(slot: string, sizes: Record<string, string>): string | undefined {
  const s = slot.trim().toLowerCase();
  if (s === 'top') return pickSize(sizes, 'top');
  if (s === 'bottom') return pickSize(sizes, 'bottom');
  if (s === 'shoes' || s === 'shoe') return pickSize(sizes, 'shoes', 'shoe');
  if (s === 'dress') return pickSize(sizes, 'dress', 'top');
  if (s === 'layer') return pickSize(sizes, 'layer', 'top');
  return pickSize(sizes, s);
}

interface ResolvedPiece {
  piece: Piece;
  status: 'added' | 'not_added';
  missingSize: boolean;
  verifiedAt?: number;
  lineAdded?: BagLineAdded;
  lineNotAdded?: BagLineNotAdded;
}

function isCartOk(res: StoreCartResponse | null | undefined): boolean {
  return Boolean(res && !res.error && (res.cart_id || res.continue_url));
}

function formatSizesPreview(values: { label: string; available: boolean }[]): string {
  const avail = values.filter((v) => v.available).map((v) => v.label.trim());
  const source = avail.length > 0 ? avail : values.map((v) => v.label.trim());
  return source.slice(0, 12).join(', ');
}

function extractMessageText(msg: any): string {
  if (typeof msg === 'string') return msg;
  if (!msg || typeof msg !== 'object') return 'item unavailable';
  return String(msg.content ?? msg.message ?? msg.text ?? 'item unavailable');
}

export function reasonFromCartError(
  res: Pick<StoreCartResponse, 'error' | 'messages'>,
): string {
  const errMsg = Array.isArray(res.messages)
    ? res.messages.find((m) => String(m?.type ?? '').toLowerCase() === 'error') ?? res.messages[0]
    : null;
  const raw = (errMsg ? extractMessageText(errMsg) : '') || res.error || '';
  const cleaned = raw.replace(/\s+/g, ' ').trim();

  if (
    !cleaned ||
    /timeout|timed out|ECONNRESET|fetch failed|HTTP 5\d\d|network|not connected|socket/i.test(cleaned)
  ) {
    return 'the store did not answer; try again in a moment';
  }
  if (/quantity|insufficient|not\s+enough|exceeds|limit/i.test(cleaned)) {
    return 'quantity not available';
  }
  if (/sold\s*out|out\s*of\s*stock|unavailable|does\s*not\s*exist|not\s*found|no\s*longer/i.test(cleaned)) {
    return 'sold out';
  }
  const shortText = cleaned
    .replace(/gid:\/\/shopify\/ProductVariant\/\d+/g, 'this variant')
    .slice(0, 80)
    .trim();
  return `the store refused this item: ${shortText}`;
}

export function findBadLineIndicesFromError(
  res: Pick<StoreCartResponse, 'error' | 'messages'>,
  lines: Array<{ variant_id: string }>,
): number[] {
  const matched = new Set<number>();
  const messages = Array.isArray(res.messages) ? res.messages : [];
  const textBlobs: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const pathStr = typeof msg.path === 'string' ? msg.path : '';
    const pathMatch = pathStr.match(/(?:add_items|line_items)\[(\d+)\]/i);
    if (pathMatch) {
      const idx = Number(pathMatch[1]);
      if (idx >= 0 && idx < lines.length) matched.add(idx);
    }
    const content = extractMessageText(msg);
    if (content) textBlobs.push(content);
  }

  if (typeof res.error === 'string' && res.error) {
    textBlobs.push(res.error);
    for (const m of res.error.matchAll(/(?:add_items|line_items)\[(\d+)\]/gi)) {
      const idx = Number(m[1]);
      if (idx >= 0 && idx < lines.length) matched.add(idx);
    }
    for (const m of res.error.matchAll(/\bline\s+#?(\d+)\b/gi)) {
      const idx = Number(m[1]);
      if (idx >= 0 && idx < lines.length) matched.add(idx);
    }
  }

  const combined = textBlobs.join(' ').toLowerCase();
  if (combined) {
    lines.forEach((line, idx) => {
      const vid = line.variant_id.toLowerCase();
      if (vid && combined.includes(vid)) {
        matched.add(idx);
        return;
      }
      const numMatch = line.variant_id.match(/(\d{6,})$/);
      if (numMatch && combined.includes(numMatch[1])) {
        matched.add(idx);
      }
    });
  }

  return Array.from(matched).sort((a, b) => a - b);
}

function isLineBlockingMessage(msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const type = String(msg.type ?? '').toLowerCase();
  if (type === 'error') return true;
  if (type === 'warning') {
    const text = `${extractMessageText(msg)} ${String(msg.code ?? '')}`;
    return /stock|unavail|sold\s*out|out\s*of|invent|quantity|insufficient/i.test(text);
  }
  return false;
}

function findFlaggedLineIndices(
  msg: any,
  added: BagLineAdded[],
  cartLineItems: any[],
): number[] {
  const matched = new Set<number>();
  const pathStr = typeof msg?.path === 'string' ? msg.path : '';
  const pathMatch = pathStr.match(/line_items\[(\d+)\]/i);
  if (pathMatch) {
    const idx = Number(pathMatch[1]);
    if (idx >= 0 && idx < added.length) {
      matched.add(idx);
      return [idx];
    }
  }

  const text = extractMessageText(msg).toLowerCase();
  const dataStr = msg?.data ? JSON.stringify(msg.data).toLowerCase() : '';
  const combined = `${text} ${dataStr}`;

  added.forEach((line, idx) => {
    if (
      (line.variant_id && combined.includes(line.variant_id.toLowerCase())) ||
      (line.title && line.title.length >= 4 && combined.includes(line.title.toLowerCase()))
    ) {
      matched.add(idx);
    }
  });

  if (matched.size === 0 && Array.isArray(cartLineItems) && cartLineItems.length > 0) {
    const presentIds = new Set(
      cartLineItems
        .map((li) => (typeof li?.item?.id === 'string' ? li.item.id : ''))
        .filter(Boolean),
    );
    added.forEach((line, idx) => {
      if (!presentIds.has(line.variant_id)) {
        matched.add(idx);
      }
    });
  }

  return Array.from(matched);
}

function formatConvertedDisplaySize(line: BagLineAdded): string {
  const sz = (line.size ?? '').trim();
  if (
    line.slot.trim().toLowerCase() === 'shoes' &&
    /^\d+(?:\.\d+)?$/.test(sz) &&
    Number(sz) >= 34 &&
    Number(sz) <= 50
  ) {
    return `EU ${sz}`;
  }
  return sz;
}

export function createBag(deps?: Partial<BagStoreDeps>): {
  addToBag(outfit: Outfit, sizes: Record<string, string>, gender: Gender): Promise<BagOut>;
} {
  const getProductFn = deps?.getProduct ?? getProduct;
  const sizeVariantFn = deps?.sizeVariant ?? sizeVariant;
  const createCartFn = deps?.createCart ?? createCart;
  const now = deps?.now ?? (() => Date.now());
  const recoveryCapMs = deps?.recoveryCapMs ?? DEFAULT_RECOVERY_CAP_MS;

  async function resolvePiece(
    piece: Piece,
    sizes: Record<string, string>,
    gender: Gender,
  ): Promise<ResolvedPiece> {
    const { item, slot } = piece;
    const baseFields = {
      title: item.title,
      slot,
      image: item.image,
      price: item.price,
      item_id: item.id,
    };

    const rawSize = sizeForSlot(slot, sizes);
    const explicitInseam =
      slot.trim().toLowerCase() === 'bottom' ? pickSize(sizes, 'inseam', 'length') : undefined;
    const parsedWxL = rawSize && slot.trim().toLowerCase() === 'bottom'
      ? parseWaistInseam(rawSize)
      : null;
    const effectiveRawForMatching =
      rawSize && explicitInseam && !parsedWxL ? `${rawSize}x${explicitInseam}` : rawSize;
    const wantedInseam = parsedWxL?.inseamStr ?? explicitInseam;
    const asked_size = effectiveRawForMatching ?? null;

    const detail = await getProductFn(item.variant_id);
    if (!detail) {
      return {
        piece,
        status: 'not_added',
        missingSize: false,
        lineNotAdded: {
          ...baseFields,
          variant_id: item.variant_id,
          size: null,
          asked_size,
          reason: 'could not check product availability',
        },
      };
    }

    const sizeOption =
      detail.options.find((o) => /size/i.test(o.name)) ??
      detail.options.find((o) => /waist/i.test(o.name));

    if (isOneSizeOption(sizeOption)) {
      const singleSize = sizeOption?.values[0]?.label ?? null;
      if (detail.variant.available) {
        return {
          piece,
          status: 'added',
          missingSize: false,
          verifiedAt: now(),
          lineAdded: {
            ...baseFields,
            variant_id: item.variant_id,
            size: singleSize,
            asked_size,
          },
        };
      }
      return {
        piece,
        status: 'not_added',
        missingSize: false,
        lineNotAdded: {
          ...baseFields,
          variant_id: item.variant_id,
          size: singleSize,
          asked_size,
          reason: 'sold out',
        },
      };
    }

    const preview = formatSizesPreview(sizeOption!.values);

    if (!rawSize) {
      return {
        piece,
        status: 'not_added',
        missingSize: true,
        lineNotAdded: {
          ...baseFields,
          variant_id: item.variant_id,
          size: null,
          asked_size: null,
          reason: `no ${slot} size given (sizes: ${preview})`,
        },
      };
    }

    const allLabels = sizeOption!.values.map((v) => v.label);
    const availLabels = sizeOption!.values.filter((v) => v.available).map((v) => v.label);
    const matchedDetail = matchSizeDetail(effectiveRawForMatching!, allLabels, {
      slot,
      gender,
      available: availLabels,
    });
    const matched = matchedDetail.label;

    if (!matched) {
      return {
        piece,
        status: 'not_added',
        missingSize: false,
        lineNotAdded: {
          ...baseFields,
          variant_id: item.variant_id,
          size: null,
          asked_size,
          reason:
            matchedDetail.soldOutReason ??
            `${rawSize} isn't in stock (sizes left: ${preview})`,
        },
      };
    }

    const sv = await sizeVariantFn(item.variant_id, matched, {
      gender,
      slot,
      ...(wantedInseam ? { inseam: wantedInseam } : {}),
    });
    const resolvedSize = sv.size ?? matched;
    const converted = isSizeConverted(effectiveRawForMatching, resolvedSize);
    const note = [matchedDetail.note, sv.note]
      .filter((n, idx, arr) => Boolean(n) && arr.indexOf(n) === idx)
      .join('; ') || undefined;

    if (!sv.ok || !sv.variant_id) {
      return {
        piece,
        status: 'not_added',
        missingSize: false,
        lineNotAdded: {
          ...baseFields,
          variant_id: sv.variant_id ?? item.variant_id,
          size: resolvedSize,
          asked_size,
          ...(converted ? { size_converted: true } : {}),
          ...(note ? { note } : {}),
          reason: sv.reason ?? `${matched} is unavailable`,
        },
      };
    }

    return {
      piece,
      status: 'added',
      missingSize: false,
      verifiedAt: now(),
      lineAdded: {
        ...baseFields,
        variant_id: sv.variant_id,
        size: resolvedSize,
        asked_size,
        ...(converted ? { size_converted: true } : {}),
        ...(note ? { note } : {}),
      },
    };
  }

  async function addToBag(
    outfit: Outfit,
    sizes: Record<string, string>,
    gender: Gender,
  ): Promise<BagOut> {
    const t0 = now();
    try {
      const pieces = Array.isArray(outfit?.pieces) ? outfit.pieces : [];
      const resolvedList = await Promise.all(
        pieces.map((piece) => resolvePiece(piece, sizes ?? {}, gender)),
      );

      const storeGroups = new Map<
        string,
        {
          store: string;
          store_domain: string;
          added: BagLineAdded[];
          verifiedAt: Map<string, number>;
          not_added: BagLineNotAdded[];
        }
      >();

      const missingPieces: Piece[] = [];

      for (const res of resolvedList) {
        const domain = res.piece.item.store_domain || 'unknown';
        const displayStore = res.piece.item.store || storeNameForDomain(domain);
        let group = storeGroups.get(domain);
        if (!group) {
          group = {
            store: displayStore,
            store_domain: domain,
            added: [],
            verifiedAt: new Map(),
            not_added: [],
          };
          storeGroups.set(domain, group);
        }

        if (res.missingSize) {
          missingPieces.push(res.piece);
        }

        if (res.status === 'added' && res.lineAdded) {
          group.added.push(res.lineAdded);
          if (res.verifiedAt !== undefined) {
            group.verifiedAt.set(res.lineAdded.variant_id, res.verifiedAt);
          }
        } else if (res.lineNotAdded) {
          group.not_added.push(res.lineNotAdded);
        }
      }

      const groups = Array.from(storeGroups.values());

      if (missingPieces.length > 0) {
        const carts: CartResult[] = groups.map((g) => ({
          store: g.store,
          store_domain: g.store_domain,
          cart_id: null,
          continue_url: null,
          total_usd: null,
          added: g.added,
          not_added: g.not_added,
          ms: 0,
        }));

        const missingDesc = missingPieces
          .map((p) => `${p.item.title} (${p.slot})`)
          .join(', ');
        const summary = `NOT DONE: ${missingDesc} still need a size.`;
        const ms = Math.max(0, now() - t0);
        const reasons = carts.flatMap((c) => c.not_added.map((x) => x.reason));
        console.log(
          `[store] bag ${pieces.length} pieces missing_sizes=${missingPieces.length} carts=0 ${ms}ms`,
        );
        logEvent('store_bag', {
          added: 0,
          not_added: reasons.length,
          missing_sizes: missingPieces.length,
          carts: 0,
          total_usd: 0,
          ms,
          reasons,
        });
        return { carts, summary, total_usd: 0 };
      }

      let anyRecovered = false;
      let anyRecoveryTimedOut = false;

      const carts: CartResult[] = await Promise.all(
        groups.map(async (g): Promise<CartResult> => {
          if (g.added.length === 0) {
            return {
              store: g.store,
              store_domain: g.store_domain,
              cart_id: null,
              continue_url: null,
              total_usd: null,
              added: [],
              not_added: g.not_added,
              ms: 0,
            };
          }

          const storeStart = now();
          let cartRes = await createCartFn(
            g.store_domain,
            g.added.map((line) => ({ variant_id: line.variant_id, quantity: 1 })),
          );

          let activeAdded: BagLineAdded[] = [...g.added];
          const extraNotAdded: BagLineNotAdded[] = [];

          if (!isCartOk(cartRes)) {
            if (activeAdded.length === 1) {
              const reason = reasonFromCartError(cartRes);
              return {
                store: g.store,
                store_domain: g.store_domain,
                cart_id: null,
                continue_url: null,
                total_usd: null,
                added: [],
                not_added: [...g.not_added, { ...activeAdded[0], reason }],
                ms: Math.max(0, now() - storeStart),
              };
            }

            const recoveryDeadline = now() + recoveryCapMs;
            let lastRes = cartRes;
            let recoveredCart: { res: StoreCartResponse; lines: BagLineAdded[] } | null = null;

            while (activeAdded.length > 0 && now() < recoveryDeadline) {
              const badIndices = findBadLineIndicesFromError(lastRes, activeAdded);
              if (badIndices.length === 0) break;

              const badSet = new Set(badIndices);
              const reason = reasonFromCartError(lastRes);
              const nextCandidates: BagLineAdded[] = [];
              activeAdded.forEach((line, idx) => {
                if (badSet.has(idx)) {
                  extraNotAdded.push({ ...line, reason });
                } else {
                  nextCandidates.push(line);
                }
              });
              activeAdded = nextCandidates;
              if (activeAdded.length === 0) break;

              lastRes = await createCartFn(
                g.store_domain,
                activeAdded.map((line) => ({ variant_id: line.variant_id, quantity: 1 })),
                { noRetry: true },
              );
              if (isCartOk(lastRes)) {
                recoveredCart = { res: lastRes, lines: activeAdded };
                anyRecovered = true;
                break;
              }
            }

            if (!recoveredCart && activeAdded.length > 1) {
              const ordered = [...activeAdded].sort(
                (a, b) =>
                  (g.verifiedAt.get(b.variant_id) ?? 0) - (g.verifiedAt.get(a.variant_id) ?? 0),
              );
              let bestCart: { res: StoreCartResponse; lines: BagLineAdded[] } | null = null;

              const recordBest = (res: StoreCartResponse, lines: BagLineAdded[]): void => {
                if (!bestCart || lines.length > bestCart.lines.length) {
                  bestCart = { res, lines };
                }
              };

              const isolate = async (
                subset: BagLineAdded[],
                parentErr: StoreCartResponse,
              ): Promise<BagLineAdded[]> => {
                if (subset.length === 0) return [];
                if (now() >= recoveryDeadline) {
                  anyRecoveryTimedOut = true;
                  const reason = reasonFromCartError(parentErr);
                  for (const l of subset) extraNotAdded.push({ ...l, reason });
                  return [];
                }
                if (subset.length === 1) {
                  const singleRes = await createCartFn(
                    g.store_domain,
                    [{ variant_id: subset[0].variant_id, quantity: 1 }],
                    { noRetry: true },
                  );
                  if (isCartOk(singleRes)) {
                    recordBest(singleRes, subset);
                    return subset;
                  }
                  extraNotAdded.push({ ...subset[0], reason: reasonFromCartError(singleRes) });
                  return [];
                }

                const mid = Math.ceil(subset.length / 2);
                const left = subset.slice(0, mid);
                const right = subset.slice(mid);

                const [leftRes, rightRes] = await Promise.all([
                  createCartFn(
                    g.store_domain,
                    left.map((l) => ({ variant_id: l.variant_id, quantity: 1 })),
                    { noRetry: true },
                  ),
                  createCartFn(
                    g.store_domain,
                    right.map((l) => ({ variant_id: l.variant_id, quantity: 1 })),
                    { noRetry: true },
                  ),
                ]);

                const handleHalf = async (
                  half: BagLineAdded[],
                  halfRes: StoreCartResponse,
                ): Promise<BagLineAdded[]> => {
                  if (isCartOk(halfRes)) {
                    recordBest(halfRes, half);
                    return half;
                  }
                  if (half.length === 1) {
                    extraNotAdded.push({ ...half[0], reason: reasonFromCartError(halfRes) });
                    return [];
                  }
                  if (now() >= recoveryDeadline) {
                    anyRecoveryTimedOut = true;
                    const reason = reasonFromCartError(halfRes);
                    for (const l of half) extraNotAdded.push({ ...l, reason });
                    return [];
                  }
                  const named = findBadLineIndicesFromError(halfRes, half);
                  if (named.length > 0) {
                    const namedSet = new Set(named);
                    const reason = reasonFromCartError(halfRes);
                    const kept: BagLineAdded[] = [];
                    half.forEach((l, i) => {
                      if (namedSet.has(i)) extraNotAdded.push({ ...l, reason });
                      else kept.push(l);
                    });
                    if (kept.length === 0) return [];
                    const keptRes = await createCartFn(
                      g.store_domain,
                      kept.map((l) => ({ variant_id: l.variant_id, quantity: 1 })),
                      { noRetry: true },
                    );
                    if (isCartOk(keptRes)) {
                      recordBest(keptRes, kept);
                      return kept;
                    }
                    return isolate(kept, keptRes);
                  }
                  return isolate(half, halfRes);
                };

                const [goodLeft, goodRight] = await Promise.all([
                  handleHalf(left, leftRes),
                  handleHalf(right, rightRes),
                ]);
                return [...goodLeft, ...goodRight];
              };

              const goodLines = await isolate(ordered, lastRes);
              if (goodLines.length > 0) {
                if (bestCart && bestCart.lines.length === goodLines.length) {
                  recoveredCart = bestCart;
                  anyRecovered = true;
                } else if (now() < recoveryDeadline) {
                  const combinedRes = await createCartFn(
                    g.store_domain,
                    goodLines.map((l) => ({ variant_id: l.variant_id, quantity: 1 })),
                    { noRetry: true },
                  );
                  if (isCartOk(combinedRes)) {
                    recoveredCart = { res: combinedRes, lines: goodLines };
                    anyRecovered = true;
                  } else if (bestCart) {
                    const bestIds = new Set(bestCart.lines.map((l) => l.variant_id));
                    const reason = reasonFromCartError(combinedRes);
                    for (const l of goodLines) {
                      if (!bestIds.has(l.variant_id)) {
                        extraNotAdded.push({ ...l, reason });
                      }
                    }
                    recoveredCart = bestCart;
                    anyRecovered = true;
                  }
                } else if (bestCart) {
                  anyRecoveryTimedOut = true;
                  const bestIds = new Set(bestCart.lines.map((l) => l.variant_id));
                  for (const l of goodLines) {
                    if (!bestIds.has(l.variant_id)) {
                      extraNotAdded.push({
                        ...l,
                        reason: 'the store did not answer; try again in a moment',
                      });
                    }
                  }
                  recoveredCart = bestCart;
                  anyRecovered = true;
                }
              }
            } else if (!recoveredCart && activeAdded.length > 0) {
              if (now() >= recoveryDeadline) {
                anyRecoveryTimedOut = true;
              }
              const reason = reasonFromCartError(lastRes);
              for (const line of activeAdded) {
                extraNotAdded.push({ ...line, reason });
              }
            }

            if (!recoveredCart) {
              return {
                store: g.store,
                store_domain: g.store_domain,
                cart_id: null,
                continue_url: null,
                total_usd: null,
                added: [],
                not_added: [...g.not_added, ...extraNotAdded],
                ms: Math.max(0, now() - storeStart),
              };
            }

            cartRes = recoveredCart.res;
            activeAdded = recoveredCart.lines;
          }

          const finalAdded: BagLineAdded[] = [...activeAdded];
          const finalNotAdded: BagLineNotAdded[] = [...g.not_added, ...extraNotAdded];
          const flaggedReasons = new Map<number, string>();

          for (const msg of cartRes.messages ?? []) {
            if (!isLineBlockingMessage(msg)) continue;
            const text = extractMessageText(msg);
            const indices = findFlaggedLineIndices(msg, finalAdded, cartRes.line_items ?? []);
            for (const idx of indices) {
              if (!flaggedReasons.has(idx)) {
                flaggedReasons.set(idx, text);
              }
            }
          }

          if (flaggedReasons.size > 0) {
            const kept: BagLineAdded[] = [];
            finalAdded.forEach((line, idx) => {
              const reason = flaggedReasons.get(idx);
              if (reason) {
                finalNotAdded.push({ ...line, reason });
              } else {
                kept.push(line);
              }
            });
            return {
              store: g.store,
              store_domain: g.store_domain,
              cart_id: cartRes.cart_id,
              continue_url: cartRes.continue_url,
              total_usd: cartRes.total_usd,
              added: kept,
              not_added: finalNotAdded,
              ms: Math.max(0, now() - storeStart),
            };
          }

          return {
            store: g.store,
            store_domain: g.store_domain,
            cart_id: cartRes.cart_id,
            continue_url: cartRes.continue_url,
            total_usd: cartRes.total_usd,
            added: finalAdded,
            not_added: finalNotAdded,
            ms: Math.max(0, now() - storeStart),
          };
        }),
      );

      const rawTotal = carts.reduce(
        (sum, c) =>
          sum + (typeof c.total_usd === 'number' && Number.isFinite(c.total_usd) ? c.total_usd : 0),
        0,
      );
      const total_usd = Math.round(rawTotal * 100) / 100;

      const parts: string[] = [];
      for (const cart of carts) {
        if (cart.added.length > 0) {
          const priceStr =
            cart.total_usd !== null ? `$${cart.total_usd.toFixed(2)}` : 'total pending';
          parts.push(`${cart.store}: ${cart.added.length} added, ${priceStr}.`);
        }
        for (const item of cart.added) {
          const line = item as BagLineAdded;
          if (line.size_converted && line.size && line.asked_size) {
            parts.push(
              `${line.title ?? line.variant_id} went in as ${formatConvertedDisplaySize(line)} (you said ${line.asked_size}).`,
            );
          }
          if (line.note) {
            parts.push(`${line.title ?? line.variant_id}: ${line.note}.`);
          }
        }
        for (const item of cart.not_added) {
          parts.push(`${item.title ?? item.variant_id}: ${item.reason}.`);
        }
      }

      if (anyRecoveryTimedOut) {
        parts.push('Cart recovery hit the 4s time limit.');
      } else if (anyRecovered) {
        parts.push('Recovered the cart after dropping the unavailable item.');
      }

      const linksReady = carts.filter((c) => Boolean(c.continue_url)).length;
      parts.push(`${linksReady} checkout ${linksReady === 1 ? 'link' : 'links'} ready.`);
      const summary = parts.join(' ');

      const totalAdded = carts.reduce((n, c) => n + c.added.length, 0);
      const totalNotAdded = carts.reduce((n, c) => n + c.not_added.length, 0);
      const reasons = carts.flatMap((c) => c.not_added.map((x) => x.reason));
      const ms = Math.max(0, now() - t0);
      console.log(
        `[store] bag ${pieces.length} pieces added=${totalAdded} not_added=${totalNotAdded} carts=${linksReady} total=$${total_usd.toFixed(2)} ${ms}ms`,
      );
      logEvent('store_bag', {
        added: totalAdded,
        not_added: totalNotAdded,
        missing_sizes: 0,
        carts: linksReady,
        total_usd,
        ms,
        reasons,
      });

      return { carts, summary, total_usd };
    } catch {
      const ms = Math.max(0, now() - t0);
      console.log(`[store] bag error ${ms}ms`);
      logEvent('store_bag', {
        added: 0,
        not_added: Array.isArray(outfit?.pieces) ? outfit.pieces.length : 0,
        missing_sizes: 0,
        carts: 0,
        total_usd: 0,
        ms,
        reasons: ['bag error'],
      });
      return {
        carts: [],
        summary: 'Could not build the shopping bag right now. 0 checkout links ready.',
        total_usd: 0,
      };
    }
  }

  return { addToBag };
}

const defaultBag = createBag();

export const addToBag = defaultBag.addToBag;
