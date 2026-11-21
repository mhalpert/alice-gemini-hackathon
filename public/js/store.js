// Alice Store — renders the storefront and exposes synchronous page-action handlers.

// Every nav item does something: the departments switch the boutique, the others jump to a section.
const NAV_ITEMS = [
  'Women',
  'Men',
  'Occasions',
  'Looks by Alice',
  'Stores',
];

const COUNT_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];

const RENDER_KINDS = ['studio', 'scene', 'video'];
const RENDER_PRIORITY = ['video', 'scene', 'studio'];

const RENDER_CAPTIONS = {
  studio: 'On you',
  scene: 'On you, on location',
  video: 'On you, in motion',
};

const RENDER_LABELS = {
  studio: 'Studio',
  scene: 'On location',
  video: 'In motion',
};

function normalizeRenderKind(raw) {
  if (typeof raw !== 'string') return 'studio';
  const trimmed = raw.trim().toLowerCase();
  return RENDER_KINDS.includes(trimmed) ? trimmed : 'studio';
}

// Shared Shopify image sizing helper — always use this for store CDN URLs
function sized(url, width) {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}width=${width}`;
}

// Stage images may be Shopify URLs (demo mode) or generated media URLs (live mode)
function stageUrl(url, width) {
  if (!url || typeof url !== 'string') return '';
  if (url.includes('cdn.shopify.com')) return sized(url, width);
  return url;
}

// Build a download filename for the active try-on render on the stage
function renderDownloadFilename(outfitNumber, kind, url) {
  const safeNum = Number.isFinite(Number(outfitNumber)) ? outfitNumber : 1;
  const fallbackExt = kind === 'video' ? 'mp4' : 'jpg';
  const allowedExts =
    kind === 'video'
      ? new Set(['mp4', 'webm', 'mov', 'm4v'])
      : new Set(['jpg', 'jpeg', 'png', 'webp', 'avif']);
  let ext = fallbackExt;
  try {
    const pathname = new URL(url, window.location.origin).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) {
      const candidate = match[1].toLowerCase();
      if (allowedExts.has(candidate)) {
        ext = candidate === 'jpeg' ? 'jpg' : candidate;
      }
    }
  } catch {
    // Keep the default extension when the URL cannot be parsed
  }
  return `alice-look-${safeNum}-${kind}.${ext}`;
}

function safeExternalUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

function safeOptionalUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  return safeExternalUrl(url);
}

function formatPrice(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return '$0';
  return Number.isInteger(num) ? `$${num}` : `$${num.toFixed(2)}`;
}

// Format a price only when a valid numeric value is present; missing values return null
function formatOptionalPrice(amount) {
  if (typeof amount === 'number' && Number.isFinite(amount)) {
    return formatPrice(amount);
  }
  if (typeof amount === 'string') {
    const clean = amount.trim();
    if (!clean) return null;
    const num = Number(clean);
    if (Number.isFinite(num)) return formatPrice(num);
  }
  return null;
}

function formatSlot(slot) {
  if (!slot || typeof slot !== 'string') return 'Piece';
  return slot.charAt(0).toUpperCase() + slot.slice(1).toLowerCase();
}

// Validate normalized [x, y, w, h] flat-lay boxes (fractions from 0 to 1, positive size)
function normalizeBoxes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let count = 0;
  for (const [rawSlot, coords] of Object.entries(raw)) {
    const slot = typeof rawSlot === 'string' ? rawSlot.trim() : '';
    if (!slot || !Array.isArray(coords) || coords.length !== 4) continue;
    const [x, y, w, h] = coords;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(w) ||
      !Number.isFinite(h)
    ) {
      continue;
    }
    if (x < 0 || x >= 1 || y < 0 || y >= 1 || w <= 0 || w > 1 || h <= 0 || h > 1) {
      continue;
    }
    const clampedW = Math.min(w, 1 - x);
    const clampedH = Math.min(h, 1 - y);
    if (clampedW <= 0 || clampedH <= 0) continue;
    out[slot] = [x, y, clampedW, clampedH];
    count += 1;
  }
  return count > 0 ? out : null;
}

function getBoxForSlot(boxes, slot, occurrence = 1) {
  if (!boxes || !slot) return null;
  const occ = Number.isInteger(occurrence) && occurrence >= 1 ? occurrence : 1;
  const key = occ > 1 ? `${slot}#${occ}` : slot;
  if (boxes[key]) return boxes[key];
  const lower = key.toLowerCase();
  if (boxes[lower]) return boxes[lower];
  for (const [boxKey, val] of Object.entries(boxes)) {
    if (boxKey.toLowerCase() === lower) return val;
  }
  return null;
}

// Parse "slot" or "slot#N" into a slot name and optional explicit 1-based occurrence
function parseHighlightPiece(rawPiece) {
  if (typeof rawPiece !== 'string') return { slot: null, explicitOccurrence: null, hasHash: false };
  const trimmed = rawPiece.trim();
  if (!trimmed) return { slot: null, explicitOccurrence: null, hasHash: false };
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx === -1) {
    return { slot: trimmed, explicitOccurrence: null, hasHash: false };
  }
  const slot = trimmed.slice(0, hashIdx).trim();
  if (!slot) return { slot: null, explicitOccurrence: null, hasHash: false };
  const occText = trimmed.slice(hashIdx + 1).trim();
  const parsed = /^\d+$/.test(occText) ? Number(occText) : NaN;
  return {
    slot,
    explicitOccurrence: Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null,
    hasHash: true,
  };
}

function countSlotPieces(look, slot) {
  if (!look || !Array.isArray(look.pieces) || !slot) return 0;
  let count = 0;
  for (const piece of look.pieces) {
    if (piece && piece.slot === slot) count += 1;
  }
  return count;
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function isPhoneViewport() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 640px)').matches
  );
}

function pieceIdentity(piece) {
  const item = piece && typeof piece === 'object' ? piece.item : null;
  if (!item || typeof item !== 'object') return '';
  if (item.id !== null && item.id !== undefined && String(item.id).trim()) return `id:${item.id}`;
  if (item.variant_id !== null && item.variant_id !== undefined && String(item.variant_id).trim()) {
    return `v:${item.variant_id}`;
  }
  if (typeof item.url === 'string' && item.url.trim()) return `u:${item.url.trim()}`;
  return `t:${item.title || ''}|p:${item.price ?? ''}`;
}

function canSwapInPlace(oldLook, newLook) {
  if (!oldLook || !newLook) return false;
  const oldPieces = Array.isArray(oldLook.pieces) ? oldLook.pieces : [];
  const newPieces = Array.isArray(newLook.pieces) ? newLook.pieces : [];
  if (oldPieces.length === 0 || oldPieces.length !== newPieces.length) return false;
  for (let i = 0; i < oldPieces.length; i += 1) {
    if ((oldPieces[i]?.slot || '') !== (newPieces[i]?.slot || '')) return false;
  }
  return true;
}

// Identify replaced piece indices using explicit slot when given, otherwise by comparing item ids
function findSwappedIndices(oldLook, newLook, rawSlot) {
  const oldPieces = Array.isArray(oldLook?.pieces) ? oldLook.pieces : [];
  const newPieces = Array.isArray(newLook?.pieces) ? newLook.pieces : [];
  const parsed = parseHighlightPiece(rawSlot);

  if (parsed.slot) {
    const matching = [];
    let occ = 0;
    for (let i = 0; i < newPieces.length; i += 1) {
      if (newPieces[i]?.slot === parsed.slot) {
        occ += 1;
        if (parsed.explicitOccurrence !== null) {
          if (occ === parsed.explicitOccurrence) return [i];
        } else {
          matching.push(i);
        }
      }
    }
    if (matching.length === 1) return matching;
    if (matching.length > 1) {
      const changed = matching.filter((i) => pieceIdentity(oldPieces[i]) !== pieceIdentity(newPieces[i]));
      return changed.length > 0 ? changed : [matching[0]];
    }
  }

  const changed = [];
  const len = Math.min(oldPieces.length, newPieces.length);
  for (let i = 0; i < len; i += 1) {
    if (pieceIdentity(oldPieces[i]) !== pieceIdentity(newPieces[i])) {
      changed.push(i);
    }
  }
  return changed;
}

// Resolve up to 8 flat-lay boxes in the look's piece order; returns null when none or more than 8
function collectOrderedBoxes(look, boxes) {
  if (!boxes || typeof boxes !== 'object') return null;
  const allEntries = Object.entries(boxes);
  if (allEntries.length === 0 || allEntries.length > 8) return null;

  const ordered = [];
  const usedBoxes = new Set();
  const slotCounts = new Map();

  for (const piece of Array.isArray(look?.pieces) ? look.pieces : []) {
    const slot = piece?.slot || '';
    if (!slot) continue;
    const occ = (slotCounts.get(slot) || 0) + 1;
    slotCounts.set(slot, occ);
    const box = getBoxForSlot(boxes, slot, occ);
    if (box && !usedBoxes.has(box)) {
      usedBoxes.add(box);
      ordered.push(box);
    }
  }

  for (const [, box] of allEntries) {
    if (box && !usedBoxes.has(box)) {
      usedBoxes.add(box);
      ordered.push(box);
    }
  }

  return ordered.length > 0 && ordered.length <= 8 ? ordered : null;
}

// Bring an active note row into view inside its own scrolling list without moving the window
function scrollRowIntoList(listEl, rowEl) {
  if (!listEl || !rowEl) return;
  if (listEl.scrollHeight <= listEl.clientHeight + 1) return;
  const listRect = listEl.getBoundingClientRect();
  const rowRect = rowEl.getBoundingClientRect();
  const pad = 8;
  let nextTop = listEl.scrollTop;
  if (rowRect.top < listRect.top + pad) {
    nextTop += rowRect.top - listRect.top - pad;
  } else if (rowRect.bottom > listRect.bottom - pad) {
    nextTop += rowRect.bottom - listRect.bottom + pad;
  } else {
    return;
  }
  listEl.scrollTo({
    top: Math.max(0, nextTop),
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
}

// Cut plain text at maxLen characters on a word boundary
function truncateAtWord(text, maxLen = 700) {
  if (typeof text !== 'string') return '';
  const clean = text.trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  if (clean.charAt(maxLen) === ' ') return `${cut.trimEnd()}…`;
  const lastSpace = cut.lastIndexOf(' ');
  const bounded = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${bounded.trimEnd()}…`;
}

function itemMatches(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  if (a.variant_id && b.variant_id && a.variant_id === b.variant_id) return true;
  if (a.url && b.url && a.url === b.url) return true;
  return false;
}

function parseSubtitleMeta(subtitle, payload) {
  const raw = typeof subtitle === 'string' ? subtitle.trim() : '';
  let occasion = '';
  let budget = null;

  if (payload && typeof payload.occasion === 'string' && payload.occasion.trim()) {
    occasion = payload.occasion.trim();
  } else if (payload && payload.brief && typeof payload.brief.occasion === 'string') {
    occasion = payload.brief.occasion.trim();
  }

  if (payload && Number.isFinite(Number(payload.budget_usd))) {
    budget = Number(payload.budget_usd);
  } else if (payload && payload.brief && Number.isFinite(Number(payload.brief.budget_usd))) {
    budget = Number(payload.brief.budget_usd);
  }

  let cleanSubtitle = raw;
  if (raw) {
    // Allow optional "occasion · $150 budget" convention inside subtitle
    const parts = raw.split(/\s*[·|]\s*/);
    const kept = [];
    for (const part of parts) {
      const budgetMatch = part.match(/^\s*(?:under\s+|budget\s*)?\$(\d+(?:\.\d{1,2})?)\s*(?:budget)?\s*$/i);
      if (budgetMatch) {
        if (budget === null) budget = Number(budgetMatch[1]);
      } else if (part.trim()) {
        kept.push(part.trim());
      }
    }
    cleanSubtitle = kept.join(' · ') || raw;

    if (!occasion) {
      occasion = cleanSubtitle.replace(/^(?:one|two|three|\d+)\s+looks?\s+for\s+/i, '').trim();
    }
  }

  return { raw, cleanSubtitle, occasion, budget };
}

function buildCollectionTitle(count, meta) {
  const word = COUNT_WORDS[count] || String(count);
  const noun = count === 1 ? 'look' : 'looks';
  if (!meta.cleanSubtitle) {
    return `${word} ${noun} by Alice`;
  }
  if (/^(?:one|two|three|\d+)\s+looks?\b/i.test(meta.cleanSubtitle)) {
    return meta.cleanSubtitle;
  }
  return `${word} ${noun} for ${meta.cleanSubtitle}`;
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, val] of Object.entries(attrs)) {
      if (val === null || val === undefined || val === false) continue;
      if (key === 'className') node.className = val;
      else if (key === 'textContent') node.textContent = val;
      else if (key === 'dataset') {
        for (const [dk, dv] of Object.entries(val)) {
          if (dv !== null && dv !== undefined) node.dataset[dk] = String(dv);
        }
      } else if (key.startsWith('on') && typeof val === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (val === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(val));
      }
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function svgIcon(viewBox, paths, className) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  for (const spec of paths) {
    const child = document.createElementNS(ns, spec.tag);
    for (const [k, v] of Object.entries(spec)) {
      if (k !== 'tag') child.setAttribute(k, v);
    }
    svg.appendChild(child);
  }
  return svg;
}

function searchSvg() {
  return svgIcon('0 0 24 24', [
    { tag: 'circle', cx: '11', cy: '11', r: '7' },
    { tag: 'line', x1: '16.5', y1: '16.5', x2: '21', y2: '21' },
  ]);
}

function bagSvg() {
  return svgIcon('0 0 24 24', [
    { tag: 'path', d: 'M6 8h12l-1 12H7L6 8z' },
    { tag: 'path', d: 'M9 8V6a3 3 0 0 1 6 0v2' },
  ]);
}

function arrowLeftSvg() {
  return svgIcon('0 0 24 24', [
    { tag: 'line', x1: '19', y1: '12', x2: '5', y2: '12' },
    { tag: 'polyline', points: '11 6 5 12 11 18' },
  ]);
}

function starSvg() {
  return svgIcon(
    '0 0 24 24',
    [{ tag: 'polygon', points: '12 2.5 14.9 8.6 21.6 9.5 16.7 14.2 17.9 20.9 12 17.7 6.1 20.9 7.3 14.2 2.4 9.5 9.1 8.6 12 2.5' }],
    'product-rating-star'
  );
}

function closeSvg() {
  return svgIcon('0 0 24 24', [
    { tag: 'line', x1: '6', y1: '6', x2: '18', y2: '18' },
    { tag: 'line', x1: '18', y1: '6', x2: '6', y2: '18' },
  ]);
}

const BOUTIQUE_FETCH_TIMEOUT_MS = 4000;
const BAG_FETCH_TIMEOUT_MS = 20000;

// Fetch JSON from same-origin store routes with a hard timeout; returns null on any failure
async function fetchJson(url, { timeoutMs = BOUTIQUE_FETCH_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) return null;
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Deduplicate and trim a list of size labels while preserving order
function normalizeSizeList(rawSizes) {
  if (!Array.isArray(rawSizes)) return [];
  const seen = new Set();
  const out = [];
  for (const s of rawSizes) {
    const clean = typeof s === 'string' || typeof s === 'number' ? String(s).trim() : '';
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out;
}

function computePiecesTotal(pieces) {
  let sum = 0;
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    const price = Number(piece?.item?.price);
    if (Number.isFinite(price)) sum += price;
  }
  return Math.round(sum * 100) / 100;
}

// Post a direct bag request to /api/bag; returns a bagReady payload on 200 or null when unavailable
async function postBag(
  { department, outfit, sizes },
  { timeoutMs = BAG_FETCH_TIMEOUT_MS, signal } = {}
) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) return null;
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('/api/bag', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ department, outfit, sizes }),
      signal: controller.signal,
    });
    if (res.status !== 200) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object' || !Array.isArray(data.stores)) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Normalize /api/occasions rows, dropping missing or duplicate keys while keeping server order
function normalizeOccasions(data) {
  if (!data || !Array.isArray(data.occasions)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of data.occasions) {
    // A plain string is an occasion whose text is also its key
    const entry =
      typeof raw === 'string' ? { key: raw, label: raw.charAt(0).toUpperCase() + raw.slice(1) } : raw;
    if (!entry || typeof entry !== 'object') continue;
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    const label =
      typeof entry.label === 'string' && entry.label.trim()
        ? entry.label.trim()
        : typeof entry.occasion === 'string'
          ? entry.occasion.trim()
          : '';
    if (!key || !label || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label });
  }
  return out;
}

const OCCASION_MENU_MAX = 15;
const OCCASION_QUERY_MAX_LEN = 120;
const OCCASION_STATIC_PLACEHOLDER = 'Search an occasion';
const OCCASION_SEARCH_PLACEHOLDERS = [
  'rooftop birthday…',
  'beach wedding in Capri…',
  'black tie gala…',
  'first date…',
];

// Normalize /api/occasions menu entries, falling back to the first 15 occasions when menu is missing or empty
function normalizeOccasionMenu(data) {
  if (data && Array.isArray(data.menu)) {
    const seen = new Set();
    const out = [];
    for (const raw of data.menu) {
      if (!raw || typeof raw !== 'object') continue;
      const key = typeof raw.key === 'string' ? raw.key.trim() : '';
      const label =
        typeof raw.keyword === 'string' && raw.keyword.trim()
          ? raw.keyword.trim()
          : typeof raw.label === 'string'
            ? raw.label.trim()
            : '';
      if (!key || !label || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label });
      if (out.length >= OCCASION_MENU_MAX) break;
    }
    if (out.length > 0) return out;
  }
  return normalizeOccasions(data).slice(0, OCCASION_MENU_MAX);
}

// Renders the shop into `root` (the #store element) and returns the page-action handlers.
export function mountStore(root, { onTalk, isLive, tellAlice } = {}) {
  if (!root || !(root instanceof HTMLElement)) {
    throw new Error('mountStore requires a valid DOM container');
  }

  function triggerTalk() {
    if (typeof onTalk === 'function') onTalk();
  }

  // Single state object for the entire shop view
  const state = {
    view: 'boutique', // 'empty' | 'boutique' | 'looks' | 'picked' | 'search'
    outfits: new Map(), // look number -> Outfit
    media: new Map(), // look number -> { tryOnStatus, tryOnUrl, renders, activeRender, userPickedRender, autoAdvancedKinds, newRenderTags, videoPreload, videoFailed, failedUrls, collageUrl, collageBoxes, revealed, stageSwapped, preloads }
    subtitleMeta: { raw: '', cleanSubtitle: '', occasion: '', budget: null },
    pickedOutfit: null,
    highlightedSlot: null,
    highlightedOccurrence: null,
    bagCount: 0,
    bagData: null,
    bagOpen: false,
    bagOpenedStores: new Set(),
    directBag: null, // { department, name, number?, entries: [{ piece, size }], sizes }
    drawerMode: 'bag', // 'bag' | 'review' | 'result'
    orderReview: null,
    orderConfirmedId: null,
    orderResult: null,
    productOpen: false,
    lastSearch: null,
    searchFromBoutique: false,
  };

  // Remembered sizes per slot across looks and direct-bag request guards
  const lastSizesBySlot = new Map();
  const productSelectedSizes = new Map();
  let directBagReqId = 0;
  let bagAbortController = null;
  let directBagBusy = false;
  const liveRemoveTimers = new Set();

  function isCallLive() {
    return typeof isLive === 'function' ? Boolean(isLive()) : document.body.classList.contains('call-live');
  }

  function sendToAlice(text) {
    if (typeof tellAlice === 'function') return tellAlice(text);
    return Promise.resolve(false);
  }

  function clearLiveRemoveTimers() {
    for (const timerId of liveRemoveTimers) {
      clearTimeout(timerId);
    }
    liveRemoveTimers.clear();
  }

  function rememberSlotSize(slot, size) {
    const key = typeof slot === 'string' ? slot.trim().toLowerCase() : '';
    const val = typeof size === 'string' ? size.trim() : '';
    if (key && val) lastSizesBySlot.set(key, val);
  }

  function getRememberedSlotSize(slot) {
    const key = typeof slot === 'string' ? slot.trim().toLowerCase() : '';
    return key ? lastSizesBySlot.get(key) || '' : '';
  }

  function resolveBagDepartment(pieces) {
    for (const piece of Array.isArray(pieces) ? pieces : []) {
      const dept = piece?.item?.department;
      if (dept === 'men' || dept === 'women') return dept;
    }
    return boutique.department === 'men' ? 'men' : 'women';
  }

  function buildBagSizesMap(entries) {
    const sizes = {};
    for (const entry of entries) {
      const slot = typeof entry?.piece?.slot === 'string' ? entry.piece.slot.trim() : '';
      const size = typeof entry?.size === 'string' ? entry.size.trim() : '';
      if (slot && size) sizes[slot] = size;
    }
    return sizes;
  }

  function resolveProductBagSlot(baseSlot, existingEntries) {
    const raw = typeof baseSlot === 'string' && baseSlot.trim() ? baseSlot.trim() : 'piece';
    const used = new Set(
      (Array.isArray(existingEntries) ? existingEntries : []).map((e) =>
        typeof e?.piece?.slot === 'string' ? e.piece.slot.trim().toLowerCase() : ''
      )
    );
    if (!used.has(raw.toLowerCase())) return raw;
    let suffix = 2;
    while (used.has(`${raw}-${suffix}`.toLowerCase())) suffix += 1;
    return `${raw}-${suffix}`;
  }

  function buildBagOutfitPayload(entries, { name = '', number = null, total = null } = {}) {
    const pieces = entries.map((entry) => ({
      slot: typeof entry.piece.slot === 'string' ? entry.piece.slot : '',
      ...(entry.piece.why ? { why: entry.piece.why } : {}),
      item: entry.piece.item,
    }));
    const outfit = {
      name:
        typeof name === 'string' && name.trim()
          ? name.trim()
          : typeof number === 'number' && Number.isFinite(number)
            ? `Look ${number}`
            : 'Your bag',
      pieces,
      total:
        typeof total === 'number' && Number.isFinite(total)
          ? total
          : computePiecesTotal(pieces),
    };
    if (typeof number === 'number' && Number.isFinite(number)) {
      outfit.number = number;
    }
    return outfit;
  }

  function renderBagFallbackInto(containerEl, message) {
    containerEl.hidden = false;
    containerEl.replaceChildren(
      `${message} `,
      el(
        'button',
        {
          type: 'button',
          className: 'bag-fallback-talk-btn',
          onClick: () => triggerTalk(),
        },
        'Talk to Alice'
      )
    );
  }

  function findDirectBagEntryIndex(entries, line, storeName) {
    if (!Array.isArray(entries) || entries.length === 0) return -1;
    const lineTitle = typeof line?.title === 'string' ? line.title.trim().toLowerCase() : '';
    const lineStore = typeof storeName === 'string' ? storeName.trim().toLowerCase() : '';
    const lineSize = typeof line?.size === 'string' ? line.size.trim().toLowerCase() : '';
    const linePrice = Number(line?.price);
    const lineImage = typeof line?.image === 'string' ? line.image.trim() : '';

    const sizeMatches = (entry) =>
      !lineSize || (typeof entry?.size === 'string' && entry.size.trim().toLowerCase() === lineSize);
    const storeMatches = (entry) =>
      !lineStore ||
      (typeof entry?.piece?.item?.store === 'string' &&
        entry.piece.item.store.trim().toLowerCase() === lineStore);
    const titleMatches = (entry) =>
      Boolean(lineTitle) &&
      typeof entry?.piece?.item?.title === 'string' &&
      entry.piece.item.title.trim().toLowerCase() === lineTitle;

    let idx = entries.findIndex((e) => itemMatches(e?.piece?.item, line) && sizeMatches(e));
    if (idx !== -1) return idx;
    idx = entries.findIndex((e) => itemMatches(e?.piece?.item, line));
    if (idx !== -1) return idx;
    idx = entries.findIndex((e) => titleMatches(e) && storeMatches(e) && sizeMatches(e));
    if (idx !== -1) return idx;
    idx = entries.findIndex((e) => titleMatches(e) && storeMatches(e));
    if (idx !== -1) return idx;
    if (Number.isFinite(linePrice)) {
      idx = entries.findIndex((e) => titleMatches(e) && Number(e?.piece?.item?.price) === linePrice);
      if (idx !== -1) return idx;
    }
    idx = entries.findIndex((e) => titleMatches(e));
    if (idx !== -1) return idx;
    if (lineImage) {
      idx = entries.findIndex((e) => e?.piece?.item?.image === lineImage);
      if (idx !== -1) return idx;
    }
    return entries.length === 1 ? 0 : -1;
  }

  async function removeBagLine(line, storeName, rowEl, removeBtn, noteEl) {
    if (isCallLive()) {
      if (removeBtn.disabled) return;
      const title =
        typeof line?.title === 'string' && line.title.trim() ? line.title.trim() : 'item';
      removeBtn.disabled = true;
      removeBtn.textContent = 'Removing…';
      rowEl.classList.add('is-removing');
      const restore = () => {
        rowEl.classList.remove('is-removing');
        removeBtn.disabled = false;
        removeBtn.textContent = 'Remove';
      };
      const timerId = setTimeout(() => {
        liveRemoveTimers.delete(timerId);
        restore();
      }, 15000);
      liveRemoveTimers.add(timerId);
      try {
        const sent = await sendToAlice(`Remove the ${title} from my bag.`);
        if (sent === false) {
          clearTimeout(timerId);
          liveRemoveTimers.delete(timerId);
          restore();
        }
      } catch {
        clearTimeout(timerId);
        liveRemoveTimers.delete(timerId);
        restore();
      }
      return;
    }

    if (!state.directBag || !Array.isArray(state.directBag.entries)) {
      if (noteEl) {
        renderBagFallbackInto(noteEl, 'Talk to Alice to change this bag.');
      }
      return;
    }

    if (directBagBusy) return;
    const matchIdx = findDirectBagEntryIndex(state.directBag.entries, line, storeName);
    if (matchIdx === -1) return;

    const remainingEntries = state.directBag.entries.filter((_, idx) => idx !== matchIdx);
    if (remainingEntries.length === 0) {
      if (bagAbortController) {
        bagAbortController.abort();
        bagAbortController = null;
      }
      directBagReqId += 1;
      state.directBag = null;
      applyBagReady({ stores: [], links: [], total: 0 }, { fromAlice: false });
      return;
    }

    const department = state.directBag.department;
    const outfit = buildBagOutfitPayload(remainingEntries, {
      name: state.directBag.name,
      number: state.directBag.number,
    });
    const sizes = buildBagSizesMap(remainingEntries);

    if (bagAbortController) bagAbortController.abort();
    const controller = new AbortController();
    bagAbortController = controller;
    const reqId = ++directBagReqId;

    directBagBusy = true;
    removeBtn.disabled = true;
    removeBtn.textContent = 'Removing…';
    rowEl.classList.add('is-removing');

    let data = null;
    try {
      data = await postBag({ department, outfit, sizes }, { signal: controller.signal });
    } finally {
      if (reqId === directBagReqId) {
        directBagBusy = false;
        bagAbortController = null;
      }
    }

    if (reqId !== directBagReqId) return;

    if (!data) {
      rowEl.classList.remove('is-removing');
      removeBtn.disabled = false;
      removeBtn.textContent = 'Remove';
      return;
    }

    state.directBag = {
      department,
      name: outfit.name,
      number: outfit.number,
      entries: remainingEntries,
      sizes,
    };
    applyBagReady(data, { fromAlice: false });
  }

  // Boutique storefront state (kept separate from live-call outfits)
  const boutique = {
    department: 'women', // 'women' | 'men'
    looks: [],
    sections: [],
    occasions: [],
    selectedOccasion: null, // null for all looks, or { key, label }
    occasionQuery: '',
    occasionMatchStatus: null, // null | { kind: 'matched', label } | { kind: 'empty' }
    occasionMatchPending: false,
    occasionMatchReqId: 0,
    occasionMatchAbortController: null,
    looksPending: false,
    storefrontPending: false,
    reqId: 0,
    abortController: null,
    looksReqId: 0,
    looksAbortController: null,
  };

  // Header search and product detail request guards
  let searchBarOpen = false;
  let searchReqId = 0;
  let searchAbortController = null;
  let productReqId = 0;
  let productAbortController = null;

  // Live DOM slot refs while the boutique view is mounted
  let boutiqueRefs = null;
  let occasionPlaceholderTimer = null;

  // Optional hint set during local product-card clicks so multi-look items keep their look number
  let pendingProductOutfit = null;

  function getMedia(num) {
    if (!state.media.has(num)) {
      state.media.set(num, {
        tryOnStatus: null,
        tryOnUrl: null,
        renders: { studio: null, scene: null, video: null },
        activeRender: null,
        userPickedRender: false,
        autoAdvancedKinds: new Set(),
        newRenderTags: new Map(),
        videoPreload: null,
        videoFailed: false,
        failedUrls: new Set(),
        collageUrl: null,
        collageBoxes: null,
        revealed: false,
        stageSwapped: false,
        preloads: [],
      });
    }
    return state.media.get(num);
  }

  function hasAnyRender(media) {
    return Boolean(media && (media.renders.studio || media.renders.scene || media.renders.video));
  }

  function availableRenderKinds(media) {
    if (!media) return [];
    return RENDER_KINDS.filter(
      (kind) => Boolean(media.renders[kind]) && !(kind === 'video' && media.videoFailed)
    );
  }

  function pickRenderKind(media, preferredKind = null, { exclude = null } = {}) {
    if (!media) return null;
    const isUsable = (kind) =>
      Boolean(kind && kind !== exclude && media.renders[kind]) &&
      !(kind === 'video' && media.videoFailed);
    if (isUsable(preferredKind)) return preferredKind;
    for (const kind of RENDER_PRIORITY) {
      if (isUsable(kind)) return kind;
    }
    return null;
  }

  function preloadImage(media, url) {
    if (!url) return;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    media.preloads.push(img);
    if (media.preloads.length > 4) media.preloads.shift();
  }

  // Pause and clear a <video> element so it stops decoding and drops buffered data
  function releaseVideoElement(videoEl) {
    if (!videoEl) return;
    videoEl.dataset.activeSrc = '';
    videoEl.dataset.preloadUrl = '';
    try {
      videoEl.pause();
    } catch {
      // Ignore pause errors on detached or unloaded elements
    }
    videoEl.removeAttribute('src');
    try {
      videoEl.load();
    } catch {
      // Ignore load errors when media playback is unavailable
    }
  }

  // Preload a clip in a detached muted video element so playback can start right away on reveal
  function preloadVideo(media, url) {
    if (!url) return;
    if (media.videoPreload) {
      if (media.videoPreload.dataset.preloadUrl === url) return;
      releaseVideoElement(media.videoPreload);
      media.videoPreload = null;
    }
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('preload', 'auto');
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.dataset.preloadUrl = url;
    video.src = url;
    try {
      video.load();
    } catch {
      // Ignore environments without media preloading
    }
    media.videoPreload = video;
  }

  function clearLookRenders(media) {
    if (!media) return;
    media.tryOnUrl = null;
    media.renders = { studio: null, scene: null, video: null };
    media.activeRender = null;
    media.userPickedRender = false;
    media.autoAdvancedKinds.clear();
    media.videoFailed = false;
    media.failedUrls.clear();
    for (const timerId of media.newRenderTags.values()) {
      clearTimeout(timerId);
    }
    media.newRenderTags.clear();
    if (media.videoPreload) {
      releaseVideoElement(media.videoPreload);
      media.videoPreload = null;
    }
    media.preloads = [];
  }

  function markRenderNew(outfitNumber, media, kind) {
    const existingTimer = media.newRenderTags.get(kind);
    if (existingTimer) clearTimeout(existingTimer);
    const timerId = setTimeout(() => {
      media.newRenderTags.delete(kind);
      if (state.view === 'picked' && activePickedRefs && activePickedRefs.outfit === outfitNumber) {
        syncRenderStrip(activePickedRefs, media);
      }
    }, 4000);
    media.newRenderTags.set(kind, timerId);
  }

  function setHasProducts() {
    const wasSet = document.body.classList.contains('has-products');
    document.body.classList.add('has-products');
    if (!wasSet && typeof syncHeaderHeight === 'function') {
      syncHeaderHeight();
    }
  }

  // Contract helper for the bag drawer and product detail panel
  function setPanelOpen(isOpen) {
    document.body.classList.toggle('panel-open', Boolean(isOpen));
  }

  function syncPanelOpen() {
    setPanelOpen(state.productOpen || state.bagOpen);
  }

  function sortedOutfits() {
    return Array.from(state.outfits.values()).sort((a, b) => a.number - b.number);
  }

  function hasBoutiqueContent() {
    return (
      boutique.looks.length > 0 ||
      boutique.sections.length > 0 ||
      (boutique.selectedOccasion !== null && boutique.occasions.length > 0)
    );
  }

  function hasBoutiqueAvailable() {
    return hasBoutiqueContent() || boutique.looksPending || boutique.storefrontPending;
  }

  function syncBoutiqueBodyClass() {
    if (hasBoutiqueContent()) {
      document.body.classList.add('has-boutique');
    } else if (!boutique.looksPending && !boutique.storefrontPending) {
      document.body.classList.remove('has-boutique');
    }
  }

  // Build persistent store chrome
  const bagBadge = el('span', { className: 'bag-badge', hidden: true, 'aria-live': 'polite' }, '0');
  const navLinks = new Map();
  const navItems = new Map();

  // Collapsible header search bar
  const searchInputEl = el('input', {
    type: 'search',
    className: 'header-search-input',
    placeholder: 'Search Fashion Nova, Everlane, Steve Madden, Kith…',
    'aria-label': 'Search store',
    autocomplete: 'off',
    onKeydown: (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeHeaderSearch({ restoreFocus: true });
      }
    },
  });
  const searchStatusEl = el('span', { className: 'header-search-status', 'aria-live': 'polite', hidden: true }, 'Searching…');
  const searchFormEl = el(
    'form',
    {
      className: 'header-search-form',
      role: 'search',
      onSubmit: (e) => {
        e.preventDefault();
        runHeaderSearch();
      },
    },
    searchSvg(),
    searchInputEl,
    searchStatusEl,
    el(
      'button',
      {
        type: 'button',
        className: 'header-search-close',
        'aria-label': 'Close search',
        onClick: () => closeHeaderSearch({ restoreFocus: true }),
      },
      closeSvg()
    )
  );
  const headerSearchBarEl = el('div', { className: 'header-search-bar', hidden: true }, searchFormEl);

  const searchToggleBtn = el(
    'button',
    {
      type: 'button',
      className: 'icon-btn',
      'aria-label': 'Search',
      'aria-expanded': 'false',
      onClick: () => {
        if (searchBarOpen) {
          closeHeaderSearch();
        } else {
          openHeaderSearch();
        }
      },
    },
    searchSvg()
  );

  const headerEl = el(
    'header',
    { className: 'store-header' },
    el('div', { className: 'promo-bar' }, 'Styled live by Alice · real stores, real carts'),
    el(
      'div',
      { className: 'masthead' },
      el('div', { className: 'masthead-spacer', 'aria-hidden': 'true' }),
      el(
        'button',
        {
          type: 'button',
          className: 'wordmark',
          'aria-label': 'Alice home',
          onClick: () => {
            if (hasBoutiqueAvailable()) {
              showBoutique();
            } else if (state.outfits.size > 0) {
              handlers.showAll({});
            }
          },
        },
        'ALICE'
      ),
      el(
        'div',
        { className: 'masthead-actions' },
        searchToggleBtn,
        el(
          'button',
          {
            type: 'button',
            className: 'icon-btn',
            'aria-label': 'Shopping bag',
            onClick: () => {
              if (state.bagOpen) {
                closeBagDrawer();
              } else if (hasDrawerContent()) {
                openBagDrawer();
              }
            },
          },
          bagSvg(),
          bagBadge
        )
      )
    ),
    headerSearchBarEl,
    el(
      'nav',
      { className: 'store-nav', 'aria-label': 'Store navigation' },
      el(
        'ul',
        { className: 'store-nav-list' },
        NAV_ITEMS.map((label) => {
          if (label === 'Women' || label === 'Men') {
            const dept = label.toLowerCase();
            const btn = el(
              'button',
              {
                type: 'button',
                className: 'nav-link nav-link--btn',
                'aria-pressed': 'false',
                onClick: () => selectDepartment(dept),
              },
              label
            );
            navLinks.set(label, btn);
            return el('li', null, btn);
          }
          const link = el(
            'a',
            {
              href: '#',
              className: 'nav-link',
              onClick: (e) => {
                e.preventDefault();
                if (label === 'Occasions') {
                  scrollToBoutique('.boutique-occasions-section');
                } else if (label === 'Looks by Alice') {
                  // Alice's own looks from this call if there are any, otherwise the boutique's row of looks
                  if (state.outfits.size > 0) handlers.showAll({});
                  else scrollToBoutique('.boutique-looks-section');
                } else if (label === 'Stores') {
                  scrollToBoutique('.boutique-rail-section[data-section^="from-"]');
                }
              },
            },
            label
          );
          navLinks.set(label, link);
          const item = el('li', label === 'Occasions' ? { hidden: true } : null, link);
          navItems.set(label, item);
          return item;
        })
      )
    )
  );

  const mainEl = el('main', { className: 'store-main' });

  // Persistent mount slots for bag drawer, search view, and product panel
  const bagSlotEl = el('div', { id: 'store-bag-slot', dataset: { panel: 'bag' } });
  const searchSlotEl = el('div', { id: 'store-search-slot', dataset: { panel: 'search' }, hidden: true });
  const productSlotEl = el('div', { id: 'store-product-slot', dataset: { panel: 'product' } });

  const panelSlotsEl = el(
    'div',
    { className: 'store-panel-slots' },
    bagSlotEl,
    searchSlotEl,
    productSlotEl
  );

  const footerEl = el(
    'footer',
    { className: 'store-footer' },
    el(
      'div',
      { className: 'store-footer-inner' },
      el('span', { className: 'footer-brand' }, 'ALICE'),
      el('span', null, 'Curated live from partner stores · Checkout happens directly with each retailer')
    )
  );

  const shellEl = el('div', { className: 'store-shell' }, headerEl, mainEl, panelSlotsEl, footerEl);
  root.replaceChildren(shellEl);

  // Persistent slide-in shells for the product page and bag drawer
  const productBreadcrumbEl = el('div', { className: 'breadcrumb product-breadcrumb' });
  const productBodyEl = el('div', { className: 'panel-body product-panel-body' });
  const productLayerEl = el(
    'div',
    { className: 'panel-layer panel-layer--product', 'aria-hidden': 'true' },
    el('div', {
      className: 'panel-backdrop',
      onClick: () => handlers.hideProduct({}),
    }),
    el(
      'aside',
      {
        className: 'panel-sheet panel-sheet--product',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Product details',
      },
      el(
        'div',
        { className: 'panel-head product-panel-head' },
        productBreadcrumbEl,
        el(
          'button',
          {
            type: 'button',
            className: 'panel-close-btn',
            'aria-label': 'Close product details',
            onClick: () => handlers.hideProduct({}),
          },
          closeSvg()
        )
      ),
      productBodyEl
    )
  );
  productSlotEl.replaceChildren(productLayerEl);

  const bagTitleEl = el('h2', { className: 'bag-panel-title' }, 'Your bag');
  const bagBodyEl = el('div', { className: 'panel-body bag-panel-body' });
  const bagFooterEl = el('div', { className: 'panel-footer bag-panel-footer' });
  const bagSheetEl = el(
    'aside',
    {
      className: 'panel-sheet panel-sheet--bag',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Your bag',
    },
    el(
      'div',
      { className: 'panel-head bag-panel-head' },
      bagTitleEl,
      el(
        'button',
        {
          type: 'button',
          className: 'panel-close-btn',
          'aria-label': 'Close bag',
          dataset: { closeBag: 'true' },
          onClick: () => closeBagDrawer(),
        },
        closeSvg()
      )
    ),
    bagBodyEl,
    bagFooterEl
  );
  const bagLayerEl = el(
    'div',
    { className: 'panel-layer panel-layer--bag', 'aria-hidden': 'true' },
    el('div', {
      className: 'panel-backdrop',
      onClick: () => closeBagDrawer(),
    }),
    bagSheetEl
  );
  bagSlotEl.replaceChildren(bagLayerEl);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.productOpen) {
      handlers.hideProduct({});
    } else if (state.bagOpen) {
      closeBagDrawer();
    } else if (searchBarOpen) {
      closeHeaderSearch({ restoreFocus: true });
    }
  });

  function setSearchBusy(busy) {
    searchFormEl.classList.toggle('is-busy', busy);
    searchFormEl.setAttribute('aria-busy', busy ? 'true' : 'false');
    searchStatusEl.hidden = !busy;
  }

  function openHeaderSearch() {
    searchBarOpen = true;
    headerSearchBarEl.hidden = false;
    searchToggleBtn.setAttribute('aria-expanded', 'true');
    syncHeaderHeight();
    searchInputEl.focus();
    searchInputEl.select();
  }

  function closeHeaderSearch({ restoreFocus = false } = {}) {
    searchBarOpen = false;
    headerSearchBarEl.hidden = true;
    searchToggleBtn.setAttribute('aria-expanded', 'false');
    if (searchAbortController) {
      searchAbortController.abort();
      searchAbortController = null;
    }
    searchReqId += 1;
    setSearchBusy(false);
    syncHeaderHeight();
    if (restoreFocus) searchToggleBtn.focus();
  }

  async function runHeaderSearch() {
    const q = searchInputEl.value.trim();
    if (!q) return;

    if (searchAbortController) searchAbortController.abort();
    const controller = new AbortController();
    searchAbortController = controller;
    const reqId = ++searchReqId;
    setSearchBusy(true);

    const url = `/api/search?q=${encodeURIComponent(q)}&department=${encodeURIComponent(boutique.department)}`;
    const data = await fetchJson(url, { signal: controller.signal });

    if (reqId !== searchReqId) return;
    searchAbortController = null;
    setSearchBusy(false);

    if (!data || typeof data.query !== 'string' || !Array.isArray(data.items)) {
      return;
    }

    const isCallLive = document.body.classList.contains('call-live');
    openSearchFromPayload(data, { markProducts: isCallLive, fromBoutique: !isCallLive });
    closeHeaderSearch();
  }

  function syncHeaderHeight() {
    const h = headerEl.offsetHeight;
    if (h > 0) {
      document.documentElement.style.setProperty('--header-h', `${h}px`);
    }
  }
  syncHeaderHeight();
  window.addEventListener('resize', syncHeaderHeight, { passive: true });

  function updateNavActive() {
    if (state.view !== 'picked') {
      releaseStageVideo();
    }
    const looksLink = navLinks.get('Looks by Alice');
    if (looksLink) {
      const active = state.view === 'looks' || state.view === 'picked';
      looksLink.classList.toggle('is-active', active);
      if (active) looksLink.setAttribute('aria-current', 'page');
      else looksLink.removeAttribute('aria-current');
    }

    const boutiqueShown =
      state.view === 'boutique' &&
      (hasBoutiqueContent() || document.body.classList.contains('has-boutique'));
    for (const label of ['Women', 'Men']) {
      const btn = navLinks.get(label);
      if (!btn) continue;
      const active = boutiqueShown && boutique.department === label.toLowerCase();
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    const occasionsNavItem = navItems.get('Occasions');
    if (occasionsNavItem) {
      occasionsNavItem.hidden = boutique.occasions.length === 0 || !hasBoutiqueAvailable();
    }

    // "Stores" needs a store rail to jump to, and a short storefront reply may hold none
    const storesNavItem = navItems.get('Stores');
    if (storesNavItem) {
      storesNavItem.hidden = !boutique.sections.some((sec) => sec.id.startsWith('from-'));
    }

    if (boutiqueRefs && boutiqueRefs.deptButtons) {
      for (const [dept, btn] of boutiqueRefs.deptButtons.entries()) {
        const active = boutique.department === dept;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }
  }

  function updateBagBadge() {
    const count = Math.max(0, Math.floor(Number(state.bagCount) || 0));
    bagBadge.textContent = String(count);
    bagBadge.hidden = count === 0;
  }

  function renderTryOnBadge(badgeEl, status) {
    badgeEl.classList.remove('is-rendering', 'is-ready', 'is-failed');
    if (status === 'rendering') {
      badgeEl.textContent = 'Rendering try-on…';
      badgeEl.classList.add('is-rendering');
      badgeEl.hidden = false;
    } else if (status === 'ready') {
      badgeEl.textContent = 'Try-on ready';
      badgeEl.classList.add('is-ready');
      badgeEl.hidden = false;
    } else if (status === 'failed') {
      badgeEl.textContent = 'Try-on unavailable';
      badgeEl.classList.add('is-failed');
      badgeEl.hidden = false;
    } else {
      badgeEl.textContent = '';
      badgeEl.hidden = true;
    }
  }

  function buildProductCard(
    piece,
    outfitNumber,
    { compact = false, pointed = false, occurrence = null, onSelect = null } = {}
  ) {
    const item = piece?.item || {};
    const imgWidth = compact ? 420 : 600;
    const imgUrl = sized(item.image, imgWidth);

    const ratingEl =
      typeof item.rating === 'number' && Number.isFinite(item.rating)
        ? el(
            'span',
            { className: 'product-rating' },
            starSvg(),
            el(
              'span',
              null,
              item.rating_count !== null && item.rating_count !== undefined
                ? `${item.rating.toFixed(1)} (${Number(item.rating_count).toLocaleString()})`
                : item.rating.toFixed(1)
            )
          )
        : null;

    const card = el(
      'article',
      {
        className: `product-card${compact ? ' product-card--compact' : ''}${pointed ? ' is-pointed' : ''}`,
        dataset: {
          itemId: item.id || '',
          slot: piece?.slot || '',
          occurrence,
          outfit: outfitNumber,
        },
        onClick: (e) => {
          if (e.metaKey || e.ctrlKey) {
            const href = safeExternalUrl(item.url);
            if (href) {
              e.preventDefault();
              window.open(href, '_blank', 'noopener,noreferrer');
            }
            return;
          }
          e.preventDefault();
          if (typeof onSelect === 'function') {
            onSelect(item, piece);
            return;
          }
          pendingProductOutfit =
            typeof outfitNumber === 'number' && Number.isFinite(outfitNumber) ? outfitNumber : null;
          handlers.showProduct({
            item,
            images: item.image ? [item.image] : [],
            slot: piece?.slot || '',
            why: piece?.why || '',
            sizes: Array.isArray(item.sizes) ? item.sizes : [],
            details: [],
            description: typeof item.description === 'string' ? item.description : '',
          });
          pendingProductOutfit = null;
        },
      },
      el(
        'div',
        { className: 'product-tile' },
        !compact ? el('span', { className: 'pointer-tag' }, 'Alice is on this') : null,
        imgUrl
          ? el('img', {
              className: 'product-img',
              src: imgUrl,
              alt: item.title || 'Garment',
              loading: 'lazy',
              decoding: 'async',
              onError: (e) => {
                e.currentTarget.hidden = true;
              },
            })
          : null
      ),
      el(
        'div',
        { className: 'product-meta' },
        el('span', { className: 'product-store' }, item.store || ''),
        el('h3', { className: 'product-title' }, item.title || ''),
        el(
          'div',
          { className: 'product-bottom-row' },
          el('span', { className: 'product-price' }, formatPrice(item.price)),
          ratingEl
        )
      )
    );

    return card;
  }

  // Open the product sheet immediately from card data, then upgrade with /api/product
  async function openBoutiqueProduct(item, { slot = '', why = '' } = {}) {
    if (!item || typeof item !== 'object') return;

    if (productAbortController) {
      productAbortController.abort();
      productAbortController = null;
    }
    const reqId = ++productReqId;
    const markProducts = document.body.classList.contains('call-live');

    openProductFromPayload(
      {
        item,
        images: item.image ? [item.image] : [],
        slot,
        why,
        sizes: Array.isArray(item.sizes) ? item.sizes : [],
        details: [],
        description: typeof item.description === 'string' ? item.description : '',
      },
      { markProducts }
    );

    const rawVariantId =
      item.variant_id !== null && item.variant_id !== undefined ? String(item.variant_id).trim() : '';
    if (!rawVariantId) return;

    const controller = new AbortController();
    productAbortController = controller;
    const data = await fetchJson(`/api/product?variant_id=${encodeURIComponent(rawVariantId)}`, {
      signal: controller.signal,
    });

    if (reqId !== productReqId || !state.productOpen) return;
    productAbortController = null;
    if (!data || !data.item || typeof data.item !== 'object') return;

    openProductFromPayload(
      {
        ...data,
        slot: typeof data.slot === 'string' && data.slot.trim() ? data.slot : slot,
        why: typeof data.why === 'string' && data.why.trim() ? data.why : why,
      },
      { markProducts }
    );
  }

  function renderEmptyView() {
    cancelPickedMotion(activePickedRefs);
    clearLookEnterTimers();
    cancelLooksTotalRolls();
    releaseStageVideo();
    boutiqueRefs = null;
    mainEl.replaceChildren(
      el(
        'section',
        { className: 'empty-hero', 'aria-label': 'Waiting for your stylist' },
        el('p', { className: 'empty-hero-line' }, 'Your stylist is on the line.')
      )
    );
    updateNavActive();
  }

  function buildLookSkeletonCard() {
    return el(
      'article',
      { className: 'boutique-look-card is-skeleton', 'aria-hidden': 'true' },
      el(
        'div',
        { className: 'boutique-look-collage' },
        Array.from({ length: 4 }, () => el('div', { className: 'boutique-collage-cell skeleton-block' }))
      ),
      el('div', { className: 'skeleton-line skeleton-line--title skeleton-block' }),
      el('div', { className: 'skeleton-line skeleton-line--meta skeleton-block' }),
      el('div', { className: 'skeleton-line skeleton-line--body skeleton-block' })
    );
  }

  function buildBoutiqueLookCard(look) {
    const pieces = Array.isArray(look.pieces)
      ? look.pieces.filter((p) => p && typeof p === 'object' && p.item && typeof p.item === 'object')
      : [];
    const collagePieces = pieces.slice(0, 4);
    const lookName =
      typeof look.name === 'string' && look.name.trim() ? look.name.trim() : 'Curated look';
    const diffText = typeof look.difference === 'string' ? look.difference.trim() : '';

    let totalValue =
      typeof look.total === 'number' && Number.isFinite(look.total) ? look.total : null;
    if (totalValue === null && pieces.length > 0) {
      let sum = 0;
      let counted = 0;
      for (const p of pieces) {
        const price = Number(p.item.price);
        if (Number.isFinite(price)) {
          sum += price;
          counted += 1;
        }
      }
      if (counted > 0) totalValue = sum;
    }

    const metaParts = [];
    if (pieces.length > 0) {
      metaParts.push(`${pieces.length} ${pieces.length === 1 ? 'piece' : 'pieces'}`);
    }
    if (totalValue !== null) {
      metaParts.push(formatPrice(totalValue));
    }

    const collageCells = Array.from({ length: 4 }, (_, idx) => {
      const piece = collagePieces[idx];
      if (!piece) {
        return el('div', { className: 'boutique-collage-cell boutique-collage-cell--empty', 'aria-hidden': 'true' });
      }
      const item = piece.item;
      const imgUrl = sized(item.image, 420);
      return el(
        'button',
        {
          type: 'button',
          className: 'boutique-collage-cell',
          'aria-label': item.title ? `View ${item.title}` : 'View garment',
          onClick: (e) => {
            if (e.metaKey || e.ctrlKey) {
              const href = safeExternalUrl(item.url);
              if (href) {
                e.preventDefault();
                window.open(href, '_blank', 'noopener,noreferrer');
              }
              return;
            }
            e.preventDefault();
            openBoutiqueProduct(item, { slot: piece.slot || '', why: piece.why || '' });
          },
        },
        imgUrl
          ? el('img', {
              className: 'boutique-collage-img',
              src: imgUrl,
              alt: item.title || 'Garment',
              loading: 'lazy',
              decoding: 'async',
              onError: (e) => {
                e.currentTarget.hidden = true;
              },
            })
          : null
      );
    });

    return el(
      'article',
      { className: 'boutique-look-card' },
      el('div', { className: 'boutique-look-collage' }, collageCells),
      el(
        'div',
        { className: 'boutique-look-body' },
        el('h3', { className: 'boutique-look-name' }, lookName),
        metaParts.length > 0 ? el('p', { className: 'boutique-look-meta' }, metaParts.join(' · ')) : null,
        diffText ? el('p', { className: 'boutique-look-diff' }, diffText) : null,
        el(
          'button',
          {
            type: 'button',
            className: 'boutique-look-cta',
            onClick: () => triggerTalk(),
          },
          'Ask Alice to style this'
        )
      )
    );
  }

  function getBoutiqueLooksTitle() {
    return boutique.selectedOccasion
      ? `Looks for ${boutique.selectedOccasion.label}`
      : 'Looks by Alice';
  }

  function stopOccasionPlaceholder() {
    if (occasionPlaceholderTimer !== null) {
      clearTimeout(occasionPlaceholderTimer);
      occasionPlaceholderTimer = null;
    }
  }

  // Type and erase example prompts in the occasion search field while it is empty and unfocused
  function startOccasionPlaceholder(inputEl) {
    stopOccasionPlaceholder();
    if (!inputEl) return;
    if (prefersReducedMotion()) {
      inputEl.placeholder = OCCASION_STATIC_PLACEHOLDER;
      return;
    }
    if (document.activeElement === inputEl || inputEl.value.length > 0) {
      inputEl.placeholder = OCCASION_STATIC_PLACEHOLDER;
      return;
    }

    let phraseIdx = 0;
    let charIdx = 0;
    let erasing = false;
    inputEl.placeholder = '';

    const step = () => {
      occasionPlaceholderTimer = null;
      if (!inputEl.isConnected || !boutiqueRefs || boutiqueRefs.occasionSearchInput !== inputEl) {
        return;
      }
      if (prefersReducedMotion()) {
        inputEl.placeholder = OCCASION_STATIC_PLACEHOLDER;
        return;
      }
      if (document.activeElement === inputEl || inputEl.value.length > 0) {
        inputEl.placeholder = OCCASION_STATIC_PLACEHOLDER;
        return;
      }

      const phrase = OCCASION_SEARCH_PLACEHOLDERS[phraseIdx];
      if (!erasing) {
        charIdx += 1;
        inputEl.placeholder = phrase.slice(0, charIdx);
        if (charIdx >= phrase.length) {
          erasing = true;
          occasionPlaceholderTimer = setTimeout(step, 1800);
        } else {
          occasionPlaceholderTimer = setTimeout(step, 85);
        }
      } else {
        charIdx -= 1;
        inputEl.placeholder = phrase.slice(0, charIdx);
        if (charIdx <= 0) {
          erasing = false;
          phraseIdx = (phraseIdx + 1) % OCCASION_SEARCH_PLACEHOLDERS.length;
          occasionPlaceholderTimer = setTimeout(step, 500);
        } else {
          occasionPlaceholderTimer = setTimeout(step, 45);
        }
      }
    };

    occasionPlaceholderTimer = setTimeout(step, 450);
  }

  function syncOccasionSearchButton() {
    if (!boutiqueRefs || !boutiqueRefs.occasionSearchBtn) return;
    const btn = boutiqueRefs.occasionSearchBtn;
    btn.disabled = boutique.occasionMatchPending;
    btn.textContent = boutique.occasionMatchPending ? 'Finding…' : 'Find looks';
  }

  function cancelOccasionMatch() {
    if (boutique.occasionMatchAbortController) {
      boutique.occasionMatchAbortController.abort();
      boutique.occasionMatchAbortController = null;
    }
    boutique.occasionMatchReqId += 1;
    boutique.occasionMatchPending = false;
    syncOccasionSearchButton();
  }

  // Keep the dropdown value aligned with selectedOccasion when its key is in the menu
  function syncOccasionSelect() {
    if (!boutiqueRefs || !boutiqueRefs.occasionSelect) return;
    const select = boutiqueRefs.occasionSelect;
    const selectedKey = boutique.selectedOccasion ? boutique.selectedOccasion.key : '';
    const inMenu =
      Boolean(selectedKey) && boutique.occasions.some((occ) => occ.key === selectedKey);
    select.value = inMenu ? selectedKey : '';
    select.classList.toggle('is-placeholder', !inMenu);
  }

  function renderBoutiqueOccasionStatus() {
    if (!boutiqueRefs || !boutiqueRefs.occasionStatus) return;
    const statusEl = boutiqueRefs.occasionStatus;
    const status = boutique.occasionMatchStatus;
    if (!status) {
      statusEl.replaceChildren();
      statusEl.hidden = true;
      return;
    }
    if (status.kind === 'matched') {
      statusEl.hidden = false;
      statusEl.replaceChildren(`Showing looks for "${status.label}"`);
      return;
    }
    statusEl.hidden = false;
    if (document.body.classList.contains('call-live')) {
      statusEl.replaceChildren(
        'Nothing ready-made for that yet. Tell Alice and she will build it for you live.'
      );
      return;
    }
    statusEl.replaceChildren(
      'Nothing ready-made for that yet. Tell Alice and she will build it for you live. ',
      el(
        'button',
        {
          type: 'button',
          className: 'boutique-occasion-talk-btn',
          onClick: () => triggerTalk(),
        },
        'Talk to Alice'
      )
    );
  }

  // Match a free-text occasion search against ready-made occasions for the active department
  async function runOccasionMatch() {
    const raw =
      boutiqueRefs && boutiqueRefs.occasionSearchInput
        ? boutiqueRefs.occasionSearchInput.value
        : boutique.occasionQuery;
    const q = raw.trim().slice(0, OCCASION_QUERY_MAX_LEN);
    if (!q) return;

    if (boutique.occasionMatchAbortController) {
      boutique.occasionMatchAbortController.abort();
    }
    const controller = new AbortController();
    boutique.occasionMatchAbortController = controller;
    const dept = boutique.department;
    const deptReqId = boutique.reqId;
    const matchReqId = ++boutique.occasionMatchReqId;

    boutique.occasionMatchPending = true;
    syncOccasionSearchButton();

    const url = `/api/occasions/match?department=${encodeURIComponent(dept)}&q=${encodeURIComponent(q)}`;
    let data = null;
    try {
      data = await fetchJson(url, { signal: controller.signal });
    } finally {
      if (deptReqId === boutique.reqId && matchReqId === boutique.occasionMatchReqId) {
        boutique.occasionMatchAbortController = null;
        boutique.occasionMatchPending = false;
        syncOccasionSearchButton();
      }
    }

    if (deptReqId !== boutique.reqId || matchReqId !== boutique.occasionMatchReqId) return;

    const rawMatch =
      data && data.match && typeof data.match === 'object' ? data.match : null;
    const matchKey =
      rawMatch && typeof rawMatch.key === 'string' ? rawMatch.key.trim() : '';
    const matchLabel =
      rawMatch && typeof rawMatch.label === 'string' ? rawMatch.label.trim() : '';

    if (!matchKey) {
      boutique.occasionMatchStatus = { kind: 'empty' };
      renderBoutiqueOccasionStatus();
      return;
    }

    const menuEntry = boutique.occasions.find((occ) => occ.key === matchKey);
    const label = matchLabel || (menuEntry ? menuEntry.label : matchKey);
    boutique.occasionMatchStatus = { kind: 'matched', label };
    selectOccasion({ key: matchKey, label });
    syncOccasionSelect();
    renderBoutiqueOccasionStatus();
  }

  function renderBoutiqueOccasionsSlot() {
    stopOccasionPlaceholder();
    if (!boutiqueRefs) return;
    const { occasionsSlot } = boutiqueRefs;

    if (boutique.occasions.length === 0) {
      boutiqueRefs.occasionSelect = null;
      boutiqueRefs.occasionSearchInput = null;
      boutiqueRefs.occasionSearchBtn = null;
      boutiqueRefs.occasionStatus = null;
      occasionsSlot.replaceChildren();
      occasionsSlot.hidden = true;
      return;
    }

    const selectId = 'boutique-occasion-select';
    const selectEl = el(
      'select',
      {
        id: selectId,
        className: 'boutique-occasion-select',
        onChange: (e) => {
          const key = e.currentTarget.value;
          cancelOccasionMatch();
          boutique.occasionMatchStatus = null;
          renderBoutiqueOccasionStatus();
          if (!key) {
            selectOccasion(null);
            return;
          }
          const picked = boutique.occasions.find((occ) => occ.key === key) || null;
          selectOccasion(picked);
        },
      },
      el('option', { value: '' }, 'Choose an occasion'),
      ...boutique.occasions.map((occ) => el('option', { value: occ.key }, occ.label))
    );

    const searchInput = el('input', {
      type: 'text',
      className: 'boutique-occasion-search-input',
      maxlength: String(OCCASION_QUERY_MAX_LEN),
      placeholder: OCCASION_STATIC_PLACEHOLDER,
      'aria-label': 'Search an occasion',
      autocomplete: 'off',
      spellcheck: 'false',
      value: boutique.occasionQuery,
      onInput: (e) => {
        boutique.occasionQuery = e.currentTarget.value;
        if (e.currentTarget.value.length > 0) {
          stopOccasionPlaceholder();
        }
      },
      onFocus: (e) => {
        stopOccasionPlaceholder();
        e.currentTarget.placeholder = OCCASION_STATIC_PLACEHOLDER;
      },
      onBlur: (e) => {
        if (e.currentTarget.value.length === 0) {
          startOccasionPlaceholder(e.currentTarget);
        }
      },
    });
    if (boutique.occasionQuery) {
      searchInput.value = boutique.occasionQuery;
    }

    const searchBtn = el(
      'button',
      {
        type: 'submit',
        className: 'boutique-occasion-search-btn',
      },
      'Find looks'
    );

    const searchForm = el(
      'form',
      {
        className: 'boutique-occasion-search',
        role: 'search',
        onSubmit: (e) => {
          e.preventDefault();
          runOccasionMatch();
        },
      },
      searchInput,
      searchBtn
    );

    const statusEl = el('p', {
      className: 'boutique-occasion-status',
      role: 'status',
      'aria-live': 'polite',
      hidden: true,
    });

    boutiqueRefs.occasionSelect = selectEl;
    boutiqueRefs.occasionSearchInput = searchInput;
    boutiqueRefs.occasionSearchBtn = searchBtn;
    boutiqueRefs.occasionStatus = statusEl;

    syncOccasionSelect();
    syncOccasionSearchButton();
    renderBoutiqueOccasionStatus();

    occasionsSlot.hidden = false;
    occasionsSlot.replaceChildren(
      el(
        'section',
        { className: 'boutique-occasions-section', 'aria-label': 'Shop by occasion' },
        el(
          'div',
          { className: 'boutique-section-head' },
          el(
            'h2',
            { className: 'boutique-section-title' },
            el('label', { className: 'boutique-occasion-label', for: selectId }, 'Shop by occasion')
          )
        ),
        el(
          'div',
          { className: 'boutique-occasion-controls' },
          el('div', { className: 'boutique-occasion-select-wrap' }, selectEl),
          searchForm
        ),
        statusEl
      )
    );

    startOccasionPlaceholder(searchInput);
  }

  function selectOccasion(occasion) {
    const next =
      occasion && typeof occasion.key === 'string'
        ? { key: occasion.key, label: occasion.label }
        : null;
    const currentKey = boutique.selectedOccasion ? boutique.selectedOccasion.key : null;
    const nextKey = next ? next.key : null;
    if (currentKey === nextKey) return;

    boutique.selectedOccasion = next;
    syncOccasionSelect();
    loadBoutiqueLooks(boutique.department, next, boutique.reqId);
  }

  function renderBoutiqueLooksSlot() {
    if (!boutiqueRefs) return;
    const { looksSlot } = boutiqueRefs;
    const looksTitle = getBoutiqueLooksTitle();

    if (boutique.looksPending) {
      looksSlot.hidden = false;
      looksSlot.replaceChildren(
        el(
          'section',
          { className: 'boutique-looks-section', 'aria-label': looksTitle, 'aria-busy': 'true' },
          el(
            'div',
            { className: 'boutique-section-head' },
            el('h2', { className: 'boutique-section-title' }, looksTitle)
          ),
          el(
            'div',
            { className: 'boutique-looks-grid' },
            Array.from({ length: 3 }, () => buildLookSkeletonCard())
          )
        )
      );
      return;
    }

    if (boutique.looks.length === 0) {
      if (boutique.selectedOccasion) {
        looksSlot.hidden = false;
        looksSlot.replaceChildren(
          el(
            'section',
            { className: 'boutique-looks-section', 'aria-label': looksTitle },
            el(
              'div',
              { className: 'boutique-section-head' },
              el('h2', { className: 'boutique-section-title' }, looksTitle)
            ),
            el(
              'p',
              { className: 'boutique-looks-empty' },
              'Alice styles this one live. ',
              el(
                'button',
                {
                  type: 'button',
                  className: 'boutique-looks-empty-cta',
                  onClick: () => triggerTalk(),
                },
                'Talk to Alice'
              )
            )
          )
        );
        return;
      }
      looksSlot.replaceChildren();
      looksSlot.hidden = true;
      return;
    }

    looksSlot.hidden = false;
    looksSlot.replaceChildren(
      el(
        'section',
        { className: 'boutique-looks-section', 'aria-label': looksTitle },
        el(
          'div',
          { className: 'boutique-section-head' },
          el('h2', { className: 'boutique-section-title' }, looksTitle)
        ),
        el(
          'div',
          { className: 'boutique-looks-grid' },
          boutique.looks.map((look) => buildBoutiqueLookCard(look))
        )
      )
    );
  }

  function buildRailSkeletonSection() {
    return el(
      'section',
      { className: 'boutique-rail-section is-skeleton', 'aria-hidden': 'true' },
      el('div', { className: 'skeleton-line skeleton-line--heading skeleton-block' }),
      el(
        'div',
        { className: 'boutique-rail' },
        Array.from({ length: 6 }, () =>
          el(
            'div',
            { className: 'boutique-skeleton-card' },
            el('div', { className: 'skeleton-tile skeleton-block' }),
            el('div', { className: 'skeleton-line skeleton-line--store skeleton-block' }),
            el('div', { className: 'skeleton-line skeleton-line--name skeleton-block' }),
            el('div', { className: 'skeleton-line skeleton-line--price skeleton-block' })
          )
        )
      )
    );
  }

  function renderBoutiqueRailsSlot() {
    if (!boutiqueRefs) return;
    const { railsSlot } = boutiqueRefs;

    if (boutique.storefrontPending) {
      railsSlot.hidden = false;
      railsSlot.replaceChildren(
        el(
          'div',
          { className: 'boutique-rails', 'aria-busy': 'true' },
          buildRailSkeletonSection(),
          buildRailSkeletonSection()
        )
      );
      return;
    }

    if (boutique.sections.length === 0) {
      railsSlot.replaceChildren();
      railsSlot.hidden = true;
      return;
    }

    railsSlot.hidden = false;
    railsSlot.replaceChildren(
      el(
        'div',
        { className: 'boutique-rails' },
        boutique.sections.map((section) =>
          el(
            'section',
            {
              className: 'boutique-rail-section',
              'aria-label': section.title || 'Featured pieces',
              dataset: { section: typeof section.id === 'string' ? section.id : '' },
            },
            section.title
              ? el(
                  'div',
                  { className: 'boutique-section-head' },
                  el('h2', { className: 'boutique-section-title' }, section.title)
                )
              : null,
            el(
              'div',
              { className: 'boutique-rail' },
              section.items.map((item) =>
                buildProductCard({ slot: '', why: '', item }, null, {
                  compact: false,
                  pointed: false,
                  onSelect: (selectedItem) => openBoutiqueProduct(selectedItem),
                })
              )
            )
          )
        )
      )
    );
  }

  function updateBoutiqueFooterNote() {
    if (!boutiqueRefs) return;
    boutiqueRefs.footerNote.hidden = !hasBoutiqueContent();
  }

  function renderBoutiqueView() {
    cancelPickedMotion(activePickedRefs);
    clearLookEnterTimers();
    cancelLooksTotalRolls();
    const deptButtons = new Map();
    const deptSwitch = el(
      'div',
      { className: 'boutique-dept-switch', role: 'group', 'aria-label': 'Department' },
      ['women', 'men'].map((dept) => {
        const label = dept === 'women' ? 'Women' : 'Men';
        const active = boutique.department === dept;
        const btn = el(
          'button',
          {
            type: 'button',
            className: `boutique-dept-btn${active ? ' is-active' : ''}`,
            'aria-pressed': active ? 'true' : 'false',
            onClick: () => selectDepartment(dept),
          },
          label
        );
        deptButtons.set(dept, btn);
        return btn;
      })
    );

    const hero = el(
      'section',
      { className: 'boutique-hero', 'aria-label': "Alice's boutique" },
      el(
        'div',
        { className: 'boutique-hero-copy' },
        el('p', { className: 'boutique-eyebrow' }, "Alice's boutique"),
        el('h1', { className: 'boutique-headline' }, 'Styled live, from real stores'),
        el(
          'p',
          { className: 'boutique-copy' },
          'Tell Alice the occasion. She shops Fashion Nova, Everlane, Steve Madden and Kith while you talk, and shows the look on you.'
        ),
        el(
          'div',
          { className: 'boutique-hero-actions' },
          el(
            'button',
            {
              type: 'button',
              className: 'btn-primary boutique-talk-btn',
              onClick: () => triggerTalk(),
            },
            'Talk to Alice'
          )
        )
      ),
      deptSwitch
    );

    const occasionsSlot = el('div', { className: 'boutique-slot' });
    const looksSlot = el('div', { className: 'boutique-slot' });
    const railsSlot = el('div', { className: 'boutique-slot' });
    const footerNote = el(
      'p',
      { className: 'boutique-footer-note', hidden: !hasBoutiqueContent() },
      "Prices and stock come live from each store. Checkout happens on the store's own site."
    );

    boutiqueRefs = {
      deptButtons,
      occasionsSlot,
      occasionSelect: null,
      occasionSearchInput: null,
      occasionSearchBtn: null,
      occasionStatus: null,
      looksSlot,
      railsSlot,
      footerNote,
    };

    renderBoutiqueOccasionsSlot();
    renderBoutiqueLooksSlot();
    renderBoutiqueRailsSlot();

    mainEl.replaceChildren(
      el('div', { className: 'boutique-view' }, hero, occasionsSlot, looksSlot, railsSlot, footerNote)
    );
    updateNavActive();
  }

  function renderHomeView() {
    if (hasBoutiqueAvailable()) {
      state.view = 'boutique';
      renderBoutiqueView();
    } else {
      state.view = 'empty';
      renderEmptyView();
    }
  }

  function showBoutique() {
    cancelPickedMotion(activePickedRefs);
    closeProductPanel();
    leaveSearchView();
    state.pickedOutfit = null;
    state.highlightedSlot = null;
    state.highlightedOccurrence = null;
    activePickedRefs = null;
    renderHomeView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Bring one part of the boutique into view, returning to the boutique first if another view is showing
  function scrollToBoutique(selector) {
    if (!hasBoutiqueAvailable()) return;
    if (state.view !== 'boutique') showBoutique();
    requestAnimationFrame(() => {
      const target = mainEl.querySelector(selector);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function finishBoutiqueCheck() {
    syncBoutiqueBodyClass();
    if (!boutique.looksPending && !boutique.storefrontPending && !hasBoutiqueContent()) {
      if (state.view === 'boutique') {
        state.view = 'empty';
        renderEmptyView();
      }
      return;
    }
    if (state.view === 'empty' && hasBoutiqueContent()) {
      state.view = 'boutique';
      renderBoutiqueView();
      return;
    }
    if (state.view === 'boutique') {
      updateBoutiqueFooterNote();
      updateNavActive();
    }
  }

  // What each department's boutique showed, kept for the life of this page view so that switching
  // between Women and Men does not repeat the same store searches. A reload starts fresh.
  const boutiqueMemo = new Map(); // department -> { looks?, sections?, occasions? }

  // Rails from a later reply replace the same rail and add the missing ones; store rails stay last
  function mergeRails(existing, fresh) {
    const byId = new Map();
    for (const sec of [...existing, ...fresh]) byId.set(sec.id || sec.title, sec);
    const isStoreRail = (sec) => sec.id.startsWith('from-');
    return [...byId.values()].sort((x, y) => Number(isStoreRail(x)) - Number(isStoreRail(y)));
  }

  function rememberBoutique(dept, part, value) {
    boutiqueMemo.set(dept, { ...boutiqueMemo.get(dept), [part]: value });
  }

  // Fetch boutique looks for the active department and optional occasion, ignoring stale replies
  function loadBoutiqueLooks(dept, occasion, deptReqId, { render = true } = {}) {
    if (boutique.looksAbortController) {
      boutique.looksAbortController.abort();
    }
    const controller = new AbortController();
    boutique.looksAbortController = controller;
    const looksReqId = ++boutique.looksReqId;

    boutique.looks = [];
    boutique.looksPending = true;

    if (render && state.view === 'boutique' && boutiqueRefs) {
      renderBoutiqueLooksSlot();
      updateBoutiqueFooterNote();
    }

    const encodedDept = encodeURIComponent(dept);
    const url = occasion
      ? `/api/looks?department=${encodedDept}&limit=6&occasion=${encodeURIComponent(occasion.key)}`
      : `/api/looks?department=${encodedDept}&limit=6`;

    fetchJson(url, { signal: controller.signal }).then((data) => {
      if (deptReqId !== boutique.reqId || looksReqId !== boutique.looksReqId) return;
      boutique.looksAbortController = null;
      boutique.looksPending = false;
      // Keep only looks made for this department: a piece tagged for the other one rules the look out
      const fitsDepartment = (lk) =>
        !Array.isArray(lk.pieces) ||
        lk.pieces.every((p) => !p?.item?.department || p.item.department === dept);
      boutique.looks =
        data && Array.isArray(data.looks)
          ? data.looks.filter((lk) => lk && typeof lk === 'object' && fitsDepartment(lk)).slice(0, 6)
          : [];
      if (!occasion && data && Array.isArray(data.looks)) rememberBoutique(dept, 'looks', boutique.looks);
      syncBoutiqueBodyClass();
      if (state.view === 'boutique' && boutiqueRefs) {
        renderBoutiqueLooksSlot();
      }
      finishBoutiqueCheck();
    });
  }

  function loadBoutique(department) {
    const dept = department === 'men' ? 'men' : 'women';
    if (boutique.abortController) {
      boutique.abortController.abort();
    }
    if (boutique.looksAbortController) {
      boutique.looksAbortController.abort();
      boutique.looksAbortController = null;
    }
    cancelOccasionMatch();
    const controller = new AbortController();
    boutique.abortController = controller;
    const reqId = ++boutique.reqId;

    const kept = boutiqueMemo.get(dept);
    const fromMemory = Boolean(kept && kept.looks && kept.sections && kept.occasions);

    boutique.department = dept;
    boutique.looks = fromMemory ? kept.looks : [];
    boutique.sections = fromMemory ? kept.sections : [];
    boutique.occasions = fromMemory ? kept.occasions : [];
    boutique.selectedOccasion = null;
    boutique.occasionQuery = '';
    boutique.occasionMatchStatus = null;
    boutique.looksPending = !fromMemory;
    boutique.storefrontPending = !fromMemory;

    if (state.view === 'boutique') {
      if (boutiqueRefs) {
        renderBoutiqueOccasionsSlot();
        renderBoutiqueLooksSlot();
        renderBoutiqueRailsSlot();
        updateBoutiqueFooterNote();
        updateNavActive();
      } else {
        renderBoutiqueView();
      }
    } else {
      updateNavActive();
    }

    if (fromMemory) {
      syncBoutiqueBodyClass();
      return;
    }

    const encodedDept = encodeURIComponent(dept);

    // Fetch looks, storefront rails and occasions in parallel; ignore stale replies on department switch
    loadBoutiqueLooks(dept, null, reqId, { render: false });

    // The storefront route answers within a time budget and marks a short reply as partial.
    // A partial reply is shown at once, then asked for again (twice at most) and merged by rail.
    const fetchStorefront = (attempt) => {
      fetchJson(`/api/storefront?department=${encodedDept}`, { signal: controller.signal }).then(
        (data) => {
          if (reqId !== boutique.reqId) return;
          boutique.storefrontPending = false;
          const fresh =
            data && Array.isArray(data.sections)
              ? data.sections
                  .filter((sec) => sec && typeof sec === 'object' && Array.isArray(sec.items))
                  .map((sec) => ({
                    id: typeof sec.id === 'string' ? sec.id : '',
                    title: typeof sec.title === 'string' ? sec.title.trim() : '',
                    items: sec.items.filter((it) => it && typeof it === 'object'),
                  }))
                  .filter((sec) => sec.items.length > 0)
              : [];
          const partial = Boolean(data && data.partial);
          boutique.sections = mergeRails(attempt === 0 ? [] : boutique.sections, fresh);
          if (boutique.sections.length > 0 && !partial) rememberBoutique(dept, 'sections', boutique.sections);
          syncBoutiqueBodyClass();
          if (state.view === 'boutique' && boutiqueRefs) {
            renderBoutiqueRailsSlot();
          }
          updateNavActive();
          finishBoutiqueCheck();
          if (partial && attempt < 2) {
            setTimeout(() => {
              if (reqId === boutique.reqId) fetchStorefront(attempt + 1);
            }, 2500);
          }
        }
      );
    };
    fetchStorefront(0);

    fetchJson(`/api/occasions?department=${encodedDept}`, { signal: controller.signal }).then(
      (data) => {
        if (reqId !== boutique.reqId) return;
        boutique.occasions = normalizeOccasionMenu(data);
        if (data) rememberBoutique(dept, 'occasions', boutique.occasions);
        if (state.view === 'boutique' && boutiqueRefs) {
          renderBoutiqueOccasionsSlot();
        }
        updateNavActive();
      }
    );
  }

  function selectDepartment(department) {
    const dept = department === 'men' ? 'men' : 'women';
    const switchingDept = dept !== boutique.department;
    const alreadyLoadingSame =
      !switchingDept && (boutique.looksPending || boutique.storefrontPending);

    cancelPickedMotion(activePickedRefs);
    closeProductPanel();
    leaveSearchView();
    state.pickedOutfit = null;
    state.highlightedSlot = null;
    state.highlightedOccurrence = null;
    activePickedRefs = null;
    state.view = 'boutique';

    if (switchingDept || (!hasBoutiqueContent() && !alreadyLoadingSame)) {
      loadBoutique(dept);
    } else if (!boutiqueRefs) {
      renderBoutiqueView();
    } else {
      updateNavActive();
    }
  }

  function applyLookCardCollage(visualEl, boardLayerEl, boardImgEl, collageUrl) {
    if (!visualEl || !boardLayerEl || !boardImgEl) return;
    if (collageUrl) {
      const nextSrc = stageUrl(collageUrl, 900);
      boardImgEl.hidden = false;
      if (boardImgEl.getAttribute('src') !== nextSrc) {
        boardImgEl.setAttribute('src', nextSrc);
      }
      visualEl.classList.add('has-collage');
      boardLayerEl.tabIndex = 0;
      boardLayerEl.setAttribute('aria-hidden', 'false');
    } else {
      visualEl.classList.remove('has-collage');
      boardImgEl.removeAttribute('src');
      boardImgEl.hidden = true;
      boardLayerEl.tabIndex = -1;
      boardLayerEl.setAttribute('aria-hidden', 'true');
    }
  }

  function renderLooksView({ animateNums = null } = {}) {
    cancelPickedMotion(activePickedRefs);
    clearLookEnterTimers();
    cancelLooksTotalRolls();
    releaseStageVideo();
    boutiqueRefs = null;
    const looks = sortedOutfits();
    if (looks.length === 0) {
      renderHomeView();
      return;
    }

    const animateOrder = new Map();
    if (!prefersReducedMotion() && animateNums && animateNums.size > 0) {
      const toAnimate = looks.filter((lk) => animateNums.has(lk.number));
      const step =
        toAnimate.length > 1
          ? Math.min(120, Math.floor((1160 - 420) / (toAnimate.length - 1)))
          : 0;
      toAnimate.forEach((lk, idx) => {
        animateOrder.set(lk.number, idx * step);
      });
    }

    const meta = state.subtitleMeta;
    const chips = [];
    if (meta.occasion) {
      chips.push(
        el(
          'span',
          { className: 'meta-chip' },
          el('span', { className: 'meta-chip-label' }, 'Occasion'),
          meta.occasion
        )
      );
    }
    if (meta.budget !== null) {
      chips.push(
        el(
          'span',
          { className: 'meta-chip' },
          el('span', { className: 'meta-chip-label' }, 'Budget'),
          formatPrice(meta.budget)
        )
      );
    }

    const headerBand = el(
      'section',
      { className: 'collection-band' },
      el(
        'div',
        { className: 'breadcrumb' },
        el('span', null, 'Looks by Alice'),
        el('span', { className: 'breadcrumb-sep', 'aria-hidden': 'true' }, '/'),
        el('span', { className: 'breadcrumb-current' }, meta.occasion || 'Curated edit')
      ),
      el(
        'div',
        { className: 'collection-heading-row' },
        el('h1', { className: 'collection-title' }, buildCollectionTitle(looks.length, meta)),
        chips.length > 0 ? el('div', { className: 'chip-row' }, chips) : null
      )
    );

    const grid = el(
      'section',
      { className: 'looks-grid', 'aria-label': 'Curated looks' },
      looks.map((look) => {
        const media = getMedia(look.number);
        const lookLabel = look.name || `Look ${look.number}`;
        const badge = el('span', {
          className: 'tryon-badge',
          dataset: { tryonBadge: look.number },
        });
        renderTryOnBadge(badge, media.tryOnStatus);

        const piecesGrid = el(
          'div',
          { className: 'look-pieces-grid' },
          (look.pieces || []).map((piece) =>
            buildProductCard(piece, look.number, { compact: true })
          )
        );

        let visualBox;
        let boardLayer;
        const boardImg = el('img', {
          className: 'look-board-img',
          alt: `${lookLabel} flat lay`,
          decoding: 'async',
          hidden: true,
          onError: () => {
            if (visualBox && boardLayer) {
              visualBox.classList.remove('has-collage');
              boardLayer.tabIndex = -1;
              boardLayer.setAttribute('aria-hidden', 'true');
            }
            boardImg.hidden = true;
          },
        });

        boardLayer = el(
          'button',
          {
            type: 'button',
            className: 'look-board-layer',
            'aria-label': `Shop ${lookLabel}`,
            'aria-hidden': 'true',
            tabindex: '-1',
            onClick: (e) => {
              e.stopPropagation();
              handlers.highlight({ outfit: look.number, piece: null });
            },
          },
          boardImg
        );

        visualBox = el(
          'div',
          {
            className: 'look-card-visual',
            dataset: { lookVisual: look.number },
          },
          piecesGrid,
          boardLayer
        );

        applyLookCardCollage(visualBox, boardLayer, boardImg, media.collageUrl);

        const card = el(
          'article',
          {
            className: 'look-card',
            dataset: { lookCard: look.number },
            onClick: (e) => {
              if (e.target.closest('.product-card, button, a')) return;
              handlers.highlight({ outfit: look.number, piece: null });
            },
          },
          el(
            'div',
            { className: 'look-card-top' },
            el('span', { className: 'look-eyebrow' }, `Look ${look.number}`),
            badge
          ),
          visualBox,
          el('h2', { className: 'look-name' }, lookLabel),
          el('p', { className: 'look-difference' }, look.difference || ''),
          el(
            'div',
            { className: 'look-card-footer' },
            el(
              'div',
              { className: 'look-total' },
              el('span', { className: 'look-total-label' }, 'Look total'),
              el('span', { className: 'look-total-value' }, formatPrice(look.total))
            ),
            el(
              'button',
              {
                type: 'button',
                className: 'btn-primary',
                onClick: () => handlers.highlight({ outfit: look.number, piece: null }),
              },
              'Shop the look'
            )
          )
        );

        if (animateOrder.has(look.number)) {
          const delay = animateOrder.get(look.number);
          card.classList.add('is-look-entering');
          card.style.setProperty('--look-enter-delay', `${delay}ms`);
          let cleaned = false;
          const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            card.classList.remove('is-look-entering');
            card.style.removeProperty('--look-enter-delay');
          };
          card.addEventListener(
            'animationend',
            (e) => {
              if (e.target === card && e.animationName === 'look-card-rise') cleanup();
            },
            { once: true }
          );
          lookEnterCleanupTimers.push(setTimeout(cleanup, delay + 480));
        }

        return card;
      })
    );

    mainEl.replaceChildren(headerBand, grid);
    updateNavActive();
  }

  // Match the inner board frame to the loaded image aspect ratio so percentage boxes align cleanly
  function syncBoardFrameAspect(boardLayer, boardFrame, img) {
    if (!boardLayer || !boardFrame || !img) return;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return;
    const imgRatio = nw / nh;
    const cw = boardLayer.clientWidth;
    const ch = boardLayer.clientHeight;
    const containerRatio = cw > 0 && ch > 0 ? cw / ch : 0.75;
    boardFrame.style.aspectRatio = `${nw} / ${nh}`;
    if (imgRatio >= containerRatio) {
      boardFrame.style.width = '100%';
      boardFrame.style.height = 'auto';
    } else {
      boardFrame.style.height = '100%';
      boardFrame.style.width = 'auto';
    }
  }

  function resetBoardFrameAspect(boardFrame) {
    if (!boardFrame) return;
    boardFrame.style.aspectRatio = '';
    boardFrame.style.width = '';
    boardFrame.style.height = '';
  }

  // Motion state and cleanup helpers
  const playedBoardUrls = new Set();
  let lookEnterCleanupTimers = [];
  const looksTotalRolls = new Map();

  function clearLookEnterTimers() {
    for (const timerId of lookEnterCleanupTimers) {
      clearTimeout(timerId);
    }
    lookEnterCleanupTimers = [];
  }

  function cancelLooksTotalRolls() {
    for (const roll of looksTotalRolls.values()) {
      if (roll.rafId) cancelAnimationFrame(roll.rafId);
    }
    looksTotalRolls.clear();
  }

  function ensureStageMotion(panelRefs) {
    if (!panelRefs.stageMotion) {
      panelRefs.stageMotion = {
        curtainTimer: null,
        crossfadeTimer: null,
        layerFadeTimer: null,
        sceneDriftTimer: null,
        ghostEl: null,
      };
    }
    return panelRefs.stageMotion;
  }

  function cancelStageCurtain(panelRefs) {
    if (!panelRefs) return;
    const sm = panelRefs.stageMotion;
    if (sm && sm.curtainTimer) {
      clearTimeout(sm.curtainTimer);
      sm.curtainTimer = null;
    }
    if (panelRefs.stagePanel) {
      panelRefs.stagePanel.classList.remove('is-curtain-revealing');
    }
  }

  function cancelStageCrossfade(panelRefs) {
    if (!panelRefs) return;
    const sm = panelRefs.stageMotion;
    if (sm) {
      if (sm.crossfadeTimer) {
        clearTimeout(sm.crossfadeTimer);
        sm.crossfadeTimer = null;
      }
      if (sm.layerFadeTimer) {
        clearTimeout(sm.layerFadeTimer);
        sm.layerFadeTimer = null;
      }
      if (sm.ghostEl) {
        sm.ghostEl.remove();
        sm.ghostEl = null;
      }
    }
    if (panelRefs.tryOnLayer) {
      panelRefs.tryOnLayer.classList.remove('is-stage-crossfading');
    }
    if (panelRefs.tryOnImg) {
      panelRefs.tryOnImg.classList.remove('is-crossfade-start', 'is-crossfading');
    }
    if (panelRefs.stageVideo) {
      panelRefs.stageVideo.classList.remove('is-video-entering', 'is-video-crossfading');
    }
  }

  function cancelSceneDrift(panelRefs) {
    if (!panelRefs) return;
    const sm = panelRefs.stageMotion;
    if (sm && sm.sceneDriftTimer) {
      clearTimeout(sm.sceneDriftTimer);
      sm.sceneDriftTimer = null;
    }
    if (panelRefs.tryOnImg) {
      panelRefs.tryOnImg.classList.remove('is-scene-drifting');
    }
  }

  function startStageCurtain(panelRefs) {
    if (!panelRefs || !panelRefs.stagePanel || !panelRefs.tryOnLayer) return;
    cancelStageCurtain(panelRefs);
    cancelStageCrossfade(panelRefs);
    const sm = ensureStageMotion(panelRefs);
    const { stagePanel, tryOnLayer } = panelRefs;
    stagePanel.classList.add('is-showing-tryon');
    stagePanel.classList.remove('is-curtain-revealing');
    void tryOnLayer.offsetWidth;
    stagePanel.classList.add('is-curtain-revealing');

    const finish = () => {
      if (panelRefs.stageMotion && panelRefs.stageMotion.curtainTimer === timerId) {
        cancelStageCurtain(panelRefs);
      }
    };
    const timerId = setTimeout(finish, 760);
    sm.curtainTimer = timerId;
    tryOnLayer.addEventListener(
      'animationend',
      (e) => {
        if (e.target === tryOnLayer && e.animationName === 'stage-curtain-open') finish();
      },
      { once: true }
    );
  }

  function startStageLayerCrossfade(panelRefs) {
    if (!panelRefs || !panelRefs.stagePanel || !panelRefs.tryOnLayer) return;
    cancelStageCurtain(panelRefs);
    const sm = ensureStageMotion(panelRefs);
    if (sm.layerFadeTimer) {
      clearTimeout(sm.layerFadeTimer);
      sm.layerFadeTimer = null;
    }
    panelRefs.tryOnLayer.classList.add('is-stage-crossfading');
    void panelRefs.stagePanel.offsetWidth;
    panelRefs.stagePanel.classList.add('is-showing-tryon');
    const timerId = setTimeout(() => {
      if (panelRefs.stageMotion && panelRefs.stageMotion.layerFadeTimer === timerId) {
        panelRefs.stageMotion.layerFadeTimer = null;
        if (panelRefs.tryOnLayer) panelRefs.tryOnLayer.classList.remove('is-stage-crossfading');
      }
    }, 520);
    sm.layerFadeTimer = timerId;
  }

  function captureCrossfadeGhost(panelRefs) {
    if (!panelRefs || !panelRefs.tryOnImg) return null;
    const { tryOnImg } = panelRefs;
    const src = tryOnImg.getAttribute('src');
    if (tryOnImg.hidden || !src) return null;
    const ghost = el('img', {
      className: 'stage-crossfade-out',
      src,
      alt: '',
      decoding: 'async',
      'aria-hidden': 'true',
    });
    if (tryOnImg.classList.contains('is-scene-drifting')) {
      const computed = window.getComputedStyle(tryOnImg);
      if (computed.transform && computed.transform !== 'none') {
        ghost.style.transform = computed.transform;
        ghost.style.transformOrigin = 'center top';
      }
    }
    return ghost;
  }

  function startImageCrossfade(panelRefs, ghostEl) {
    if (!panelRefs || !panelRefs.tryOnLayer || !panelRefs.tryOnImg) return;
    cancelStageCrossfade(panelRefs);
    const sm = ensureStageMotion(panelRefs);
    const { tryOnLayer, tryOnImg } = panelRefs;
    if (ghostEl) {
      tryOnLayer.insertBefore(ghostEl, tryOnImg);
      sm.ghostEl = ghostEl;
    }
    tryOnImg.classList.remove('is-media-entering', 'is-crossfading');
    tryOnImg.classList.add('is-crossfade-start');
    void tryOnImg.offsetWidth;
    tryOnImg.classList.remove('is-crossfade-start');
    tryOnImg.classList.add('is-crossfading');

    const timerId = setTimeout(() => {
      if (panelRefs.stageMotion && panelRefs.stageMotion.crossfadeTimer === timerId) {
        cancelStageCrossfade(panelRefs);
      }
    }, 520);
    sm.crossfadeTimer = timerId;
  }

  function startVideoCrossfade(panelRefs, ghostEl) {
    if (!panelRefs || !panelRefs.tryOnLayer || !panelRefs.stageVideo) return;
    cancelStageCrossfade(panelRefs);
    const sm = ensureStageMotion(panelRefs);
    const { tryOnLayer, stageVideo } = panelRefs;
    if (ghostEl) {
      tryOnLayer.insertBefore(ghostEl, panelRefs.tryOnImg || stageVideo);
      sm.ghostEl = ghostEl;
    }
    stageVideo.classList.remove('is-media-entering', 'is-video-crossfading');
    stageVideo.classList.add('is-video-entering');
    void stageVideo.offsetWidth;
    stageVideo.classList.remove('is-video-entering');
    stageVideo.classList.add('is-video-crossfading');

    const timerId = setTimeout(() => {
      if (panelRefs.stageMotion && panelRefs.stageMotion.crossfadeTimer === timerId) {
        cancelStageCrossfade(panelRefs);
      }
    }, 520);
    sm.crossfadeTimer = timerId;
  }

  function startSceneDrift(panelRefs) {
    if (!panelRefs || !panelRefs.tryOnImg) return;
    cancelSceneDrift(panelRefs);
    const sm = ensureStageMotion(panelRefs);
    const { tryOnImg } = panelRefs;
    void tryOnImg.offsetWidth;
    tryOnImg.classList.add('is-scene-drifting');

    const finish = () => {
      if (panelRefs.stageMotion && panelRefs.stageMotion.sceneDriftTimer === timerId) {
        cancelSceneDrift(panelRefs);
      }
    };
    const timerId = setTimeout(finish, 8150);
    sm.sceneDriftTimer = timerId;
    tryOnImg.addEventListener(
      'animationend',
      (e) => {
        if (e.target === tryOnImg && e.animationName === 'stage-scene-drift') finish();
      },
      { once: true }
    );
  }

  function cancelBoardDropIn(panelRefs) {
    if (!panelRefs) return;
    if (panelRefs.stagePanel) {
      panelRefs.stagePanel.classList.remove('is-board-awaiting-drop');
    }
    if (panelRefs.boardLayer) {
      panelRefs.boardLayer.classList.remove('is-board-dropping');
    }
    if (panelRefs.boardFrame) {
      panelRefs.boardFrame.classList.remove('is-board-awaiting-drop', 'is-board-dropping');
    }
    if (panelRefs.boardDrop) {
      clearTimeout(panelRefs.boardDrop.timerId);
      if (panelRefs.boardDrop.layer) panelRefs.boardDrop.layer.remove();
      panelRefs.boardDrop = null;
    }
  }

  function maybeStartBoardDropIn(panelRefs, media) {
    if (!panelRefs || !media || !media.collageUrl) {
      cancelBoardDropIn(panelRefs);
      return;
    }
    if (prefersReducedMotion() || isPhoneViewport()) {
      cancelBoardDropIn(panelRefs);
      return;
    }
    const showingFlatLay = !(media.revealed && !media.stageSwapped);
    if (!showingFlatLay || isShowingPiece(panelRefs)) {
      cancelBoardDropIn(panelRefs);
      return;
    }
    if (playedBoardUrls.has(media.collageUrl)) return;

    const look = state.outfits.get(panelRefs.outfit);
    const boxes = collectOrderedBoxes(look, media.collageBoxes);
    if (!boxes) {
      cancelBoardDropIn(panelRefs);
      return;
    }

    const activePointedBox =
      state.highlightedSlot
        ? getBoxForSlot(media.collageBoxes, state.highlightedSlot, state.highlightedOccurrence || 1)
        : null;
    if (activePointedBox) {
      playedBoardUrls.add(media.collageUrl);
      cancelBoardDropIn(panelRefs);
      return;
    }

    const { stagePanel, boardLayer, boardFrame, collageImg, pointerRing } = panelRefs;
    if (!collageImg.complete || collageImg.naturalWidth <= 0) {
      stagePanel.classList.add('is-board-awaiting-drop');
      boardFrame.classList.add('is-board-awaiting-drop');
      return;
    }

    cancelBoardDropIn(panelRefs);
    playedBoardUrls.add(media.collageUrl);

    const src = collageImg.getAttribute('src') || stageUrl(media.collageUrl, 900);
    const dropLayer = el('div', { className: 'board-drop-layer', 'aria-hidden': 'true' });
    const dropStep = 110;
    const dropDuration = 260;
    let lastPieceImg = null;

    boxes.forEach((box, idx) => {
      const [x, y, w, h] = box;
      const top = (y * 100).toFixed(4);
      const right = (Math.max(0, 1 - x - w) * 100).toFixed(4);
      const bottom = (Math.max(0, 1 - y - h) * 100).toFixed(4);
      const left = (x * 100).toFixed(4);
      const pieceImg = el('img', {
        className: 'board-drop-piece',
        src,
        alt: '',
        decoding: 'async',
        onError: () => cancelBoardDropIn(panelRefs),
      });
      pieceImg.style.clipPath = `inset(${top}% ${right}% ${bottom}% ${left}%)`;
      pieceImg.style.setProperty('--drop-delay', `${idx * dropStep}ms`);
      dropLayer.appendChild(pieceImg);
      lastPieceImg = pieceImg;
    });

    boardLayer.classList.add('is-board-dropping');
    boardFrame.classList.add('is-board-dropping');
    boardFrame.insertBefore(dropLayer, pointerRing);

    const totalMs = (boxes.length - 1) * dropStep + dropDuration;
    const finish = () => {
      if (panelRefs.boardDrop && panelRefs.boardDrop.layer === dropLayer) {
        cancelBoardDropIn(panelRefs);
      }
    };
    const timerId = setTimeout(finish, totalMs + 80);
    if (lastPieceImg) {
      lastPieceImg.addEventListener(
        'animationend',
        (e) => {
          if (e.animationName === 'board-piece-drop') finish();
        },
        { once: true }
      );
    }
    panelRefs.boardDrop = { layer: dropLayer, timerId };
  }

  function setSpotlightVeilBox(strips, box) {
    const [x, y, w, h] = box;
    const topPct = y * 100;
    const bottomStartPct = Math.min(100, (y + h) * 100);
    const topBottomInset = Math.max(0, 100 - topPct);
    const leftRightInset = Math.max(0, 100 - x * 100);
    const rightLeftInset = Math.min(100, (x + w) * 100);
    const sideTopInset = Math.max(0, topPct - 0.15);
    const sideBottomInset = Math.max(0, 100 - bottomStartPct - 0.15);

    strips.top.style.clipPath = `inset(0% 0% ${topBottomInset.toFixed(4)}% 0%)`;
    strips.bottom.style.clipPath = `inset(${bottomStartPct.toFixed(4)}% 0% 0% 0%)`;
    strips.left.style.clipPath = `inset(${sideTopInset.toFixed(4)}% ${leftRightInset.toFixed(4)}% ${sideBottomInset.toFixed(4)}% 0%)`;
    strips.right.style.clipPath = `inset(${sideTopInset.toFixed(4)}% 0% ${sideBottomInset.toFixed(4)}% ${rightLeftInset.toFixed(4)}%)`;
  }

  function clearBoardSpotlight(panelRefs, { immediate = false } = {}) {
    if (!panelRefs || !panelRefs.spotlight) return;
    const spot = panelRefs.spotlight;
    if (spot.cleanupTimer) {
      clearTimeout(spot.cleanupTimer);
      spot.cleanupTimer = null;
    }
    if (spot.settlingLift) {
      clearTimeout(spot.settlingTimer);
      spot.settlingLift.remove();
      spot.settlingLift = null;
      spot.settlingTimer = null;
    }
    spot.boxKey = null;

    if (immediate) {
      if (spot.veil) spot.veil.remove();
      if (spot.lift) spot.lift.remove();
      panelRefs.spotlight = null;
      return;
    }

    if (spot.veil) spot.veil.classList.remove('is-active');
    if (spot.lift) {
      spot.lift.classList.remove('is-lifted');
      spot.lift.classList.add('is-settling');
    }
    spot.cleanupTimer = setTimeout(() => {
      if (panelRefs.spotlight === spot) {
        if (spot.veil) spot.veil.remove();
        if (spot.lift) spot.lift.remove();
        panelRefs.spotlight = null;
      }
    }, 240);
  }

  function updateBoardSpotlight(panelRefs, media, slot, occurrence = 1) {
    if (!panelRefs || !panelRefs.boardFrame || !panelRefs.collageImg) return;
    const showingFlatLay = Boolean(media && media.collageUrl && !(media.revealed && !media.stageSwapped));
    if (prefersReducedMotion() || isPhoneViewport() || !showingFlatLay || isShowingPiece(panelRefs)) {
      clearBoardSpotlight(panelRefs, { immediate: true });
      return;
    }

    const normalized = typeof slot === 'string' && slot.trim() ? slot.trim() : null;
    const box = normalized ? getBoxForSlot(media.collageBoxes, normalized, occurrence) : null;
    if (!box) {
      clearBoardSpotlight(panelRefs, { immediate: false });
      return;
    }

    const { boardFrame, collageImg, pointerRing } = panelRefs;
    if (!collageImg.complete || collageImg.naturalWidth <= 0) return;

    cancelBoardDropIn(panelRefs);

    const src = collageImg.getAttribute('src') || stageUrl(media.collageUrl, 900);
    const boxKey = `${src}|${box.map((n) => n.toFixed(4)).join(',')}`;
    let spot = panelRefs.spotlight;

    if (spot && spot.cleanupTimer) {
      clearTimeout(spot.cleanupTimer);
      spot.cleanupTimer = null;
    }

    if (spot && spot.boxKey === boxKey && spot.veil && spot.lift) {
      spot.veil.classList.add('is-active');
      spot.lift.classList.remove('is-settling');
      spot.lift.classList.add('is-lifted');
      return;
    }

    if (!spot || !spot.veil) {
      const top = el('div', { className: 'board-spotlight-strip' });
      const bottom = el('div', { className: 'board-spotlight-strip' });
      const left = el('div', { className: 'board-spotlight-strip' });
      const right = el('div', { className: 'board-spotlight-strip' });
      const veil = el(
        'div',
        { className: 'board-spotlight-veil is-snapping', 'aria-hidden': 'true' },
        top,
        bottom,
        left,
        right
      );
      const strips = { top, bottom, left, right };
      setSpotlightVeilBox(strips, box);
      boardFrame.insertBefore(veil, pointerRing);
      void veil.offsetWidth;
      veil.classList.remove('is-snapping');
      veil.classList.add('is-active');
      spot = { veil, strips, lift: null, settlingLift: null, settlingTimer: null, cleanupTimer: null, boxKey };
      panelRefs.spotlight = spot;
    } else {
      setSpotlightVeilBox(spot.strips, box);
      spot.veil.classList.add('is-active');
      spot.boxKey = boxKey;
    }

    if (spot.settlingLift) {
      clearTimeout(spot.settlingTimer);
      spot.settlingLift.remove();
      spot.settlingLift = null;
      spot.settlingTimer = null;
    }
    if (spot.lift) {
      const prevLift = spot.lift;
      prevLift.classList.remove('is-lifted');
      prevLift.classList.add('is-settling');
      spot.settlingLift = prevLift;
      spot.settlingTimer = setTimeout(() => {
        prevLift.remove();
        if (spot.settlingLift === prevLift) {
          spot.settlingLift = null;
          spot.settlingTimer = null;
        }
      }, 230);
      spot.lift = null;
    }

    const [x, y, w, h] = box;
    const topPct = (y * 100).toFixed(4);
    const rightPct = (Math.max(0, 1 - x - w) * 100).toFixed(4);
    const bottomPct = (Math.max(0, 1 - y - h) * 100).toFixed(4);
    const leftPct = (x * 100).toFixed(4);
    const cx = ((x + w / 2) * 100).toFixed(4);
    const cy = ((y + h / 2) * 100).toFixed(4);

    const liftImg = el('img', {
      className: 'board-spotlight-lift-img',
      src,
      alt: '',
      decoding: 'async',
      onError: () => {
        if (lift.parentNode) lift.remove();
        if (spot.lift === lift) spot.lift = null;
      },
    });
    liftImg.style.clipPath = `inset(${topPct}% ${rightPct}% ${bottomPct}% ${leftPct}%)`;

    const lift = el('div', { className: 'board-spotlight-lift', 'aria-hidden': 'true' }, liftImg);
    lift.style.transformOrigin = `${cx}% ${cy}%`;
    boardFrame.insertBefore(lift, pointerRing);
    void lift.offsetWidth;
    lift.classList.add('is-lifted');
    spot.lift = lift;
  }

  function buildPieceNoteRow(piece, occurrence, outfitNumber, isPointed) {
    return el(
      'li',
      {
        className: `piece-note-item${isPointed ? ' is-pointed' : ''}`,
        dataset: { slot: piece.slot || '', occurrence, outfit: outfitNumber },
      },
      el(
        'div',
        { className: 'piece-note-top' },
        el('span', { className: 'piece-slot-name' }, formatSlot(piece.slot)),
        el('span', { className: 'piece-note-price' }, formatPrice(piece.item?.price))
      ),
      el('span', { className: 'piece-note-title' }, piece.item?.title || ''),
      piece.why ? el('p', { className: 'piece-note-why' }, piece.why) : null
    );
  }

  // Smoothly roll a formatted dollar total over 600ms (ease-out) and finish on the exact value
  function rollPriceText(targetEl, fromVal, toVal, rollState, onDone = null) {
    if (!targetEl) return;
    if (rollState.rafId) {
      cancelAnimationFrame(rollState.rafId);
      rollState.rafId = null;
    }
    const startNum = Number(fromVal);
    const endNum = Number(toVal);
    const finalText = formatPrice(toVal);
    if (
      prefersReducedMotion() ||
      !Number.isFinite(startNum) ||
      !Number.isFinite(endNum) ||
      startNum === endNum
    ) {
      targetEl.textContent = finalText;
      if (typeof onDone === 'function') onDone();
      return;
    }

    const useCents = !Number.isInteger(startNum) || !Number.isInteger(endNum);
    const duration = 600;
    const startTime = performance.now();
    targetEl.textContent = useCents ? `$${startNum.toFixed(2)}` : formatPrice(startNum);

    const step = (now) => {
      const t = Math.min(1, Math.max(0, (now - startTime) / duration));
      if (t >= 1) {
        rollState.rafId = null;
        targetEl.textContent = finalText;
        if (typeof onDone === 'function') onDone();
        return;
      }
      const eased = 1 - Math.pow(1 - t, 3);
      const val = startNum + (endNum - startNum) * eased;
      if (useCents) {
        const rounded = Math.round(val * 100) / 100;
        targetEl.textContent = `$${rounded.toFixed(2)}`;
      } else {
        targetEl.textContent = formatPrice(Math.round(val));
      }
      rollState.rafId = requestAnimationFrame(step);
    };
    rollState.rafId = requestAnimationFrame(step);
  }

  function flushPendingSwap(panelRefs) {
    if (!panelRefs || !panelRefs.swapState) return;
    const swap = panelRefs.swapState;
    if (swap.halfTimer) {
      clearTimeout(swap.halfTimer);
      swap.halfTimer = null;
    }
    if (swap.doneTimer) {
      clearTimeout(swap.doneTimer);
      swap.doneTimer = null;
    }
    if (swap.totalRoll && swap.totalRoll.rafId) {
      cancelAnimationFrame(swap.totalRoll.rafId);
      swap.totalRoll.rafId = null;
    }
    if (!swap.committed && Array.isArray(swap.entries)) {
      for (const entry of swap.entries) {
        if (entry.oldRow && entry.oldRow.parentNode && entry.newRow) {
          entry.oldRow.replaceWith(entry.newRow);
        }
        if (entry.oldCard && entry.oldCard.parentNode && entry.newCard) {
          entry.oldCard.replaceWith(entry.newCard);
        }
      }
      swap.committed = true;
    }
    if (Array.isArray(swap.entries)) {
      for (const entry of swap.entries) {
        if (entry.oldRow) entry.oldRow.classList.remove('is-swap-flip-out', 'is-swap-flip-in');
        if (entry.oldCard) entry.oldCard.classList.remove('is-swap-flip-out', 'is-swap-flip-in');
        if (entry.newRow) entry.newRow.classList.remove('is-swap-flip-out', 'is-swap-flip-in');
        if (entry.newCard) entry.newCard.classList.remove('is-swap-flip-out', 'is-swap-flip-in');
      }
    }
    if (panelRefs.lookTotalEl && swap.finalTotalText !== null) {
      panelRefs.lookTotalEl.textContent = swap.finalTotalText;
    }
    swap.active = false;
    panelRefs.swapState = null;
  }

  function applyInPlaceSwap(panelRefs, oldLook, updated, swappedIndices) {
    if (!panelRefs || !panelRefs.pieceNotesList || !panelRefs.shopGrid) return false;
    if (typeof panelRefs.closeSizeSheet === 'function') panelRefs.closeSizeSheet();
    const pieces = updated.pieces || [];
    const slotCounts = new Map();
    const occurrences = pieces.map((piece) => {
      const slot = piece?.slot || '';
      const occ = slot ? (slotCounts.get(slot) || 0) + 1 : 1;
      if (slot) slotCounts.set(slot, occ);
      return occ;
    });

    const entries = [];
    for (const idx of swappedIndices) {
      const piece = pieces[idx];
      if (!piece) continue;
      const oldRow = panelRefs.pieceNotesList.children[idx];
      const oldCard = panelRefs.shopGrid.children[idx];
      if (!oldRow || !oldCard) continue;
      const occ = occurrences[idx];
      if (piece.item?.image) {
        const pre = new Image();
        pre.decoding = 'async';
        pre.src = sized(piece.item.image, 600);
      }
      const newRow = buildPieceNoteRow(piece, occ, updated.number, false);
      const newCard = buildProductCard(piece, updated.number, {
        compact: false,
        pointed: false,
        occurrence: occ,
      });
      entries.push({ oldRow, oldCard, newRow, newCard });
    }

    if (entries.length === 0) return false;

    const swapState = {
      active: true,
      committed: false,
      entries,
      halfTimer: null,
      doneTimer: null,
      totalRoll: { rafId: null },
      finalTotalText: formatPrice(updated.total),
    };
    panelRefs.swapState = swapState;

    for (const entry of entries) {
      entry.oldRow.classList.remove('is-swap-flip-out', 'is-swap-flip-in');
      entry.oldCard.classList.remove('is-swap-flip-out', 'is-swap-flip-in');
      void entry.oldRow.offsetWidth;
      entry.oldRow.classList.add('is-swap-flip-out');
      entry.oldCard.classList.add('is-swap-flip-out');
    }

    if (panelRefs.lookTotalEl) {
      rollPriceText(panelRefs.lookTotalEl, oldLook?.total, updated.total, swapState.totalRoll, () => {
        if (!swapState.active && panelRefs.swapState === swapState) {
          panelRefs.swapState = null;
        }
      });
    }

    swapState.halfTimer = setTimeout(() => {
      if (state.view !== 'picked' || activePickedRefs !== panelRefs || panelRefs.swapState !== swapState) {
        return;
      }
      swapState.halfTimer = null;
      swapState.committed = true;
      for (const entry of entries) {
        entry.newRow.classList.add('is-swap-flip-in');
        entry.newCard.classList.add('is-swap-flip-in');
        if (entry.oldRow.parentNode) entry.oldRow.replaceWith(entry.newRow);
        if (entry.oldCard.parentNode) entry.oldCard.replaceWith(entry.newCard);
      }
      if (entries[0]?.newRow) {
        scrollRowIntoList(panelRefs.pieceNotesList, entries[0].newRow);
      }

      const finishFlip = () => {
        if (panelRefs.swapState !== swapState) return;
        if (swapState.doneTimer) {
          clearTimeout(swapState.doneTimer);
          swapState.doneTimer = null;
        }
        for (const entry of entries) {
          entry.newRow.classList.remove('is-swap-flip-in');
          entry.newCard.classList.remove('is-swap-flip-in');
        }
        if (panelRefs.lookTotalEl && !swapState.totalRoll.rafId) {
          panelRefs.lookTotalEl.textContent = swapState.finalTotalText;
        }
        swapState.active = false;
        if (!swapState.totalRoll.rafId) {
          panelRefs.swapState = null;
        }
      };

      const lastNode = entries[entries.length - 1].newCard;
      lastNode.addEventListener(
        'animationend',
        (e) => {
          if (e.target === lastNode && e.animationName === 'swap-flip-in') finishFlip();
        },
        { once: true }
      );
      swapState.doneTimer = setTimeout(finishFlip, 340);
    }, 300);

    return true;
  }

  function cancelPickedMotion(panelRefs) {
    if (!panelRefs) return;
    closePieceLayer(panelRefs);
    flushPendingSwap(panelRefs);
    cancelBoardDropIn(panelRefs);
    clearBoardSpotlight(panelRefs, { immediate: true });
    cancelStageCurtain(panelRefs);
    cancelStageCrossfade(panelRefs);
    cancelSceneDrift(panelRefs);
  }

  function updateBoardPointerRing(refs, media, slot, occurrence = 1) {
    if (!refs || !refs.pointerRing) return;
    const ring = refs.pointerRing;
    if (isShowingPiece(refs)) {
      ring.classList.remove('is-visible');
      ring.setAttribute('aria-hidden', 'true');
      clearBoardSpotlight(refs, { immediate: true });
      return;
    }
    const normalized = typeof slot === 'string' && slot.trim() ? slot.trim() : null;
    const box =
      media && media.collageUrl && normalized
        ? getBoxForSlot(media.collageBoxes, normalized, occurrence)
        : null;

    if (!box) {
      ring.classList.remove('is-visible');
      ring.setAttribute('aria-hidden', 'true');
      updateBoardSpotlight(refs, media, normalized, occurrence);
      return;
    }

    const [x, y, w, h] = box;
    const wasVisible = ring.classList.contains('is-visible');

    ring.classList.toggle('is-tag-inside', y < 0.09);
    ring.classList.toggle('is-tag-right', x > 0.55);

    if (!wasVisible) {
      ring.classList.add('is-snapping');
    }
    ring.style.left = `${x * 100}%`;
    ring.style.top = `${y * 100}%`;
    ring.style.width = `${w * 100}%`;
    ring.style.height = `${h * 100}%`;

    if (!wasVisible) {
      void ring.offsetWidth;
      ring.classList.remove('is-snapping');
      ring.classList.add('is-visible');
    }
    ring.setAttribute('aria-hidden', 'false');
    updateBoardSpotlight(refs, media, normalized, occurrence);
  }

  function syncVideoPlayButton(panelRefs) {
    if (!panelRefs || !panelRefs.stageVideo || !panelRefs.videoPlayBtn) return;
    const playing = !panelRefs.stageVideo.paused && !panelRefs.stageVideo.ended;
    panelRefs.videoPlayBtn.classList.toggle('is-playing', playing);
    panelRefs.videoPlayBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    panelRefs.videoPlayBtn.setAttribute('aria-label', playing ? 'Pause video' : 'Play video');
    if (panelRefs.videoPlayLabel) {
      panelRefs.videoPlayLabel.textContent = playing ? 'Pause' : 'Play';
    }
  }

  function releaseStageVideo(panelRefs = null) {
    const target = panelRefs && panelRefs.stageVideo ? panelRefs.stageVideo : null;
    if (target) {
      releaseVideoElement(target);
      if (target === activeStageVideo) activeStageVideo = null;
    }
    if (activeStageVideo && activeStageVideo !== target) {
      releaseVideoElement(activeStageVideo);
      activeStageVideo = null;
    }
    if (panelRefs && panelRefs.videoPlayBtn) {
      panelRefs.videoPlayBtn.hidden = true;
      panelRefs.videoPlayBtn.classList.remove('is-playing');
      panelRefs.videoPlayBtn.setAttribute('aria-pressed', 'false');
    }
  }

  function triggerMediaFade(mediaEl, panelRefs) {
    if (!mediaEl || prefersReducedMotion()) return;
    mediaEl.classList.add('is-media-entering');
    void mediaEl.offsetWidth;
    requestAnimationFrame(() => {
      if (state.view === 'picked' && activePickedRefs === panelRefs) {
        mediaEl.classList.remove('is-media-entering');
      }
    });
  }

  function handleVideoFailure(panelRefs, media, failedUrl) {
    if (!media || media.renders.video !== failedUrl) return;
    media.videoFailed = true;
    releaseStageVideo(panelRefs);
    const fallbackKind = pickRenderKind(media, null, { exclude: 'video' });
    media.activeRender = fallbackKind;
    media.tryOnUrl = fallbackKind ? media.renders[fallbackKind] : null;
    if (state.view === 'picked' && activePickedRefs === panelRefs) {
      applyStageState(panelRefs, media);
    }
  }

  function mountStageVideo(panelRefs, media, videoUrl, { fade = false } = {}) {
    const { stageVideo, videoPlayBtn } = panelRefs;
    const reduced = prefersReducedMotion();
    const srcChanged = stageVideo.dataset.activeSrc !== videoUrl;

    stageVideo.muted = true;
    stageVideo.defaultMuted = true;
    stageVideo.playsInline = true;
    stageVideo.loop = true;
    stageVideo.controls = false;
    stageVideo.hidden = false;

    if (reduced) {
      stageVideo.autoplay = false;
      stageVideo.removeAttribute('autoplay');
      if (srcChanged) {
        stageVideo.dataset.activeSrc = videoUrl;
        stageVideo.src = videoUrl;
        try {
          stageVideo.load();
        } catch {
          // Ignore load errors when media playback is unavailable
        }
        try {
          stageVideo.pause();
        } catch {
          // Ignore pause errors
        }
      }
      activeStageVideo = stageVideo;
      videoPlayBtn.hidden = false;
      syncVideoPlayButton(panelRefs);
    } else {
      stageVideo.autoplay = true;
      stageVideo.setAttribute('autoplay', '');
      videoPlayBtn.hidden = true;
      if (srcChanged) {
        stageVideo.dataset.activeSrc = videoUrl;
        stageVideo.src = videoUrl;
      }
      activeStageVideo = stageVideo;
      if (srcChanged || stageVideo.paused) {
        try {
          const playPromise = stageVideo.play();
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch((err) => {
              if (err && err.name === 'AbortError') return;
              if (activePickedRefs !== panelRefs || stageVideo.dataset.activeSrc !== videoUrl) return;
              handleVideoFailure(panelRefs, media, videoUrl);
            });
          }
        } catch {
          handleVideoFailure(panelRefs, media, videoUrl);
          return;
        }
      }
    }

    if (fade) {
      triggerMediaFade(stageVideo, panelRefs);
    } else {
      stageVideo.classList.remove('is-media-entering');
    }
  }

  function createRenderTile(panelRefs, kind) {
    const tileImg = el('img', {
      className: 'render-tile-img',
      alt: '',
      decoding: 'async',
      hidden: true,
      onError: () => {
        tileImg.hidden = true;
      },
    });
    const playIcon =
      kind === 'video' ? el('span', { className: 'render-tile-play', 'aria-hidden': 'true' }) : null;
    const newTag = el('span', { className: 'render-tile-new', hidden: true }, 'New');
    const mediaBox = el('span', { className: 'render-tile-media' }, tileImg, playIcon, newTag);
    const labelEl = el('span', { className: 'render-tile-label' }, RENDER_LABELS[kind]);
    const btn = el(
      'button',
      {
        type: 'button',
        className: `render-tile render-tile--${kind}`,
        dataset: { renderKind: kind },
        'aria-pressed': 'false',
        onClick: () => {
          const currentMedia = getMedia(panelRefs.outfit);
          if (!currentMedia.revealed || !currentMedia.renders[kind]) return;
          if (kind === 'video' && currentMedia.videoFailed) return;
          const wasSwapped = currentMedia.stageSwapped;
          const prevKind = currentMedia.activeRender;
          currentMedia.userPickedRender = true;
          currentMedia.stageSwapped = false;
          currentMedia.activeRender = kind;
          currentMedia.tryOnUrl = currentMedia.renders[kind];
          const timerId = currentMedia.newRenderTags.get(kind);
          if (timerId) {
            clearTimeout(timerId);
            currentMedia.newRenderTags.delete(kind);
          }
          if (state.view === 'picked' && activePickedRefs === panelRefs) {
            closePieceLayer(panelRefs);
            applyStageState(panelRefs, currentMedia, {
              fadeRender: !wasSwapped && prevKind !== kind,
              tileSwitch: wasSwapped,
            });
          }
        },
      },
      mediaBox,
      labelEl
    );
    return { btn, tileImg, newTag };
  }

  // Show labelled render tiles under the stage once revealed and more than one render exists
  function syncRenderStrip(panelRefs, media, { newlyArrivedKind = null } = {}) {
    const { renderStrip, renderTiles } = panelRefs;
    if (!renderStrip || !renderTiles) return;

    const visibleKinds = availableRenderKinds(media);
    if (!media.revealed || visibleKinds.length <= 1) {
      renderStrip.hidden = true;
      return;
    }

    renderStrip.hidden = false;

    for (const [kind, entry] of renderTiles.entries()) {
      if (!visibleKinds.includes(kind)) {
        entry.btn.remove();
        renderTiles.delete(kind);
      }
    }

    let cursor = 0;
    for (const kind of visibleKinds) {
      let entry = renderTiles.get(kind);
      if (!entry) {
        entry = createRenderTile(panelRefs, kind);
        renderTiles.set(kind, entry);
      }

      const thumbUrl =
        kind === 'video' ? media.renders.studio || media.renders.scene : media.renders[kind];
      if (thumbUrl) {
        const nextSrc = stageUrl(thumbUrl, 320);
        if (entry.tileImg.getAttribute('src') !== nextSrc) {
          entry.tileImg.hidden = false;
          entry.tileImg.setAttribute('src', nextSrc);
        }
      } else {
        entry.tileImg.removeAttribute('src');
        entry.tileImg.hidden = true;
      }

      const isSelected = !media.stageSwapped && media.activeRender === kind;
      entry.btn.classList.toggle('is-selected', isSelected);
      entry.btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      entry.newTag.hidden = !media.newRenderTags.has(kind);

      const currentChild = renderStrip.children[cursor];
      if (currentChild !== entry.btn) {
        renderStrip.insertBefore(entry.btn, currentChild || null);
      }
      cursor += 1;

      if (newlyArrivedKind === kind && !prefersReducedMotion()) {
        entry.btn.classList.add('is-tile-entering');
        void entry.btn.offsetWidth;
        requestAnimationFrame(() => {
          if (state.view === 'picked' && activePickedRefs === panelRefs) {
            entry.btn.classList.remove('is-tile-entering');
          }
        });
      }
    }
  }

  function applyStageState(
    panelRefs,
    media,
    { deferReveal = false, fadeRender = false, newlyArrivedKind = null, curtainReveal = false, tileSwitch = false } = {}
  ) {
    const {
      stagePanel,
      boardLayer,
      boardFrame,
      collageImg,
      tryOnImg,
      stageVideo,
      videoPlayBtn,
      lookLabel,
      stageCaptionText,
      downloadLink,
      thumbBtn,
      thumbImg,
      thumbLabel,
      tryOnStatusEl,
    } = panelRefs;
    const prevShowingTryOn = stagePanel.classList.contains('is-showing-tryon');

    // Flat-lay board state
    if (media.collageUrl) {
      const nextSrc = stageUrl(media.collageUrl, 900);
      collageImg.hidden = false;
      if (collageImg.getAttribute('src') !== nextSrc) {
        resetBoardFrameAspect(boardFrame);
        collageImg.setAttribute('src', nextSrc);
      }
      stagePanel.classList.add('has-collage');
      if (collageImg.complete && collageImg.naturalWidth > 0) {
        syncBoardFrameAspect(boardLayer, boardFrame, collageImg);
      }
    } else {
      stagePanel.classList.remove('has-collage');
      collageImg.removeAttribute('src');
      collageImg.hidden = true;
      resetBoardFrameAspect(boardFrame);
    }

    // Resolve which render is active once revealed; fall back cleanly if a render is unavailable
    let activeKind = null;
    if (media.revealed) {
      if (
        media.activeRender &&
        media.renders[media.activeRender] &&
        !(media.activeRender === 'video' && media.videoFailed)
      ) {
        activeKind = media.activeRender;
      } else {
        activeKind = pickRenderKind(media);
        media.activeRender = activeKind;
      }
    }

    // Try-on stays hidden until reveal; on reveal it takes the main stage unless swapped
    const hasReveal = Boolean(media.revealed && activeKind);
    const showingTryOn = hasReveal && !media.stageSwapped;
    const reduced = prefersReducedMotion();
    const ghostEl =
      !reduced && showingTryOn && fadeRender && prevShowingTryOn
        ? captureCrossfadeGhost(panelRefs)
        : null;

    if (!hasReveal) {
      cancelStageCurtain(panelRefs);
      cancelStageCrossfade(panelRefs);
      cancelSceneDrift(panelRefs);
      panelRefs.lastShownRenderKey = null;
      tryOnImg.removeAttribute('src');
      tryOnImg.hidden = true;
      tryOnImg.classList.remove('is-media-entering');
      releaseStageVideo(panelRefs);
      stageVideo.hidden = true;
    } else if (activeKind === 'video') {
      cancelSceneDrift(panelRefs);
      tryOnImg.removeAttribute('src');
      tryOnImg.hidden = true;
      tryOnImg.classList.remove('is-media-entering');
      if (showingTryOn) {
        if (!reduced && fadeRender) {
          mountStageVideo(panelRefs, media, media.renders.video, { fade: false });
          startVideoCrossfade(panelRefs, ghostEl);
        } else {
          cancelStageCrossfade(panelRefs);
          mountStageVideo(panelRefs, media, media.renders.video, { fade: false });
        }
        panelRefs.lastShownRenderKey = `video:${media.renders.video}`;
      } else {
        cancelStageCurtain(panelRefs);
        cancelStageCrossfade(panelRefs);
        panelRefs.lastShownRenderKey = null;
        try {
          stageVideo.pause();
        } catch {
          // Ignore pause errors when swapped to flat lay
        }
        videoPlayBtn.hidden = true;
      }
    } else {
      releaseStageVideo(panelRefs);
      stageVideo.hidden = true;
      const nextTryOn = stageUrl(media.renders[activeKind], 900);
      const renderKey = `${activeKind}:${nextTryOn}`;
      const renderSwitched = panelRefs.lastShownRenderKey !== renderKey;
      tryOnImg.hidden = media.failedUrls.has(nextTryOn);
      tryOnImg.alt =
        activeKind === 'scene' ? `${lookLabel} on location` : `${lookLabel} try-on`;
      if (tryOnImg.getAttribute('src') !== nextTryOn) {
        tryOnImg.setAttribute('src', nextTryOn);
      }
      if (showingTryOn) {
        if (!reduced && fadeRender) {
          startImageCrossfade(panelRefs, ghostEl);
        } else {
          cancelStageCrossfade(panelRefs);
          tryOnImg.classList.remove('is-media-entering');
        }
        if (activeKind === 'scene' && !reduced) {
          if (fadeRender || curtainReveal || renderSwitched) {
            startSceneDrift(panelRefs);
          }
        } else {
          cancelSceneDrift(panelRefs);
        }
        panelRefs.lastShownRenderKey = renderKey;
      } else {
        cancelStageCurtain(panelRefs);
        cancelStageCrossfade(panelRefs);
        cancelSceneDrift(panelRefs);
        panelRefs.lastShownRenderKey = null;
        tryOnImg.classList.remove('is-media-entering');
      }
    }

    if (showingTryOn) {
      if (curtainReveal && !reduced) {
        startStageCurtain(panelRefs);
      } else if (tileSwitch && !prevShowingTryOn && !reduced) {
        startStageLayerCrossfade(panelRefs);
      } else if (deferReveal) {
        cancelStageCurtain(panelRefs);
        stagePanel.classList.remove('is-showing-tryon');
        void stagePanel.offsetWidth;
        requestAnimationFrame(() => {
          if (
            state.view === 'picked' &&
            activePickedRefs === panelRefs &&
            media.revealed &&
            !media.stageSwapped
          ) {
            stagePanel.classList.add('is-showing-tryon');
          }
        });
      } else {
        cancelStageCurtain(panelRefs);
        stagePanel.classList.add('is-showing-tryon');
      }
    } else {
      cancelStageCurtain(panelRefs);
      stagePanel.classList.remove('is-showing-tryon');
    }

    stageCaptionText.textContent = showingTryOn
      ? RENDER_CAPTIONS[activeKind] || 'On you'
      : 'The flat lay';

    // Point the download link at the full-size active render URL, or hide it when no try-on is on stage
    const rawRenderUrl = showingTryOn && activeKind ? media.renders[activeKind] : null;
    const activeImageFailed =
      Boolean(rawRenderUrl) &&
      activeKind !== 'video' &&
      media.failedUrls.has(stageUrl(rawRenderUrl, 900));
    const safeDownloadHref =
      rawRenderUrl && !activeImageFailed && safeExternalUrl(rawRenderUrl) ? rawRenderUrl : null;
    if (showingTryOn && activeKind && safeDownloadHref) {
      downloadLink.setAttribute('href', safeDownloadHref);
      downloadLink.setAttribute(
        'download',
        renderDownloadFilename(panelRefs.outfit, activeKind, safeDownloadHref)
      );
      downloadLink.setAttribute(
        'aria-label',
        `Download ${RENDER_CAPTIONS[activeKind] || 'try-on'}`
      );
      downloadLink.hidden = false;
    } else {
      downloadLink.hidden = true;
      downloadLink.removeAttribute('href');
      downloadLink.removeAttribute('download');
      downloadLink.removeAttribute('aria-label');
    }

    // Corner swap thumbnail appears once revealed so the shopper can toggle between try-on and flat lay
    if (hasReveal) {
      thumbBtn.hidden = false;
      if (showingTryOn) {
        thumbBtn.classList.add('is-thumb-collage');
        thumbBtn.classList.remove('is-thumb-tryon', 'is-thumb-video');
        thumbBtn.setAttribute('aria-label', 'Show the flat lay');
        thumbLabel.textContent = 'Flat lay';
        if (media.collageUrl) {
          const thumbSrc = stageUrl(media.collageUrl, 900);
          thumbImg.hidden = false;
          if (thumbImg.getAttribute('src') !== thumbSrc) {
            thumbImg.setAttribute('src', thumbSrc);
          }
        } else {
          thumbImg.removeAttribute('src');
          thumbImg.hidden = true;
        }
      } else {
        const isVideo = activeKind === 'video';
        thumbBtn.classList.add('is-thumb-tryon');
        thumbBtn.classList.remove('is-thumb-collage');
        thumbBtn.classList.toggle('is-thumb-video', isVideo);
        const captionText = RENDER_CAPTIONS[activeKind] || 'On you';
        thumbBtn.setAttribute('aria-label', `Show ${captionText.toLowerCase()}`);
        thumbLabel.textContent = activeKind === 'studio' ? 'On you' : RENDER_LABELS[activeKind];
        const previewUrl = isVideo
          ? media.renders.studio || media.renders.scene
          : media.renders[activeKind];
        if (previewUrl) {
          const thumbSrc = stageUrl(previewUrl, 900);
          thumbImg.hidden = false;
          if (thumbImg.getAttribute('src') !== thumbSrc) {
            thumbImg.setAttribute('src', thumbSrc);
          }
        } else {
          thumbImg.removeAttribute('src');
          thumbImg.hidden = true;
        }
      }
      requestAnimationFrame(() => {
        if (state.view === 'picked' && activePickedRefs === panelRefs && media.revealed) {
          thumbBtn.classList.add('is-thumb-visible');
        }
      });
    } else {
      thumbBtn.classList.remove('is-thumb-visible', 'is-thumb-collage', 'is-thumb-tryon', 'is-thumb-video');
      thumbBtn.hidden = true;
      thumbImg.removeAttribute('src');
      thumbImg.hidden = true;
    }

    syncRenderStrip(panelRefs, media, { newlyArrivedKind });

    // One-line try-on status below the bag control (nothing when failed or already revealed)
    tryOnStatusEl.classList.remove('is-rendering', 'is-ready');
    if (hasReveal) {
      tryOnStatusEl.textContent = '';
      tryOnStatusEl.hidden = true;
    } else if (!media.revealed && media.tryOnStatus === 'ready' && hasAnyRender(media)) {
      tryOnStatusEl.textContent = "Try-on ready: say 'show me'";
      tryOnStatusEl.classList.add('is-ready');
      tryOnStatusEl.hidden = false;
    } else if (media.tryOnStatus === 'rendering') {
      tryOnStatusEl.textContent = 'Rendering your try-on…';
      tryOnStatusEl.classList.add('is-rendering');
      tryOnStatusEl.hidden = false;
    } else {
      tryOnStatusEl.textContent = '';
      tryOnStatusEl.hidden = true;
    }

    updateBoardPointerRing(panelRefs, media, state.highlightedSlot, state.highlightedOccurrence);
    maybeStartBoardDropIn(panelRefs, media);
  }

  function isElementInView(node) {
    if (!node) return true;
    const rect = node.getBoundingClientRect();
    const headerH = headerEl.offsetHeight || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    return rect.top >= headerH - 16 && rect.bottom <= vh + 40;
  }

  let activePickedRefs = null;
  let activeStageVideo = null;

  function renderPickedView({ deferReveal = false, curtainReveal = false } = {}) {
    cancelPickedMotion(activePickedRefs);
    clearLookEnterTimers();
    cancelLooksTotalRolls();
    releaseStageVideo();
    boutiqueRefs = null;
    const look = state.outfits.get(state.pickedOutfit);
    if (!look) {
      state.pickedOutfit = null;
      state.highlightedSlot = null;
      state.highlightedOccurrence = null;
      if (state.outfits.size > 0) {
        state.view = 'looks';
        renderLooksView();
      } else {
        renderHomeView();
      }
      return;
    }

    const media = getMedia(look.number);
    const lookLabel = look.name || `Look ${look.number}`;

    const topBar = el(
      'div',
      { className: 'picked-top-bar' },
      el(
        'button',
        {
          type: 'button',
          className: 'back-link',
          onClick: () => handlers.showAll({}),
        },
        arrowLeftSvg(),
        'All looks'
      ),
      el(
        'div',
        { className: 'breadcrumb' },
        el('span', null, 'Looks by Alice'),
        el('span', { className: 'breadcrumb-sep', 'aria-hidden': 'true' }, '/'),
        el('span', { className: 'breadcrumb-current' }, `Look ${look.number}`)
      )
    );

    let stagePanel;
    let boardLayer;
    let boardFrame;

    const collageImg = el('img', {
      className: 'stage-collage-img',
      alt: `${lookLabel} flat lay`,
      decoding: 'async',
      hidden: true,
      onLoad: () => {
        syncBoardFrameAspect(boardLayer, boardFrame, collageImg);
        if (state.view === 'picked' && activePickedRefs && activePickedRefs.outfit === look.number) {
          stagePanel.classList.remove('is-board-awaiting-drop');
          boardFrame.classList.remove('is-board-awaiting-drop');
          updateBoardSpotlight(activePickedRefs, media, state.highlightedSlot, state.highlightedOccurrence);
          maybeStartBoardDropIn(activePickedRefs, media);
        }
      },
      onError: () => {
        if (activePickedRefs && activePickedRefs.outfit === look.number) {
          cancelBoardDropIn(activePickedRefs);
          clearBoardSpotlight(activePickedRefs, { immediate: true });
        }
        if (stagePanel) stagePanel.classList.remove('has-collage');
        collageImg.hidden = true;
      },
    });

    const pointerRing = el(
      'div',
      { className: 'board-pointer-ring', 'aria-hidden': 'true' },
      el('span', { className: 'board-pointer-tag' }, 'Alice is on this')
    );

    boardFrame = el('div', { className: 'stage-board-frame' }, collageImg, pointerRing);
    boardLayer = el('div', { className: 'stage-board-layer' }, boardFrame);

    const tryOnImg = el('img', {
      className: 'stage-tryon-img',
      alt: `${lookLabel} try-on`,
      decoding: 'async',
      hidden: true,
      onError: () => {
        const brokenSrc = tryOnImg.getAttribute('src');
        if (!brokenSrc) return;
        if (activePickedRefs && activePickedRefs.outfit === look.number) {
          cancelStageCrossfade(activePickedRefs);
          cancelSceneDrift(activePickedRefs);
        }
        media.failedUrls.add(brokenSrc);
        tryOnImg.hidden = true;
        const altKind =
          media.activeRender === 'scene'
            ? 'studio'
            : media.activeRender === 'studio'
              ? 'scene'
              : null;
        if (
          altKind &&
          media.renders[altKind] &&
          !media.failedUrls.has(stageUrl(media.renders[altKind], 900)) &&
          state.view === 'picked' &&
          activePickedRefs &&
          activePickedRefs.outfit === look.number
        ) {
          media.activeRender = altKind;
          media.tryOnUrl = media.renders[altKind];
          applyStageState(activePickedRefs, media);
        } else if (state.view === 'picked' && activePickedRefs && activePickedRefs.outfit === look.number) {
          activePickedRefs.downloadLink.hidden = true;
          activePickedRefs.downloadLink.removeAttribute('href');
          activePickedRefs.downloadLink.removeAttribute('download');
          activePickedRefs.downloadLink.removeAttribute('aria-label');
        }
      },
    });

    const stageVideo = el('video', {
      className: 'stage-tryon-video',
      muted: true,
      loop: true,
      playsinline: true,
      preload: 'auto',
      hidden: true,
      'aria-label': `${lookLabel} in motion`,
      onPlay: () => {
        if (activePickedRefs && activePickedRefs.outfit === look.number) {
          syncVideoPlayButton(activePickedRefs);
        }
      },
      onPause: () => {
        if (activePickedRefs && activePickedRefs.outfit === look.number) {
          syncVideoPlayButton(activePickedRefs);
        }
      },
      onError: () => {
        const failedUrl = stageVideo.dataset.activeSrc;
        if (!failedUrl) return;
        if (activePickedRefs && activePickedRefs.outfit === look.number) {
          handleVideoFailure(activePickedRefs, media, failedUrl);
        }
      },
    });
    stageVideo.muted = true;
    stageVideo.defaultMuted = true;
    stageVideo.playsInline = true;
    stageVideo.loop = true;
    stageVideo.controls = false;

    const videoPlayLabel = el('span', null, 'Play');
    const videoPlayBtn = el(
      'button',
      {
        type: 'button',
        className: 'stage-video-play-btn',
        hidden: true,
        'aria-label': 'Play video',
        'aria-pressed': 'false',
        onClick: () => {
          const activeUrl = stageVideo.dataset.activeSrc;
          if (!activeUrl) return;
          if (stageVideo.paused) {
            try {
              const p = stageVideo.play();
              if (p && typeof p.catch === 'function') {
                p.catch((err) => {
                  if (err && err.name === 'AbortError') return;
                  if (activePickedRefs && activePickedRefs.outfit === look.number) {
                    handleVideoFailure(activePickedRefs, media, activeUrl);
                  }
                });
              }
            } catch {
              if (activePickedRefs && activePickedRefs.outfit === look.number) {
                handleVideoFailure(activePickedRefs, media, activeUrl);
              }
            }
          } else {
            try {
              stageVideo.pause();
            } catch {
              // Ignore pause errors
            }
          }
        },
      },
      el('span', { className: 'stage-video-play-icon', 'aria-hidden': 'true' }),
      videoPlayLabel
    );

    const tryOnLayer = el(
      'div',
      { className: 'stage-tryon-layer' },
      tryOnImg,
      stageVideo,
      videoPlayBtn
    );

    const thumbImg = el('img', {
      className: 'stage-thumb-img',
      alt: '',
      decoding: 'async',
      hidden: true,
      onError: () => {
        thumbImg.hidden = true;
      },
    });
    const thumbPlay = el('span', { className: 'stage-thumb-play', 'aria-hidden': 'true' });
    const thumbLabel = el('span', { className: 'stage-thumb-label' }, 'Flat lay');
    const thumbBtn = el(
      'button',
      {
        type: 'button',
        className: 'stage-thumb-btn',
        hidden: true,
        'aria-label': 'Show the flat lay',
        onClick: () => {
          if (!media.revealed || !pickRenderKind(media)) return;
          media.stageSwapped = !media.stageSwapped;
          if (activePickedRefs && activePickedRefs.outfit === look.number) {
            applyStageState(activePickedRefs, media);
          }
        },
      },
      thumbImg,
      thumbPlay,
      thumbLabel
    );

    stagePanel = el(
      'div',
      { className: 'stage-panel' },
      el(
        'div',
        { className: 'stage-placeholder' },
        el('p', { className: 'stage-placeholder-text' }, 'Laying it out…'),
        el('p', { className: 'stage-placeholder-sub' }, 'Styling board')
      ),
      boardLayer,
      tryOnLayer,
      thumbBtn
    );

    const stageCaptionText = el('span', { className: 'stage-caption-text' }, 'The flat lay');
    const downloadLink = el(
      'a',
      {
        className: 'stage-download-link',
        hidden: true,
      },
      'Download'
    );
    const stageCaption = el(
      'figcaption',
      { className: 'stage-caption' },
      stageCaptionText,
      downloadLink
    );
    const renderStrip = el('div', {
      className: 'stage-render-strip',
      role: 'group',
      'aria-label': 'Look renders',
      hidden: true,
    });
    const visualCol = el(
      'div',
      { className: 'stage-visual-col' },
      el('figure', { className: 'stage-figure' }, stagePanel, stageCaption),
      renderStrip
    );

    const slotCounts = new Map();
    const piecesWithOccurrence = (look.pieces || []).map((piece) => {
      const slot = piece?.slot || '';
      const occurrence = slot ? (slotCounts.get(slot) || 0) + 1 : 1;
      if (slot) slotCounts.set(slot, occurrence);
      return { piece, occurrence };
    });

    let hasActiveRow = false;
    const pieceRows = piecesWithOccurrence.map(({ piece, occurrence }) => {
      const isPointed = Boolean(
        state.highlightedSlot &&
          piece.slot === state.highlightedSlot &&
          occurrence === state.highlightedOccurrence
      );
      if (isPointed) hasActiveRow = true;
      return buildPieceNoteRow(piece, occurrence, look.number, isPointed);
    });

    const pieceNotesList = el(
      'ul',
      { className: `piece-notes-list${hasActiveRow ? ' has-active' : ''}` },
      pieceRows
    );

    const ctaStatus = el('span', { className: 'summary-cta-status', 'aria-live': 'polite' }, '');
    const bagFallbackEl = el('p', {
      className: 'bag-fallback-note',
      role: 'status',
      'aria-live': 'polite',
      hidden: true,
    });
    const sizeSheetEl = el('div', {
      className: 'look-size-sheet',
      role: 'region',
      'aria-label': 'Choose sizes',
      hidden: true,
    });
    let sizeSheetOpen = false;
    let sizeSheetPending = false;
    let notesCol = null;

    function closeSizeSheet() {
      sizeSheetOpen = false;
      sizeSheetEl.hidden = true;
      sizeSheetEl.replaceChildren();
      addLookBtn.setAttribute('aria-expanded', 'false');
      if (notesCol) notesCol.classList.remove('has-size-sheet');
    }

    function openSizeSheet() {
      const currentLook = state.outfits.get(look.number) || look;
      const currentPieces = Array.isArray(currentLook.pieces) ? currentLook.pieces : [];
      if (currentPieces.length === 0) return;

      bagFallbackEl.hidden = true;
      bagFallbackEl.replaceChildren();
      ctaStatus.textContent = '';

      const rowControls = [];
      const rows = currentPieces.map((piece, idx) => {
        const item = piece?.item || {};
        const slot = typeof piece?.slot === 'string' ? piece.slot.trim() : '';
        const slotLabel = formatSlot(slot);
        const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : slotLabel;
        const sizes = normalizeSizeList(item.sizes);
        const remembered = getRememberedSlotSize(slot);
        const controlId = `look-size-${currentLook.number}-${idx}`;

        let controlEl;
        let readSize;

        if (sizes.length > 1) {
          const matched = remembered
            ? sizes.find((s) => s.toLowerCase() === remembered.toLowerCase())
            : '';
          const initial = matched || sizes[0];
          const selectEl = el(
            'select',
            {
              id: controlId,
              className: 'size-sheet-select',
              'aria-label': `Size for ${title}`,
              onChange: (e) => rememberSlotSize(slot, e.currentTarget.value),
            },
            sizes.map((s) => el('option', { value: s, selected: s === initial }, s))
          );
          selectEl.value = initial;
          controlEl = selectEl;
          readSize = () => selectEl.value.trim();
        } else if (sizes.length === 1) {
          const onlySize = sizes[0];
          const label =
            onlySize.toLowerCase() === 'os' || onlySize.toLowerCase() === 'one size'
              ? 'One size'
              : onlySize;
          controlEl = el('span', { className: 'size-sheet-static' }, label);
          readSize = () => onlySize;
        } else {
          const inputEl = el('input', {
            id: controlId,
            type: 'text',
            className: 'size-sheet-input',
            placeholder: 'One size',
            maxlength: '24',
            autocomplete: 'off',
            'aria-label': `Size for ${title}`,
            value: remembered,
            onInput: (e) => rememberSlotSize(slot, e.currentTarget.value),
          });
          if (remembered) inputEl.value = remembered;
          controlEl = inputEl;
          readSize = () => inputEl.value.trim();
        }

        rowControls.push({ piece, slot, readSize });

        return el(
          'div',
          { className: 'size-sheet-row' },
          el(
            'div',
            { className: 'size-sheet-meta' },
            el('span', { className: 'size-sheet-slot' }, slotLabel),
            sizes.length !== 1
              ? el('label', { className: 'size-sheet-title', for: controlId }, title)
              : el('span', { className: 'size-sheet-title' }, title)
          ),
          el('div', { className: 'size-sheet-control' }, controlEl)
        );
      });

      const submitBtn = el(
        'button',
        {
          type: 'button',
          className: 'btn-primary size-sheet-submit',
          onClick: async () => {
            if (isCallLive()) {
              closeSizeSheet();
              bagFallbackEl.hidden = true;
              bagFallbackEl.replaceChildren();
              sendToAlice(`Add look ${currentLook.number} to my bag.`);
              ctaStatus.textContent = 'Alice is on it. Tell her your sizes.';
              return;
            }
            if (sizeSheetPending || directBagBusy) return;
            const entries = rowControls.map(({ piece, slot, readSize }) => {
              const size = readSize();
              if (slot && size) rememberSlotSize(slot, size);
              return { piece, size };
            });
            const department = resolveBagDepartment(entries.map((e) => e.piece));
            const outfit = buildBagOutfitPayload(entries, {
              name: currentLook.name || lookLabel,
              number: currentLook.number,
              total: currentLook.total,
            });
            const sizes = buildBagSizesMap(entries);

            if (bagAbortController) bagAbortController.abort();
            const controller = new AbortController();
            bagAbortController = controller;
            const reqId = ++directBagReqId;

            sizeSheetPending = true;
            directBagBusy = true;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Adding…';
            bagFallbackEl.hidden = true;
            bagFallbackEl.replaceChildren();

            let data = null;
            try {
              data = await postBag({ department, outfit, sizes }, { signal: controller.signal });
            } finally {
              sizeSheetPending = false;
              if (reqId === directBagReqId) {
                directBagBusy = false;
                bagAbortController = null;
              }
              submitBtn.disabled = false;
              submitBtn.textContent = 'Add to bag';
            }

            if (reqId !== directBagReqId) return;

            if (!data) {
              renderBagFallbackInto(
                bagFallbackEl,
                'Talk to Alice and she will bag this look for you.'
              );
              return;
            }

            state.directBag = {
              department,
              name: outfit.name,
              number: outfit.number,
              entries,
              sizes,
            };
            closeSizeSheet();
            applyBagReady(data, { fromAlice: false });
          },
        },
        'Add to bag'
      );

      sizeSheetEl.replaceChildren(
        el('div', { className: 'size-sheet-rows' }, rows),
        el('div', { className: 'size-sheet-actions' }, submitBtn)
      );
      sizeSheetOpen = true;
      sizeSheetEl.hidden = false;
      addLookBtn.setAttribute('aria-expanded', 'true');
      if (notesCol) notesCol.classList.add('has-size-sheet');
    }

    const addLookBtn = el(
      'button',
      {
        type: 'button',
        className: 'btn-primary',
        'aria-expanded': 'false',
        onClick: () => {
          root.dispatchEvent(
            new CustomEvent('alice:add-look', { detail: { outfit: look.number } })
          );
          if (isCallLive()) {
            closeSizeSheet();
            bagFallbackEl.hidden = true;
            bagFallbackEl.replaceChildren();
            sendToAlice(`Add look ${look.number} to my bag.`);
            ctaStatus.textContent = 'Alice is on it. Tell her your sizes.';
            return;
          }
          if (sizeSheetOpen) {
            closeSizeSheet();
          } else {
            openSizeSheet();
          }
        },
      },
      'Add the look to bag'
    );
    const tryOnStatusEl = el('p', {
      className: 'stage-tryon-status',
      'aria-live': 'polite',
      hidden: true,
    });

    const lookNameEl = el('h1', { className: 'stage-look-name' }, lookLabel);
    const lookTotalEl = el('span', { className: 'stage-look-total' }, formatPrice(look.total));
    notesCol = el(
      'aside',
      { className: 'stage-notes-col', 'aria-label': "Alice's notes" },
      el(
        'div',
        { className: 'stage-notes-header' },
        el('span', { className: 'section-label stage-notes-kicker' }, "Alice's notes"),
        el(
          'div',
          { className: 'stage-notes-title-row' },
          lookNameEl,
          lookTotalEl
        )
      ),
      pieceNotesList,
      el(
        'div',
        { className: 'stage-notes-footer' },
        el('div', { className: 'summary-cta-row' }, addLookBtn, ctaStatus),
        sizeSheetEl,
        bagFallbackEl,
        tryOnStatusEl
      )
    );

    const stage = el(
      'section',
      { className: 'picked-stage', 'aria-label': 'Look stage' },
      visualCol,
      notesCol
    );

    const piecesCount = piecesWithOccurrence.length;
    const shopGrid = el(
      'div',
      { className: 'shop-look-grid' },
      piecesWithOccurrence.map(({ piece, occurrence }) =>
        buildProductCard(piece, look.number, {
          compact: false,
          pointed: Boolean(
            state.highlightedSlot &&
              piece.slot === state.highlightedSlot &&
              occurrence === state.highlightedOccurrence
          ),
          occurrence,
        })
      )
    );

    const shopCountEl = el(
      'span',
      { className: 'shop-look-count' },
      `${piecesCount} ${piecesCount === 1 ? 'piece' : 'pieces'}`
    );
    const shopSection = el(
      'section',
      { className: 'shop-look-section', 'aria-label': 'Shop the look' },
      el(
        'div',
        { className: 'shop-look-head' },
        el('h2', { className: 'shop-look-title' }, 'Shop the look'),
        shopCountEl
      ),
      shopGrid
    );

    activePickedRefs = {
      outfit: look.number,
      lookLabel,
      lookNameEl,
      lookTotalEl,
      shopCountEl,
      stagePanel,
      boardLayer,
      boardFrame,
      collageImg,
      pointerRing,
      tryOnLayer,
      tryOnImg,
      stageVideo,
      videoPlayBtn,
      videoPlayLabel,
      stageCaption,
      stageCaptionText,
      downloadLink,
      renderStrip,
      renderTiles: new Map(),
      thumbBtn,
      thumbImg,
      thumbLabel,
      tryOnStatusEl,
      closeSizeSheet,
      pieceNotesList,
      shopGrid,
      boardDrop: null,
      spotlight: null,
      stageMotion: null,
      swapState: null,
      pieceState: null,
      lastShownRenderKey: null,
    };

    mainEl.replaceChildren(el('div', { className: 'picked-view' }, topBar, stage, shopSection));
    applyStageState(activePickedRefs, media, { deferReveal, curtainReveal });
    updateNavActive();
  }

  function applyPointerInPlace(slot, occurrence = 1) {
    if (!activePickedRefs) return;
    flushPendingSwap(activePickedRefs);
    const normalized = typeof slot === 'string' && slot.trim() ? slot.trim() : null;
    const targetOcc = normalized && Number.isInteger(occurrence) && occurrence >= 1 ? occurrence : 1;
    const targetOccStr = String(targetOcc);

    for (const card of activePickedRefs.shopGrid.querySelectorAll('.product-card')) {
      const match = Boolean(
        normalized && card.dataset.slot === normalized && card.dataset.occurrence === targetOccStr
      );
      card.classList.toggle('is-pointed', match);
    }

    let activeRow = null;
    for (const row of activePickedRefs.pieceNotesList.querySelectorAll('.piece-note-item')) {
      const match = Boolean(
        normalized && row.dataset.slot === normalized && row.dataset.occurrence === targetOccStr
      );
      row.classList.toggle('is-pointed', match);
      if (match) activeRow = row;
    }
    activePickedRefs.pieceNotesList.classList.toggle('has-active', Boolean(activeRow));

    updateBoardPointerRing(activePickedRefs, getMedia(activePickedRefs.outfit), normalized, targetOcc);

    if (activeRow) {
      scrollRowIntoList(activePickedRefs.pieceNotesList, activeRow);
    }
  }

  // Validate a normalized [0, 1] pointer coordinate across the displayed piece image
  function normalizePiecePoint(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const { x, y } = raw;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  // Compute the displayed image box inside an object-fit: contain img relative to its container
  function getContainedImageRect(img, container) {
    if (!img || !container) return null;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return null;

    const containerRect = container.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    const boxW = imgRect.width;
    const boxH = imgRect.height;
    if (boxW <= 0 || boxH <= 0) return null;

    const imgRatio = nw / nh;
    const boxRatio = boxW / boxH;
    let dispW;
    let dispH;
    if (imgRatio > boxRatio) {
      dispW = boxW;
      dispH = boxW / imgRatio;
    } else {
      dispH = boxH;
      dispW = boxH * imgRatio;
    }

    return {
      left: imgRect.left - containerRect.left + (boxW - dispW) / 2,
      top: imgRect.top - containerRect.top + (boxH - dispH) / 2,
      width: dispW,
      height: dispH,
      containerWidth: containerRect.width,
      containerHeight: containerRect.height,
    };
  }

  function isShowingPiece(panelRefs) {
    return Boolean(panelRefs && panelRefs.pieceState && panelRefs.pieceState.layer);
  }

  // Resolve 1-based slot occurrence using highlight's rules, preferring an exact item match on repeated slots
  function resolvePieceOccurrence(look, rawSlot, item, sameLook) {
    const parsed = parseHighlightPiece(rawSlot);
    const slot = parsed.slot;
    if (!slot) return { slot: null, occurrence: null };

    const pieces = Array.isArray(look?.pieces) ? look.pieces : [];
    const slotCount = countSlotPieces(look, slot);

    if (parsed.hasHash) {
      const occ =
        parsed.explicitOccurrence !== null && parsed.explicitOccurrence <= slotCount
          ? parsed.explicitOccurrence
          : 1;
      return { slot, occurrence: occ };
    }

    if (slotCount > 1 && item && typeof item === 'object') {
      let occ = 0;
      const matched = [];
      for (const piece of pieces) {
        if (piece && piece.slot === slot) {
          occ += 1;
          if (itemMatches(piece.item, item)) matched.push(occ);
        }
      }
      if (matched.length === 1) {
        return { slot, occurrence: matched[0] };
      }
    }

    if (sameLook && state.highlightedSlot === slot && slotCount > 1) {
      const currentOcc =
        Number.isInteger(state.highlightedOccurrence) && state.highlightedOccurrence >= 1
          ? state.highlightedOccurrence
          : 1;
      return { slot, occurrence: currentOcc >= slotCount ? 1 : currentOcc + 1 };
    }

    return { slot, occurrence: 1 };
  }

  // Mark the active piece in the notes list and shop grid without showing the flat-lay board ring
  function syncPieceListHighlight(panelRefs, slot, occurrence = 1) {
    if (!panelRefs) return;
    flushPendingSwap(panelRefs);
    const normalized = typeof slot === 'string' && slot.trim() ? slot.trim() : null;
    const targetOcc = normalized && Number.isInteger(occurrence) && occurrence >= 1 ? occurrence : 1;
    const targetOccStr = String(targetOcc);

    for (const card of panelRefs.shopGrid.querySelectorAll('.product-card')) {
      const match = Boolean(
        normalized && card.dataset.slot === normalized && card.dataset.occurrence === targetOccStr
      );
      card.classList.toggle('is-pointed', match);
    }

    let activeRow = null;
    for (const row of panelRefs.pieceNotesList.querySelectorAll('.piece-note-item')) {
      const match = Boolean(
        normalized && row.dataset.slot === normalized && row.dataset.occurrence === targetOccStr
      );
      row.classList.toggle('is-pointed', match);
      if (match) activeRow = row;
    }
    panelRefs.pieceNotesList.classList.toggle('has-active', Boolean(activeRow));

    if (activeRow) {
      scrollRowIntoList(panelRefs.pieceNotesList, activeRow);
    }
  }

  // Preload the next piece image in the look so stepping forward crossfades without waiting
  function preloadUpcomingPiece(look, media, currentSlot, currentOcc, currentIndex, currentSrc) {
    const pieces = Array.isArray(look?.pieces) ? look.pieces : [];
    if (pieces.length < 2) return;
    let upcoming = null;
    if (currentSlot) {
      let occ = 0;
      for (let i = 0; i < pieces.length; i += 1) {
        if (pieces[i]?.slot === currentSlot) {
          occ += 1;
          if (occ === (currentOcc || 1)) {
            upcoming = pieces[i + 1] || null;
            break;
          }
        }
      }
    }
    if (!upcoming && Number.isInteger(currentIndex) && currentIndex >= 1 && currentIndex < pieces.length) {
      upcoming = pieces[currentIndex] || null;
    }
    const nextRaw = upcoming?.item?.image;
    if (typeof nextRaw === 'string' && nextRaw.trim()) {
      const upcomingUrl = stageUrl(nextRaw.trim(), 900);
      if (upcomingUrl && upcomingUrl !== currentSrc) {
        preloadImage(media, upcomingUrl);
      }
    }
  }

  function cancelPendingPieceLoad(ps) {
    if (!ps) return;
    ps.pendingSeq += 1;
    if (ps.pendingTimeout) {
      clearTimeout(ps.pendingTimeout);
      ps.pendingTimeout = null;
    }
    if (ps.pendingImg) {
      ps.pendingImg.onload = null;
      ps.pendingImg.onerror = null;
      ps.pendingImg = null;
    }
  }

  function cancelPieceCrossfade(ps) {
    if (!ps) return;
    if (ps.crossfadeTimer) {
      clearTimeout(ps.crossfadeTimer);
      ps.crossfadeTimer = null;
    }
    if (ps.outgoingImg) {
      ps.outgoingImg.remove();
      ps.outgoingImg = null;
    }
    if (ps.activeImg) {
      ps.activeImg.classList.remove('is-piece-fade-start');
    }
  }

  // Position the pointer dot and note pill relative to the displayed product image
  function positionPieceAnnotations(panelRefs) {
    const ps = panelRefs && panelRefs.pieceState;
    if (!ps || !ps.layer || !ps.mediaEl || !ps.activeImg || !ps.spec) return;
    const { mediaEl, activeImg, dotEl, pillEl, counterEl, spec } = ps;
    const hasPoint = Boolean(spec.point);
    const hasNote = Boolean(spec.note);

    if (!hasPoint && !hasNote) {
      dotEl.hidden = true;
      pillEl.hidden = true;
      return;
    }

    if (activeImg.hidden || !activeImg.complete || activeImg.naturalWidth <= 0) {
      dotEl.hidden = true;
      pillEl.hidden = true;
      return;
    }

    const rect = getContainedImageRect(activeImg, mediaEl);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      dotEl.hidden = true;
      pillEl.hidden = true;
      return;
    }

    const pad = 8;
    const cw = rect.containerWidth;
    const ch = rect.containerHeight;

    if (hasPoint) {
      const px = rect.left + spec.point.x * rect.width;
      const py = rect.top + spec.point.y * rect.height;
      dotEl.style.left = `${px}px`;
      dotEl.style.top = `${py}px`;
      dotEl.hidden = false;

      if (!hasNote) {
        pillEl.hidden = true;
        return;
      }

      pillEl.textContent = spec.note;
      pillEl.hidden = false;
      const pillW = pillEl.offsetWidth;
      const pillH = pillEl.offsetHeight;
      const gap = 12;
      const maxLeft = Math.max(pad, cw - pad - pillW);
      const maxTop = Math.max(pad, ch - pad - pillH);

      let pillLeft;
      let pillTop;
      if (px + gap + pillW <= cw - pad) {
        pillLeft = px + gap;
        pillTop = Math.min(maxTop, Math.max(pad, py - pillH / 2));
      } else if (px - gap - pillW >= pad) {
        pillLeft = px - gap - pillW;
        pillTop = Math.min(maxTop, Math.max(pad, py - pillH / 2));
      } else {
        pillLeft = Math.min(maxLeft, Math.max(pad, px - pillW / 2));
        pillTop =
          py - gap - pillH >= pad
            ? py - gap - pillH
            : Math.min(maxTop, Math.max(pad, py + gap));
      }

      pillEl.style.left = `${pillLeft}px`;
      pillEl.style.top = `${pillTop}px`;
      return;
    }

    // Note without point: center the pill along the top edge of the displayed image
    dotEl.hidden = true;
    pillEl.textContent = spec.note;
    pillEl.hidden = false;
    const pillW = pillEl.offsetWidth;
    const pillH = pillEl.offsetHeight;
    const maxLeft = Math.max(pad, cw - pad - pillW);
    const maxTop = Math.max(pad, ch - pad - pillH);
    const imgCenterX = rect.left + rect.width / 2;
    let pillLeft = Math.min(maxLeft, Math.max(pad, imgCenterX - pillW / 2));
    const pillTop = Math.min(maxTop, Math.max(pad, rect.top + 8));

    if (counterEl && !counterEl.hidden && pillTop < 40) {
      const counterRightLimit = cw - counterEl.offsetWidth - 20;
      if (pillLeft + pillW > counterRightLimit) {
        pillLeft = Math.max(pad, counterRightLimit - pillW);
      }
    }

    pillEl.style.left = `${pillLeft}px`;
    pillEl.style.top = `${pillTop}px`;
  }

  function ensurePieceLayerDom(panelRefs, ps) {
    if (ps.layer) return;
    const canvasEl = el('div', { className: 'stage-piece-canvas' });
    const dotEl = el('span', { className: 'stage-piece-dot', 'aria-hidden': 'true', hidden: true });
    const pillEl = el('span', { className: 'stage-piece-pill', hidden: true });
    const mediaEl = el('div', { className: 'stage-piece-media' }, canvasEl, dotEl, pillEl);
    const counterEl = el('span', { className: 'stage-piece-counter', hidden: true });
    const slotEl = el('span', { className: 'stage-piece-slot' });
    const titleEl = el('span', { className: 'stage-piece-title' });
    const priceEl = el('span', { className: 'stage-piece-price', hidden: true });
    const barEl = el(
      'div',
      { className: 'stage-piece-bar' },
      el('div', { className: 'stage-piece-meta' }, slotEl, titleEl),
      priceEl
    );
    const layer = el(
      'div',
      { className: 'stage-piece-layer', 'aria-label': 'Piece close-up' },
      mediaEl,
      counterEl,
      barEl
    );

    ps.layer = layer;
    ps.mediaEl = mediaEl;
    ps.canvasEl = canvasEl;
    ps.dotEl = dotEl;
    ps.pillEl = pillEl;
    ps.counterEl = counterEl;
    ps.slotEl = slotEl;
    ps.titleEl = titleEl;
    ps.priceEl = priceEl;

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => {
        if (state.view === 'picked' && activePickedRefs === panelRefs && panelRefs.pieceState === ps) {
          positionPieceAnnotations(panelRefs);
        }
      });
      ro.observe(mediaEl);
      ps.resizeObserver = ro;
    } else {
      const onResize = () => {
        if (state.view === 'picked' && activePickedRefs === panelRefs && panelRefs.pieceState === ps) {
          positionPieceAnnotations(panelRefs);
        }
      };
      window.addEventListener('resize', onResize, { passive: true });
      ps.resizeHandler = onResize;
    }

    panelRefs.stagePanel.appendChild(layer);
    if (!prefersReducedMotion()) {
      layer.classList.add('is-piece-entering');
      void layer.offsetWidth;
      layer.classList.remove('is-piece-entering');
    }
    panelRefs.stagePanel.classList.add('is-showing-piece');

    if (panelRefs.pointerRing) {
      panelRefs.pointerRing.classList.remove('is-visible');
      panelRefs.pointerRing.setAttribute('aria-hidden', 'true');
    }
    clearBoardSpotlight(panelRefs, { immediate: true });
    cancelBoardDropIn(panelRefs);
  }

  function updatePieceMetadata(ps, spec) {
    ps.slotEl.textContent = formatSlot(spec.slot);
    ps.titleEl.textContent = spec.title;
    if (spec.priceText) {
      ps.priceEl.textContent = spec.priceText;
      ps.priceEl.hidden = false;
    } else {
      ps.priceEl.textContent = '';
      ps.priceEl.hidden = true;
    }
    if (spec.counterText) {
      ps.counterEl.textContent = spec.counterText;
      ps.counterEl.hidden = false;
    } else {
      ps.counterEl.textContent = '';
      ps.counterEl.hidden = true;
    }
  }

  function commitPieceToStage(panelRefs, ps, spec, nextImg, { loaded = true } = {}) {
    if (state.view !== 'picked' || activePickedRefs !== panelRefs || panelRefs.pieceState !== ps) {
      return;
    }
    const wasShowing = Boolean(ps.layer);
    const prevSpec = ps.spec;
    const prevImg = ps.activeImg;
    const reduced = prefersReducedMotion();

    ps.spec = spec;
    ensurePieceLayerDom(panelRefs, ps);
    updatePieceMetadata(ps, spec);

    if (
      wasShowing &&
      prevImg &&
      prevSpec &&
      prevSpec.src === spec.src &&
      !prevImg.hidden &&
      prevImg.complete &&
      prevImg.naturalWidth > 0
    ) {
      positionPieceAnnotations(panelRefs);
      return;
    }

    if (prevImg && prevImg !== nextImg) {
      prevImg.onload = null;
      prevImg.onerror = null;
    }

    if (wasShowing && prevImg && prevImg !== nextImg) {
      cancelPieceCrossfade(ps);
      if (!reduced && loaded && !prevImg.hidden) {
        prevImg.classList.add('stage-piece-img--out');
        ps.outgoingImg = prevImg;
        nextImg.hidden = false;
        nextImg.classList.remove('stage-piece-img--out', 'is-piece-fade-out');
        nextImg.classList.add('is-piece-fade-start');
        ps.canvasEl.appendChild(nextImg);
        ps.activeImg = nextImg;
        void nextImg.offsetWidth;
        prevImg.classList.add('is-piece-fade-out');
        nextImg.classList.remove('is-piece-fade-start');
        ps.crossfadeTimer = setTimeout(() => {
          if (panelRefs.pieceState === ps) cancelPieceCrossfade(ps);
        }, 320);
      } else {
        prevImg.remove();
        nextImg.hidden = !loaded;
        nextImg.classList.remove('is-piece-fade-start', 'stage-piece-img--out', 'is-piece-fade-out');
        ps.canvasEl.appendChild(nextImg);
        ps.activeImg = nextImg;
      }
    } else {
      nextImg.hidden = !loaded;
      nextImg.classList.remove('is-piece-fade-start', 'stage-piece-img--out', 'is-piece-fade-out');
      ps.canvasEl.replaceChildren(nextImg);
      ps.activeImg = nextImg;
    }

    positionPieceAnnotations(panelRefs);
  }

  function closePieceLayer(panelRefs, { clearHighlight = false } = {}) {
    if (!panelRefs) return;
    const ps = panelRefs.pieceState;
    if (ps) {
      cancelPendingPieceLoad(ps);
      cancelPieceCrossfade(ps);
      if (ps.activeImg) {
        ps.activeImg.onload = null;
        ps.activeImg.onerror = null;
      }
      if (ps.resizeObserver) {
        ps.resizeObserver.disconnect();
        ps.resizeObserver = null;
      }
      if (ps.resizeHandler) {
        window.removeEventListener('resize', ps.resizeHandler);
        ps.resizeHandler = null;
      }
      if (ps.layer) {
        ps.layer.remove();
      }
      panelRefs.pieceState = null;
    }
    if (panelRefs.stagePanel) {
      panelRefs.stagePanel.classList.remove('is-showing-piece');
    }
    if (clearHighlight && activePickedRefs === panelRefs) {
      state.highlightedSlot = null;
      state.highlightedOccurrence = null;
      applyPointerInPlace(null, null);
      clearBoardSpotlight(panelRefs, { immediate: true });
      if (panelRefs.pointerRing) {
        panelRefs.pointerRing.style.left = '';
        panelRefs.pointerRing.style.top = '';
        panelRefs.pointerRing.style.width = '';
        panelRefs.pointerRing.style.height = '';
      }
    }
  }

  function showPieceOnStage(panelRefs, look, media, spec, prevHighlight) {
    if (!panelRefs.pieceState) {
      panelRefs.pieceState = {
        layer: null,
        mediaEl: null,
        canvasEl: null,
        activeImg: null,
        outgoingImg: null,
        dotEl: null,
        pillEl: null,
        counterEl: null,
        slotEl: null,
        titleEl: null,
        priceEl: null,
        spec: null,
        crossfadeTimer: null,
        pendingSeq: 0,
        pendingImg: null,
        pendingTimeout: null,
        prePendingHighlight: null,
        resizeObserver: null,
        resizeHandler: null,
      };
    }
    const ps = panelRefs.pieceState;
    preloadUpcomingPiece(look, media, spec.slot, spec.occurrence, spec.index, spec.src);

    // Same image already on screen: update copy and pointer in place without reloading
    if (
      ps.layer &&
      ps.activeImg &&
      ps.spec &&
      ps.spec.src === spec.src &&
      !ps.activeImg.hidden &&
      ps.activeImg.complete &&
      ps.activeImg.naturalWidth > 0
    ) {
      cancelPendingPieceLoad(ps);
      ps.prePendingHighlight = null;
      commitPieceToStage(panelRefs, ps, spec, ps.activeImg, { loaded: true });
      return;
    }

    if (!ps.prePendingHighlight) {
      ps.prePendingHighlight =
        ps.layer && ps.spec
          ? { slot: ps.spec.slot, occurrence: ps.spec.occurrence }
          : prevHighlight;
    }

    cancelPendingPieceLoad(ps);
    const seq = ps.pendingSeq;
    const wasShowing = Boolean(ps.layer);

    const nextImg = el('img', {
      className: 'stage-piece-img',
      alt: spec.title || formatSlot(spec.slot),
      decoding: 'async',
    });

    let settled = false;

    const handleError = () => {
      if (settled) return;
      settled = true;
      nextImg.onload = null;
      nextImg.onerror = null;
      if (ps.pendingTimeout) {
        clearTimeout(ps.pendingTimeout);
        ps.pendingTimeout = null;
      }
      if (ps.pendingImg === nextImg) ps.pendingImg = null;
      if (
        state.view !== 'picked' ||
        activePickedRefs !== panelRefs ||
        panelRefs.pieceState !== ps ||
        ps.pendingSeq !== seq
      ) {
        return;
      }
      const fallback = ps.prePendingHighlight;
      ps.prePendingHighlight = null;
      if (fallback) {
        state.highlightedSlot = fallback.slot;
        state.highlightedOccurrence = fallback.occurrence;
        syncPieceListHighlight(panelRefs, fallback.slot, fallback.occurrence);
      }
      if (!ps.layer) {
        panelRefs.pieceState = null;
      }
    };

    const finishLoad = () => {
      if (settled) return;
      if (nextImg.naturalWidth <= 0) {
        handleError();
        return;
      }
      settled = true;
      nextImg.onload = null;
      nextImg.onerror = null;
      if (ps.pendingTimeout) {
        clearTimeout(ps.pendingTimeout);
        ps.pendingTimeout = null;
      }
      if (ps.pendingImg === nextImg) ps.pendingImg = null;
      if (
        state.view !== 'picked' ||
        activePickedRefs !== panelRefs ||
        panelRefs.pieceState !== ps ||
        ps.pendingSeq !== seq
      ) {
        return;
      }
      ps.prePendingHighlight = null;
      commitPieceToStage(panelRefs, ps, spec, nextImg, { loaded: true });
    };

    ps.pendingImg = nextImg;
    nextImg.onload = finishLoad;
    nextImg.onerror = handleError;
    nextImg.src = spec.src;

    if (nextImg.complete && nextImg.naturalWidth > 0) {
      finishLoad();
      return;
    }

    // Moving between pieces: hold the old image until loaded, and for at most 1.5 s
    if (wasShowing) {
      ps.pendingTimeout = setTimeout(() => {
        if (settled) return;
        if (
          state.view !== 'picked' ||
          activePickedRefs !== panelRefs ||
          panelRefs.pieceState !== ps ||
          ps.pendingSeq !== seq
        ) {
          return;
        }
        settled = true;
        ps.pendingTimeout = null;
        if (ps.pendingImg === nextImg) ps.pendingImg = null;
        const fallbackHighlight = ps.prePendingHighlight;
        ps.prePendingHighlight = null;
        const fallbackSpec = ps.spec;
        const fallbackImg = ps.activeImg && !ps.activeImg.hidden ? ps.activeImg : null;

        commitPieceToStage(panelRefs, ps, spec, nextImg, { loaded: false });

        const restoreAfterLateError = () => {
          nextImg.onload = null;
          nextImg.onerror = null;
          if (
            state.view !== 'picked' ||
            activePickedRefs !== panelRefs ||
            panelRefs.pieceState !== ps ||
            ps.activeImg !== nextImg
          ) {
            return;
          }
          if (fallbackImg && fallbackSpec) {
            commitPieceToStage(panelRefs, ps, fallbackSpec, fallbackImg, { loaded: true });
            if (fallbackHighlight) {
              state.highlightedSlot = fallbackHighlight.slot;
              state.highlightedOccurrence = fallbackHighlight.occurrence;
              syncPieceListHighlight(panelRefs, fallbackHighlight.slot, fallbackHighlight.occurrence);
            }
          } else {
            closePieceLayer(panelRefs, { clearHighlight: true });
          }
        };

        nextImg.onload = () => {
          nextImg.onload = null;
          nextImg.onerror = null;
          if (
            state.view !== 'picked' ||
            activePickedRefs !== panelRefs ||
            panelRefs.pieceState !== ps ||
            ps.activeImg !== nextImg
          ) {
            return;
          }
          if (nextImg.naturalWidth <= 0) {
            restoreAfterLateError();
            return;
          }
          nextImg.hidden = false;
          if (!prefersReducedMotion()) {
            nextImg.classList.add('is-piece-fade-start');
            void nextImg.offsetWidth;
            nextImg.classList.remove('is-piece-fade-start');
          }
          positionPieceAnnotations(panelRefs);
        };
        nextImg.onerror = restoreAfterLateError;
      }, 1500);
    }
  }

  function flashUpdatedSlot(outfitNumber, slot) {
    if (!slot) return;
    const selector = `[data-outfit="${CSS.escape(String(outfitNumber))}"][data-slot="${CSS.escape(slot)}"]`;
    const nodes = mainEl.querySelectorAll(selector);
    for (const node of nodes) {
      node.classList.remove('is-updated-flash');
      void node.offsetWidth;
      node.classList.add('is-updated-flash');
      setTimeout(() => node.classList.remove('is-updated-flash'), 1250);
    }
    if (state.view === 'picked' && activePickedRefs && activePickedRefs.outfit === outfitNumber) {
      const row = activePickedRefs.pieceNotesList.querySelector(
        `.piece-note-item[data-slot="${CSS.escape(slot)}"]`
      );
      if (row) scrollRowIntoList(activePickedRefs.pieceNotesList, row);
    }
  }

  function syncMediaInCurrentView(
    outfitNumber,
    { deferReveal = false, fadeRender = false, newlyArrivedKind = null, curtainReveal = false } = {}
  ) {
    const media = getMedia(outfitNumber);
    if (state.view === 'looks') {
      const escaped = CSS.escape(String(outfitNumber));
      const badge = mainEl.querySelector(`[data-tryon-badge="${escaped}"]`);
      if (badge) renderTryOnBadge(badge, media.tryOnStatus);
      const visualEl = mainEl.querySelector(`[data-look-visual="${escaped}"]`);
      if (visualEl) {
        const boardLayer = visualEl.querySelector('.look-board-layer');
        const boardImg = visualEl.querySelector('.look-board-img');
        applyLookCardCollage(visualEl, boardLayer, boardImg, media.collageUrl);
      }
    } else if (state.view === 'picked' && activePickedRefs && activePickedRefs.outfit === outfitNumber) {
      applyStageState(activePickedRefs, media, { deferReveal, fadeRender, newlyArrivedKind, curtainReveal });
    }
  }

  function normalizeOutfit(raw, fallbackNumber) {
    const num =
      typeof raw.number === 'number' && Number.isFinite(raw.number) ? raw.number : fallbackNumber;
    return {
      ...raw,
      number: num,
      pieces: Array.isArray(raw.pieces) ? raw.pieces : [],
    };
  }

  function leaveSearchView() {
    if (!searchSlotEl.hidden || searchSlotEl.childNodes.length > 0) {
      searchSlotEl.replaceChildren();
      searchSlotEl.hidden = true;
    }
    mainEl.hidden = false;
  }

  // Resolve the look number only when the item belongs to a look currently on screen
  function findLookNumberForItem(item, hintOutfitNumber) {
    if (state.view === 'picked' && state.pickedOutfit !== null) {
      const picked = state.outfits.get(state.pickedOutfit);
      if (picked && (picked.pieces || []).some((p) => itemMatches(p?.item, item))) {
        return state.pickedOutfit;
      }
      return null;
    }
    if (state.view === 'looks') {
      if (typeof hintOutfitNumber === 'number' && state.outfits.has(hintOutfitNumber)) {
        const hinted = state.outfits.get(hintOutfitNumber);
        if (hinted && (hinted.pieces || []).some((p) => itemMatches(p?.item, item))) {
          return hintOutfitNumber;
        }
      }
      for (const look of sortedOutfits()) {
        if ((look.pieces || []).some((p) => itemMatches(p?.item, item))) {
          return look.number;
        }
      }
    }
    return null;
  }

  function closeProductPanel({ sync = true } = {}) {
    if (productAbortController) {
      productAbortController.abort();
      productAbortController = null;
    }
    productReqId += 1;
    state.productOpen = false;
    productLayerEl.classList.remove('is-open');
    productLayerEl.setAttribute('aria-hidden', 'true');
    if (sync) syncPanelOpen();
  }

  function hasDrawerContent() {
    if (state.drawerMode === 'review') return Boolean(state.orderReview);
    if (state.drawerMode === 'result') return Boolean(state.orderResult);
    return Boolean(state.bagData);
  }

  function closeBagDrawer() {
    state.bagOpen = false;
    bagLayerEl.classList.remove('is-open');
    bagLayerEl.setAttribute('aria-hidden', 'true');
    syncPanelOpen();
  }

  function openBagDrawer() {
    if (!hasDrawerContent()) return;
    // Opening the bag closes the product page first without flickering panel-open
    closeProductPanel({ sync: false });
    state.bagOpen = true;
    bagLayerEl.classList.add('is-open');
    bagLayerEl.setAttribute('aria-hidden', 'false');
    syncPanelOpen();
  }

  function renderProductPanel(payload, lookNum) {
    const item = payload.item || {};
    const slotText = typeof payload.slot === 'string' ? payload.slot.trim() : '';

    // Breadcrumb: Alice's boutique or Looks by Alice [/ Look N] [/ Slot]
    const crumbParts = [state.view === 'boutique' ? "Alice's boutique" : 'Looks by Alice'];
    if (lookNum !== null) crumbParts.push(`Look ${lookNum}`);
    if (slotText) crumbParts.push(formatSlot(slotText));

    const crumbNodes = [];
    crumbParts.forEach((label, idx) => {
      if (idx > 0) {
        crumbNodes.push(el('span', { className: 'breadcrumb-sep', 'aria-hidden': 'true' }, '/'));
      }
      crumbNodes.push(
        el('span', { className: idx === crumbParts.length - 1 ? 'breadcrumb-current' : null }, label)
      );
    });
    productBreadcrumbEl.replaceChildren(...crumbNodes);

    // Gallery: up to 6 unique images, falling back to item.image
    const rawImages = Array.isArray(payload.images) ? payload.images : [];
    const seenImages = new Set();
    const galleryImages = [];
    for (const src of rawImages) {
      if (typeof src === 'string' && src.trim() && !seenImages.has(src.trim())) {
        seenImages.add(src.trim());
        galleryImages.push(src.trim());
        if (galleryImages.length >= 6) break;
      }
    }
    if (galleryImages.length === 0 && typeof item.image === 'string' && item.image.trim()) {
      galleryImages.push(item.image.trim());
    }

    let gallerySection = null;
    if (galleryImages.length > 0) {
      const mainImg = el('img', {
        className: 'product-gallery-img',
        src: sized(galleryImages[0], 900),
        alt: item.title || 'Garment',
        decoding: 'async',
        onError: (e) => {
          e.currentTarget.hidden = true;
        },
      });

      const thumbButtons = [];
      const thumbsRow = el(
        'div',
        { className: 'product-gallery-thumbs', role: 'group', 'aria-label': 'Product images' },
        galleryImages.map((url, idx) => {
          const btn = el(
            'button',
            {
              type: 'button',
              className: `product-thumb${idx === 0 ? ' is-active' : ''}`,
              'aria-label': `View image ${idx + 1}`,
              'aria-pressed': idx === 0 ? 'true' : 'false',
              onClick: () => {
                mainImg.hidden = false;
                mainImg.src = sized(url, 900);
                thumbButtons.forEach((other, i) => {
                  const active = i === idx;
                  other.classList.toggle('is-active', active);
                  other.setAttribute('aria-pressed', active ? 'true' : 'false');
                });
              },
            },
            el('img', {
              className: 'product-thumb-img',
              src: sized(url, 160),
              alt: '',
              loading: 'lazy',
              decoding: 'async',
              onError: (e) => {
                e.currentTarget.hidden = true;
                if (e.currentTarget.parentElement) {
                  e.currentTarget.parentElement.hidden = true;
                }
              },
            })
          );
          thumbButtons.push(btn);
          return btn;
        })
      );

      gallerySection = el(
        'div',
        { className: 'product-gallery' },
        el('div', { className: 'product-gallery-main' }, mainImg),
        thumbsRow
      );
    }

    const ratingEl =
      typeof item.rating === 'number' && Number.isFinite(item.rating)
        ? el(
            'span',
            { className: 'product-rating' },
            starSvg(),
            el(
              'span',
              null,
              item.rating_count !== null && item.rating_count !== undefined
                ? `${item.rating.toFixed(1)} (${Number(item.rating_count).toLocaleString()})`
                : item.rating.toFixed(1)
            )
          )
        : null;

    const eyebrowChildren = [];
    if (item.store) {
      eyebrowChildren.push(el('span', { className: 'product-store' }, item.store));
    }
    if (slotText) {
      if (eyebrowChildren.length > 0) {
        eyebrowChildren.push(el('span', { className: 'product-eyebrow-sep', 'aria-hidden': 'true' }, '·'));
      }
      eyebrowChildren.push(el('span', { className: 'product-panel-slot' }, formatSlot(slotText)));
    }

    const metaSection = el(
      'div',
      { className: 'product-panel-meta' },
      eyebrowChildren.length > 0 ? el('div', { className: 'product-panel-eyebrow' }, eyebrowChildren) : null,
      el('h2', { className: 'product-panel-title' }, item.title || ''),
      el(
        'div',
        { className: 'product-panel-price-row' },
        el('span', { className: 'product-panel-price' }, formatPrice(item.price)),
        ratingEl
      )
    );

    // Selectable size chips: prefer sizes_detail (with sold-out state), falling back to sizes / item.sizes
    const rawSizesDetail = Array.isArray(payload.sizes_detail)
      ? payload.sizes_detail
          .filter((entry) => entry && typeof entry === 'object' && typeof entry.label === 'string' && entry.label.trim())
          .map((entry) => ({
            label: entry.label.trim(),
            available: entry.available !== false,
          }))
      : [];

    const rawSizes =
      Array.isArray(payload.sizes) && payload.sizes.length > 0
        ? payload.sizes
        : Array.isArray(item.sizes)
          ? item.sizes
          : [];
    const sizes = normalizeSizeList(rawSizes);
    const availableSizes =
      rawSizesDetail.length > 0
        ? rawSizesDetail.filter((entry) => entry.available).map((entry) => entry.label)
        : sizes;
    const allSoldOut = rawSizesDetail.length > 0 && availableSizes.length === 0;

    const itemKey = pieceIdentity({ item });
    const prevPicked = itemKey ? productSelectedSizes.get(itemKey) || '' : '';
    const rememberedSlot = getRememberedSlotSize(slotText);
    let selectedSize =
      (prevPicked && availableSizes.find((s) => s.toLowerCase() === prevPicked.toLowerCase())) ||
      (rememberedSlot && availableSizes.find((s) => s.toLowerCase() === rememberedSlot.toLowerCase())) ||
      availableSizes[0] ||
      '';

    const selectableChipButtons = [];
    const buildSelectableChip = (label) => {
      const isSelected = label === selectedSize;
      const btn = el(
        'button',
        {
          type: 'button',
          className: `size-chip size-chip--selectable${isSelected ? ' is-selected' : ''}`,
          'aria-pressed': isSelected ? 'true' : 'false',
          onClick: () => {
            selectedSize = label;
            if (itemKey) productSelectedSizes.set(itemKey, label);
            if (slotText) rememberSlotSize(slotText, label);
            for (const entry of selectableChipButtons) {
              const active = entry.label === label;
              entry.btn.classList.toggle('is-selected', active);
              entry.btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            }
          },
        },
        label
      );
      selectableChipButtons.push({ label, btn });
      return btn;
    };

    const sizeChipNodes =
      rawSizesDetail.length > 0
        ? rawSizesDetail.map((entry) =>
            entry.available
              ? buildSelectableChip(entry.label)
              : el(
                  'span',
                  {
                    className: 'size-chip size-chip--sold-out',
                    'aria-disabled': 'true',
                    'aria-label': `${entry.label}, sold out`,
                    title: 'Sold out',
                  },
                  entry.label
                )
          )
        : sizes.map((size) => buildSelectableChip(size));

    const whyText = typeof payload.why === 'string' ? payload.why.trim() : '';
    const productBagStatusEl = el('p', {
      className: 'bag-fallback-note product-bag-status',
      role: 'status',
      'aria-live': 'polite',
      hidden: true,
    });
    let productAddPending = false;
    const productAddBagBtn = el(
      'button',
      {
        type: 'button',
        className: 'btn-primary product-add-bag-btn',
        disabled: allSoldOut,
        onClick: async () => {
          if (allSoldOut) return;
          const title =
            typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'item';
          if (isCallLive()) {
            const msg = selectedSize
              ? `Add the ${title} in size ${selectedSize} to my bag.`
              : `Add the ${title} to my bag.`;
            sendToAlice(msg);
            productBagStatusEl.hidden = false;
            productBagStatusEl.replaceChildren('Alice is on it.');
            return;
          }
          if (productAddPending || directBagBusy) return;

          if (slotText && selectedSize) rememberSlotSize(slotText, selectedSize);
          const existingEntries =
            state.directBag && Array.isArray(state.directBag.entries)
              ? state.directBag.entries
              : [];
          const baseSlot =
            slotText ||
            (typeof item.slot === 'string' && item.slot.trim()) ||
            (typeof item.category === 'string' && item.category.trim()) ||
            'piece';
          const resolvedSlot = resolveProductBagSlot(baseSlot, existingEntries);
          const newEntry = {
            piece: {
              slot: resolvedSlot,
              ...(whyText ? { why: whyText } : {}),
              item,
            },
            size: selectedSize,
          };
          const nextEntries = [...existingEntries, newEntry];
          const department =
            state.directBag?.department || resolveBagDepartment(nextEntries.map((e) => e.piece));
          const outfit = buildBagOutfitPayload(nextEntries, {
            name: state.directBag?.name || title,
            number: state.directBag?.number ?? null,
          });
          const sizesMap = buildBagSizesMap(nextEntries);

          if (bagAbortController) bagAbortController.abort();
          const controller = new AbortController();
          bagAbortController = controller;
          const reqId = ++directBagReqId;

          productAddPending = true;
          directBagBusy = true;
          productAddBagBtn.disabled = true;
          productAddBagBtn.textContent = 'Adding…';
          productBagStatusEl.hidden = true;
          productBagStatusEl.replaceChildren();

          let data = null;
          try {
            data = await postBag(
              { department, outfit, sizes: sizesMap },
              { signal: controller.signal }
            );
          } finally {
            productAddPending = false;
            if (reqId === directBagReqId) {
              directBagBusy = false;
              bagAbortController = null;
            }
            productAddBagBtn.disabled = allSoldOut;
            productAddBagBtn.textContent = 'Add to bag';
          }

          if (reqId !== directBagReqId) return;

          if (!data) {
            renderBagFallbackInto(
              productBagStatusEl,
              'Talk to Alice and she will bag this for you.'
            );
            return;
          }

          state.directBag = {
            department,
            name: outfit.name,
            number: outfit.number,
            entries: nextEntries,
            sizes: sizesMap,
          };
          applyBagReady(data, { fromAlice: false });
        },
      },
      'Add to bag'
    );
    const productBagActions = el(
      'div',
      { className: 'product-bag-actions' },
      productAddBagBtn,
      productBagStatusEl
    );

    const sizesSection =
      sizeChipNodes.length > 0
        ? el(
            'section',
            { className: 'product-panel-block', 'aria-label': 'Available sizes' },
            el('h3', { className: 'section-label' }, 'Sizes'),
            el('div', { className: 'size-chips', role: 'group', 'aria-label': 'Choose a size' }, sizeChipNodes),
            productBagActions
          )
        : el('section', { className: 'product-panel-block' }, productBagActions);

    // Styling rationale box, hidden when empty
    const whySection = whyText
      ? el(
          'section',
          { className: 'product-why-box' },
          el('h3', { className: 'section-label product-why-heading' }, 'Why it works in the look'),
          el('p', { className: 'product-why-text' }, whyText)
        )
      : null;

    // Up to 5 details bullets and word-bounded 700-char description
    const details = Array.isArray(payload.details)
      ? payload.details
          .map((d) => (typeof d === 'string' ? d.trim() : ''))
          .filter(Boolean)
          .slice(0, 5)
      : [];

    const rawDesc =
      typeof payload.description === 'string' && payload.description.trim()
        ? payload.description
        : typeof item.description === 'string'
          ? item.description
          : '';
    const descText = truncateAtWord(rawDesc, 700);

    const copySection =
      details.length > 0 || descText
        ? el(
            'section',
            { className: 'product-panel-block' },
            details.length > 0
              ? el(
                  'ul',
                  { className: 'product-details-list' },
                  details.map((bullet) => el('li', null, bullet))
                )
              : null,
            descText ? el('p', { className: 'product-description' }, descText) : null
          )
        : null;

    const externalHref = safeExternalUrl(item.url);
    const storeLabel = typeof item.store === 'string' && item.store.trim() ? item.store.trim() : 'store';
    const ctaSection = externalHref
      ? el(
          'div',
          { className: 'product-panel-actions' },
          el(
            'a',
            {
              className: 'btn-primary product-panel-cta',
              href: externalHref,
              target: '_blank',
              rel: 'noopener',
            },
            `View at ${storeLabel}`
          )
        )
      : null;

    productBodyEl.replaceChildren(
      ...[gallerySection, metaSection, sizesSection, whySection, copySection, ctaSection].filter(Boolean)
    );
    productBodyEl.scrollTop = 0;
  }

  function setBagDrawerHeader(title) {
    bagTitleEl.textContent = title;
    bagSheetEl.setAttribute('aria-label', title);
  }

  function renderBagDrawer({ stores, links, total }) {
    setBagDrawerHeader('Your bag');
    bagFooterEl.hidden = false;
    bagBodyEl.classList.remove('bag-panel-body--no-footer');

    const linkByStore = new Map();
    for (const link of links) {
      if (link && typeof link.store === 'string' && typeof link.url === 'string') {
        const safeHref = safeExternalUrl(link.url);
        if (safeHref) {
          linkByStore.set(link.store, safeHref);
          linkByStore.set(link.store.trim().toLowerCase(), safeHref);
        }
      }
    }

    if (stores.length === 0) {
      bagBodyEl.replaceChildren(el('p', { className: 'bag-empty' }, 'Nothing in your bag yet.'));
    } else {
      const resolvedStores = stores.map((storeObj) => {
        const storeName =
          typeof storeObj.store === 'string' && storeObj.store.trim()
            ? storeObj.store.trim()
            : 'Store';
        const checkoutUrl =
          linkByStore.get(storeName) || linkByStore.get(storeName.toLowerCase()) || null;
        return { storeObj, storeName, checkoutUrl };
      });

      const checkoutLinkCount = resolvedStores.filter((entry) => Boolean(entry.checkoutUrl)).length;
      let linkIndex = 0;

      const storeNodes = resolvedStores.map(({ storeObj, storeName, checkoutUrl }, idx) => {
        const addedLines = Array.isArray(storeObj.added)
          ? storeObj.added.filter((line) => line && typeof line === 'object')
          : [];
        const notAddedLines = Array.isArray(storeObj.not_added)
          ? storeObj.not_added.filter((line) => line && typeof line === 'object')
          : [];
        const hasSubtotal =
          typeof storeObj.subtotal === 'number' && Number.isFinite(storeObj.subtotal);

        const addedList =
          addedLines.length > 0
            ? el(
                'ul',
                { className: 'bag-lines' },
                addedLines.map((line) => {
                  const thumbUrl = sized(line.image, 160);
                  const sizeText =
                    typeof line.size === 'string' && line.size.trim() ? line.size.trim() : '';
                  const lineTitle = typeof line.title === 'string' && line.title.trim() ? line.title.trim() : '';
                  const lineNoteEl = el('p', {
                    className: 'bag-fallback-note bag-line-note',
                    role: 'status',
                    'aria-live': 'polite',
                    hidden: true,
                  });
                  let rowEl;
                  const removeBtn = el(
                    'button',
                    {
                      type: 'button',
                      className: 'bag-line-remove',
                      'aria-label': lineTitle ? `Remove ${lineTitle} from bag` : 'Remove item from bag',
                      onClick: () => removeBagLine(line, storeName, rowEl, removeBtn, lineNoteEl),
                    },
                    'Remove'
                  );
                  rowEl = el(
                    'li',
                    { className: 'bag-line' },
                    el(
                      'div',
                      { className: 'bag-line-thumb' },
                      thumbUrl
                        ? el('img', {
                            className: 'bag-line-img',
                            src: thumbUrl,
                            alt: line.title || 'Garment',
                            loading: 'lazy',
                            decoding: 'async',
                          })
                        : null
                    ),
                    el(
                      'div',
                      { className: 'bag-line-info' },
                      el('span', { className: 'bag-line-title' }, line.title || ''),
                      sizeText ? el('span', { className: 'bag-line-size' }, `Size ${sizeText}`) : null,
                      removeBtn,
                      lineNoteEl
                    ),
                    el('span', { className: 'bag-line-price' }, formatPrice(line.price))
                  );
                  return rowEl;
                })
              )
            : null;

        const subtotalRow = hasSubtotal
          ? el(
              'div',
              { className: 'bag-store-subtotal' },
              el('span', { className: 'bag-store-subtotal-label' }, 'Subtotal'),
              el('span', { className: 'bag-store-subtotal-val' }, formatPrice(storeObj.subtotal))
            )
          : null;

        let checkoutBtn = null;
        if (checkoutUrl) {
          if (checkoutLinkCount >= 2) {
            linkIndex += 1;
            const storeKey = `${idx}::${storeName.toLowerCase()}::${checkoutUrl}`;
            const openedEl = el(
              'span',
              { className: 'bag-checkout-opened', hidden: !state.bagOpenedStores.has(storeKey) },
              'Opened'
            );
            checkoutBtn = el(
              'div',
              { className: 'bag-checkout-row' },
              el(
                'a',
                {
                  className: 'btn-primary bag-checkout-btn',
                  href: checkoutUrl,
                  target: '_blank',
                  rel: 'noopener',
                  onClick: () => {
                    state.bagOpenedStores.add(storeKey);
                    openedEl.hidden = false;
                  },
                },
                `Checkout at ${storeName} · ${linkIndex} of ${checkoutLinkCount}`
              ),
              openedEl
            );
          } else {
            checkoutBtn = el(
              'a',
              {
                className: 'btn-primary bag-checkout-btn',
                href: checkoutUrl,
                target: '_blank',
                rel: 'noopener',
              },
              `Checkout at ${storeName}`
            );
          }
        }

        const notAddedBox =
          notAddedLines.length > 0
            ? el(
                'div',
                { className: 'bag-not-added', role: 'note' },
                el('p', { className: 'bag-not-added-heading' }, 'Not added'),
                el(
                  'ul',
                  { className: 'bag-not-added-list' },
                  notAddedLines.map((na) =>
                    el(
                      'li',
                      { className: 'bag-not-added-item' },
                      el('span', { className: 'bag-not-added-title' }, na.title || ''),
                      typeof na.reason === 'string' && na.reason.trim()
                        ? el('span', { className: 'bag-not-added-reason' }, na.reason.trim())
                        : null
                    )
                  )
                )
              )
            : null;

        return el(
          'section',
          { className: 'bag-store-section' },
          el('h3', { className: 'bag-store-name' }, storeName),
          addedList,
          subtotalRow,
          checkoutBtn,
          notAddedBox
        );
      });

      bagBodyEl.replaceChildren(...storeNodes);
    }

    const fallbackTotal = stores.reduce(
      (sum, s) => sum + (typeof s.subtotal === 'number' && Number.isFinite(s.subtotal) ? s.subtotal : 0),
      0
    );
    const displayTotal = total !== null ? total : fallbackTotal;

    bagFooterEl.replaceChildren(
      el(
        'div',
        { className: 'bag-total-row' },
        el('span', { className: 'bag-total-label' }, 'Total'),
        el('span', { className: 'bag-total-value' }, formatPrice(displayTotal))
      ),
      el('p', { className: 'bag-disclaimer' }, "You check out on each store's own site. Alice never pays.")
    );
    bagBodyEl.scrollTop = 0;
  }

  function normalizeOrderStore(raw) {
    const store = typeof raw.store === 'string' && raw.store.trim() ? raw.store.trim() : '';
    const items = Array.isArray(raw.items)
      ? raw.items
          .filter((line) => line && typeof line === 'object')
          .map((line) => ({
            title: typeof line.title === 'string' && line.title.trim() ? line.title.trim() : '',
            image: typeof line.image === 'string' && line.image.trim() ? line.image.trim() : '',
            price: formatOptionalPrice(line.price),
            size: typeof line.size === 'string' && line.size.trim() ? line.size.trim() : '',
          }))
      : [];
    const orderNumber =
      typeof raw.order_number === 'string' && raw.order_number.trim()
        ? raw.order_number.trim()
        : typeof raw.order_number === 'number' && Number.isFinite(raw.order_number)
          ? String(raw.order_number)
          : '';
    return {
      store,
      items,
      total: formatOptionalPrice(raw.total),
      payment_label:
        typeof raw.payment_label === 'string' && raw.payment_label.trim()
          ? raw.payment_label.trim()
          : '',
      ready: raw.ready !== false,
      status: typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : '',
      order_number: orderNumber,
      continue_url: safeOptionalUrl(raw.continue_url),
      note: typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : '',
    };
  }

  function buildOrderLine(line) {
    const thumbUrl = line.image ? sized(line.image, 160) : '';
    const hasThumb = Boolean(thumbUrl);
    return el(
      'li',
      { className: `bag-line${hasThumb ? '' : ' bag-line--no-thumb'}` },
      hasThumb
        ? el(
            'div',
            { className: 'bag-line-thumb' },
            el('img', {
              className: 'bag-line-img',
              src: thumbUrl,
              alt: line.title || 'Garment',
              loading: 'lazy',
              decoding: 'async',
              onError: (e) => {
                e.currentTarget.hidden = true;
              },
            })
          )
        : null,
      el(
        'div',
        { className: 'bag-line-info' },
        line.title ? el('span', { className: 'bag-line-title' }, line.title) : null,
        line.size ? el('span', { className: 'bag-line-size' }, `Size ${line.size}`) : null
      ),
      line.price ? el('span', { className: 'bag-line-price' }, line.price) : null
    );
  }

  function dismissOrderReviewToBag() {
    state.orderReview = null;
    state.orderConfirmedId = null;
    state.drawerMode = 'bag';
    renderBagDrawer(state.bagData || { stores: [], links: [], total: null });
  }

  // Update the review footer in place so confirm/undo keeps scroll position
  function renderOrderReviewFooter() {
    const order = state.orderReview;
    if (!order) return;

    const footerNodes = [];
    if (order.total && !(order.needs_sign_in && order.stores.length === 0)) {
      footerNodes.push(
        el(
          'div',
          { className: 'bag-total-row' },
          el('span', { className: 'bag-total-label' }, 'Total'),
          el('span', { className: 'bag-total-value' }, order.total)
        )
      );
    }

    if (order.needs_sign_in) {
      footerNodes.push(
        el(
          'div',
          { className: 'order-review-actions' },
          el(
            'button',
            {
              type: 'button',
              className: 'btn-secondary order-cancel-btn order-cancel-btn--full',
              onClick: () => dismissOrderReviewToBag(),
            },
            'Not now'
          )
        )
      );
    } else if (state.orderConfirmedId === order.order_id) {
      footerNodes.push(
        el(
          'div',
          { className: 'order-confirmed-box', role: 'status', 'aria-live': 'polite' },
          el('p', { className: 'order-confirmed-text' }, 'Confirmed. Tell Alice yes to place the order.'),
          el(
            'button',
            {
              type: 'button',
              className: 'order-undo-btn',
              onClick: () => {
                state.orderConfirmedId = null;
                renderOrderReviewFooter();
              },
            },
            'Undo'
          )
        )
      );
    } else {
      footerNodes.push(
        el(
          'div',
          { className: 'order-review-actions' },
          el(
            'button',
            {
              type: 'button',
              className: 'btn-primary order-confirm-btn',
              onClick: () => {
                if (
                  state.drawerMode === 'review' &&
                  state.orderReview &&
                  state.orderReview.order_id === order.order_id &&
                  !state.orderReview.needs_sign_in
                ) {
                  state.orderConfirmedId = order.order_id;
                  renderOrderReviewFooter();
                }
              },
            },
            'Confirm order'
          ),
          el(
            'button',
            {
              type: 'button',
              className: 'btn-secondary order-cancel-btn',
              onClick: () => dismissOrderReviewToBag(),
            },
            'Not now'
          )
        ),
        el(
          'p',
          { className: 'bag-disclaimer order-confirm-note' },
          'Alice places the order only after you confirm here and tell her yes.'
        )
      );
    }

    bagFooterEl.hidden = footerNodes.length === 0;
    bagBodyEl.classList.toggle('bag-panel-body--no-footer', footerNodes.length === 0);
    bagFooterEl.replaceChildren(...footerNodes);
  }

  function renderOrderReviewDrawer() {
    const order = state.orderReview;
    if (!order) return;

    setBagDrawerHeader('Review your order');

    const bodyNodes = [];

    if (order.needs_sign_in) {
      const signInUrl = order.sign_in ? order.sign_in.url : null;
      const signInCode = order.sign_in ? order.sign_in.code : '';
      bodyNodes.push(
        el(
          'section',
          { className: 'order-signin-card', 'aria-label': 'Connect Shop Pay' },
          el(
            'p',
            { className: 'order-signin-copy' },
            'Sign in to Shop so Alice can place the order for you.'
          ),
          signInCode
            ? el(
                'div',
                { className: 'order-signin-code-block' },
                el('span', { className: 'order-signin-code-label' }, 'Your code'),
                el('span', { className: 'order-signin-code' }, signInCode)
              )
            : null,
          signInUrl
            ? el(
                'a',
                {
                  className: 'btn-primary order-signin-btn',
                  href: signInUrl,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                },
                'Connect Shop Pay'
              )
            : null,
          // Before sign-in there is no order to list yet, so say what happens next
          order.stores.length === 0
            ? el(
                'p',
                { className: 'order-signin-copy' },
                'Your bag is safe. When your phone says you are connected, tell Alice "I\'m signed in" and your order appears here.'
              )
            : null
        )
      );
    }

    for (const storeObj of order.stores) {
      const itemsList =
        storeObj.items.length > 0
          ? el('ul', { className: 'bag-lines' }, storeObj.items.map((line) => buildOrderLine(line)))
          : null;

      const storeTotalRow = storeObj.total
        ? el(
            'div',
            { className: 'bag-store-subtotal' },
            el('span', { className: 'bag-store-subtotal-label' }, 'Store total'),
            el('span', { className: 'bag-store-subtotal-val' }, storeObj.total)
          )
        : null;

      const paymentEl = storeObj.payment_label
        ? el('p', { className: 'order-store-payment' }, storeObj.payment_label)
        : null;

      const notReadyNote = !storeObj.ready
        ? el(
            'p',
            { className: 'order-store-note' },
            storeObj.note || 'This store finishes on its own site.'
          )
        : null;

      const notReadyBtn =
        !storeObj.ready && storeObj.continue_url
          ? el(
              'a',
              {
                className: 'btn-primary bag-checkout-btn',
                href: storeObj.continue_url,
                target: '_blank',
                rel: 'noopener noreferrer',
              },
              storeObj.store ? `Checkout at ${storeObj.store}` : 'Checkout at store'
            )
          : null;

      bodyNodes.push(
        el(
          'section',
          { className: 'bag-store-section order-review-section' },
          storeObj.store ? el('h3', { className: 'bag-store-name' }, storeObj.store) : null,
          itemsList,
          storeTotalRow,
          paymentEl,
          notReadyNote,
          notReadyBtn
        )
      );
    }

    if (order.address_label) {
      bodyNodes.push(
        el('p', { className: 'order-address' }, `Ships to ${order.address_label}`)
      );
    }

    bagBodyEl.replaceChildren(...bodyNodes);
    bagBodyEl.scrollTop = 0;
    renderOrderReviewFooter();
  }

  function renderOrderResultDrawer(result) {
    const stores = result.stores || [];
    const allPlaced = stores.length > 0 && stores.every((s) => s.status === 'placed');
    setBagDrawerHeader(allPlaced ? 'Order placed' : 'Your order');

    const storeNodes = stores.map((storeObj) => {
      const checkoutLabel = storeObj.store ? `Checkout at ${storeObj.store}` : 'Checkout at store';
      const checkoutBtn = storeObj.continue_url
        ? el(
            'a',
            {
              className: 'btn-primary bag-checkout-btn',
              href: storeObj.continue_url,
              target: '_blank',
              rel: 'noopener noreferrer',
            },
            checkoutLabel
          )
        : null;

      if (storeObj.status === 'placed') {
        const metaNodes = [];
        if (storeObj.total) {
          metaNodes.push(
            el(
              'div',
              { className: 'bag-store-subtotal' },
              el('span', { className: 'bag-store-subtotal-label' }, 'Total'),
              el('span', { className: 'bag-store-subtotal-val' }, storeObj.total)
            )
          );
        }
        if (storeObj.order_number) {
          metaNodes.push(
            el('p', { className: 'order-result-number' }, `Order ${storeObj.order_number}`)
          );
        }
        return el(
          'section',
          { className: 'bag-store-section order-result-section' },
          el(
            'div',
            { className: 'order-result-head' },
            storeObj.store ? el('h3', { className: 'bag-store-name' }, storeObj.store) : null,
            el('span', { className: 'order-status order-status--placed' }, 'Order placed')
          ),
          ...metaNodes
        );
      }

      if (storeObj.status === 'handoff') {
        return el(
          'section',
          { className: 'bag-store-section order-result-section' },
          storeObj.store ? el('h3', { className: 'bag-store-name' }, storeObj.store) : null,
          el(
            'p',
            { className: 'order-store-note' },
            storeObj.note || "Finish this one on the store's site."
          ),
          checkoutBtn
        );
      }

      if (storeObj.status === 'failed') {
        return el(
          'section',
          { className: 'bag-store-section order-result-section' },
          el(
            'div',
            { className: 'order-result-head' },
            storeObj.store ? el('h3', { className: 'bag-store-name' }, storeObj.store) : null,
            el('span', { className: 'order-status order-status--failed' }, 'Not placed')
          ),
          storeObj.note ? el('p', { className: 'order-store-note' }, storeObj.note) : null,
          checkoutBtn
        );
      }

      if (storeObj.status === 'placing') {
        return el(
          'section',
          { className: 'bag-store-section order-result-section' },
          storeObj.store ? el('h3', { className: 'bag-store-name' }, storeObj.store) : null,
          el('p', { className: 'order-status-placing' }, 'Placing your order…')
        );
      }

      return el(
        'section',
        { className: 'bag-store-section order-result-section' },
        storeObj.store ? el('h3', { className: 'bag-store-name' }, storeObj.store) : null,
        storeObj.total
          ? el(
              'div',
              { className: 'bag-store-subtotal' },
              el('span', { className: 'bag-store-subtotal-label' }, 'Total'),
              el('span', { className: 'bag-store-subtotal-val' }, storeObj.total)
            )
          : null,
        storeObj.note ? el('p', { className: 'order-store-note' }, storeObj.note) : null,
        checkoutBtn
      );
    });

    bagBodyEl.replaceChildren(...storeNodes);
    bagBodyEl.scrollTop = 0;
    bagFooterEl.replaceChildren();
    bagFooterEl.hidden = true;
    bagBodyEl.classList.add('bag-panel-body--no-footer');
  }

  // An optional title replaces the "Results for" heading; a rack shows up to twelve items
  function renderSearchView(query, items, { title = '', rack = false } = {}) {
    const cleanQuery = query.trim();
    const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 60) : '';
    const visibleItems = items
      .filter((it) => it && typeof it === 'object')
      .slice(0, rack ? 12 : 8);

    const backButton =
      state.outfits.size > 0
        ? el(
            'button',
            {
              type: 'button',
              className: 'back-link',
              onClick: () => handlers.showAll({}),
            },
            arrowLeftSvg(),
            'Back to your looks'
          )
        : hasBoutiqueContent()
          ? el(
              'button',
              {
                type: 'button',
                className: 'back-link',
                onClick: () => showBoutique(),
              },
              arrowLeftSvg(),
              'Back to boutique'
            )
          : null;

    const headerBand = el(
      'section',
      { className: 'collection-band search-band' },
      el(
        'div',
        { className: 'search-top-bar' },
        backButton,
        el(
          'div',
          { className: 'breadcrumb' },
          el('span', null, cleanTitle ? 'From Alice' : 'Search'),
          el('span', { className: 'breadcrumb-sep', 'aria-hidden': 'true' }, '/'),
          el('span', { className: 'breadcrumb-current' }, cleanTitle || cleanQuery || 'All')
        )
      ),
      el(
        'div',
        { className: 'collection-heading-row' },
        el('h1', { className: 'collection-title' }, cleanTitle || `Results for "${cleanQuery}"`),
        visibleItems.length > 0
          ? el(
              'span',
              { className: 'shop-look-count' },
              `${visibleItems.length} ${visibleItems.length === 1 ? 'item' : 'items'}`
            )
          : null
      )
    );

    const resultsContent =
      visibleItems.length === 0
        ? el('p', { className: 'search-empty' }, 'Nothing in stock for that right now.')
        : el(
            'section',
            { className: 'search-results-grid', 'aria-label': 'Search results' },
            visibleItems.map((item) =>
              buildProductCard({ slot: '', why: '', item }, null, {
                compact: false,
                pointed: false,
                onSelect: state.searchFromBoutique
                  ? (selectedItem) => openBoutiqueProduct(selectedItem)
                  : null,
              })
            )
          );

    searchSlotEl.replaceChildren(headerBand, resultsContent);
    mainEl.hidden = true;
    searchSlotEl.hidden = false;
    updateNavActive();
  }

  function openSearchFromPayload(payload, { markProducts = true, fromBoutique = false } = {}) {
    if (!payload || typeof payload.query !== 'string' || !Array.isArray(payload.items)) {
      return { ok: false, error: 'showSearch requires a query string and items array' };
    }

    closeProductPanel();
    const title = typeof payload.title === 'string' ? payload.title : '';
    const rack = payload.rack === true;
    state.lastSearch = { query: payload.query, items: payload.items, title, rack };
    state.searchFromBoutique = fromBoutique;
    state.view = 'search';
    if (markProducts) setHasProducts();
    renderSearchView(payload.query, payload.items, { title, rack });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return { ok: true };
  }

  function openProductFromPayload(payload, { markProducts = true } = {}) {
    if (!payload || !payload.item || typeof payload.item !== 'object') {
      return { ok: false, error: 'showProduct requires an item object' };
    }

    const lookNum = findLookNumberForItem(payload.item, pendingProductOutfit);
    if (markProducts) setHasProducts();
    renderProductPanel(payload, lookNum);
    state.productOpen = true;
    productLayerEl.classList.add('is-open');
    productLayerEl.setAttribute('aria-hidden', 'false');
    syncPanelOpen();
    return { ok: true };
  }

  function applyBagReady(payload, { fromAlice = false } = {}) {
    if (!payload || !Array.isArray(payload.stores)) {
      return { ok: false, error: 'bagReady requires a stores array' };
    }

    clearLiveRemoveTimers();

    if (fromAlice) {
      if (bagAbortController) {
        bagAbortController.abort();
        bagAbortController = null;
      }
      directBagReqId += 1;
      directBagBusy = false;
      state.directBag = null;
    }

    const stores = payload.stores.filter((s) => s && typeof s === 'object');
    const links = Array.isArray(payload.links) ? payload.links : [];
    const total =
      typeof payload.total === 'number' && Number.isFinite(payload.total) ? payload.total : null;

    state.orderReview = null;
    state.orderConfirmedId = null;
    state.orderResult = null;
    state.drawerMode = 'bag';
    state.bagOpenedStores = new Set();
    state.bagData = { stores, links, total };
    state.bagCount = stores.reduce(
      (sum, s) => sum + (Array.isArray(s.added) ? s.added.length : 0),
      0
    );
    updateBagBadge();
    if (fromAlice || isCallLive()) setHasProducts();
    renderBagDrawer(state.bagData);
    openBagDrawer();
    return { ok: true };
  }

  // Wrap every page-action handler so it stays synchronous and never throws
  function safeHandler(fn) {
    return (payload) => {
      try {
        return fn(payload);
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    };
  }

  const handlers = {
    showOutfits: safeHandler((payload) => {
      if (!payload || !Array.isArray(payload.outfits)) {
        return { ok: false, error: 'showOutfits requires an outfits array' };
      }

      closeProductPanel();
      leaveSearchView();

      if (payload.replace === true) {
        cancelPickedMotion(activePickedRefs);
        playedBoardUrls.clear();
        releaseStageVideo();
        for (const media of state.media.values()) {
          clearLookRenders(media);
        }
        state.outfits.clear();
        state.media.clear();
        state.pickedOutfit = null;
        state.highlightedSlot = null;
        state.highlightedOccurrence = null;
        activePickedRefs = null;
        state.subtitleMeta = { raw: '', cleanSubtitle: '', occasion: '', budget: null };
      }

      if (typeof payload.subtitle === 'string' || payload.occasion || payload.budget_usd || payload.brief) {
        state.subtitleMeta = parseSubtitleMeta(payload.subtitle, payload);
      }

      const prevOutfitNums = payload.replace === true ? new Set() : new Set(state.outfits.keys());
      const addedNums = new Set();
      let nextNum = state.outfits.size + 1;
      for (const rawOutfit of payload.outfits) {
        if (!rawOutfit || typeof rawOutfit !== 'object') continue;
        const outfit = normalizeOutfit(rawOutfit, nextNum);
        state.outfits.set(outfit.number, outfit);
        if (!prevOutfitNums.has(outfit.number)) {
          addedNums.add(outfit.number);
        }
        nextNum = Math.max(nextNum, outfit.number + 1);
      }

      if (state.outfits.size > 0) {
        state.view = 'looks';
        state.pickedOutfit = null;
        state.highlightedSlot = null;
        state.highlightedOccurrence = null;
        activePickedRefs = null;
        setHasProducts();
        renderLooksView({ animateNums: addedNums });
      } else {
        renderHomeView();
      }

      return { ok: true };
    }),

    highlight: safeHandler((payload) => {
      if (!payload || typeof payload.outfit !== 'number' || !Number.isFinite(payload.outfit)) {
        return { ok: false, error: 'highlight requires a numeric outfit' };
      }
      if (!state.outfits.has(payload.outfit)) {
        return { ok: false, error: `Unknown outfit: ${payload.outfit}` };
      }

      leaveSearchView();

      const look = state.outfits.get(payload.outfit);
      const parsed = parseHighlightPiece(payload.piece);
      const nextSlot = parsed.slot;
      const sameLook = state.view === 'picked' && state.pickedOutfit === payload.outfit;
      const samePicked = sameLook && activePickedRefs && activePickedRefs.outfit === payload.outfit;

      // Resolve 1-based slot occurrence: explicit "slot#N", cycle on repeated plain slot, else 1
      let nextOccurrence = null;
      if (nextSlot) {
        const slotCount = countSlotPieces(look, nextSlot);
        if (parsed.hasHash) {
          nextOccurrence =
            parsed.explicitOccurrence !== null && parsed.explicitOccurrence <= slotCount
              ? parsed.explicitOccurrence
              : 1;
        } else if (sameLook && state.highlightedSlot === nextSlot && slotCount > 1) {
          const currentOcc =
            Number.isInteger(state.highlightedOccurrence) && state.highlightedOccurrence >= 1
              ? state.highlightedOccurrence
              : 1;
          nextOccurrence = currentOcc >= slotCount ? 1 : currentOcc + 1;
        } else {
          nextOccurrence = 1;
        }
      }

      state.view = 'picked';
      state.pickedOutfit = payload.outfit;
      state.highlightedSlot = nextSlot;
      state.highlightedOccurrence = nextOccurrence;
      setHasProducts();

      if (samePicked) {
        closePieceLayer(activePickedRefs);
        applyPointerInPlace(nextSlot, nextOccurrence);
      } else {
        renderPickedView();
        window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        if (nextSlot && activePickedRefs) {
          const activeRow = activePickedRefs.pieceNotesList.querySelector(
            '.piece-note-item.is-pointed'
          );
          if (activeRow) scrollRowIntoList(activePickedRefs.pieceNotesList, activeRow);
        }
      }

      return { ok: true };
    }),

    showPiece: safeHandler((payload) => {
      if (!payload || typeof payload.outfit !== 'number' || !Number.isFinite(payload.outfit)) {
        return { ok: false, error: 'showPiece requires a numeric outfit' };
      }
      if (!state.outfits.has(payload.outfit)) {
        return { ok: false, error: `Unknown outfit: ${payload.outfit}` };
      }

      const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
      const rawImage =
        (typeof payload.image === 'string' && payload.image.trim()) ||
        (typeof item.image === 'string' && item.image.trim()) ||
        '';
      if (!rawImage) {
        return { ok: false, error: 'showPiece requires an image url' };
      }

      leaveSearchView();

      const look = state.outfits.get(payload.outfit);
      const media = getMedia(payload.outfit);
      const sameLook = state.view === 'picked' && state.pickedOutfit === payload.outfit;
      const samePicked = sameLook && activePickedRefs && activePickedRefs.outfit === payload.outfit;
      const prevHighlight = samePicked
        ? { slot: state.highlightedSlot, occurrence: state.highlightedOccurrence }
        : null;

      const { slot: nextSlot, occurrence: nextOccurrence } = resolvePieceOccurrence(
        look,
        payload.slot,
        item,
        sameLook
      );

      const idx =
        typeof payload.index === 'number' && Number.isFinite(payload.index)
          ? Math.floor(payload.index)
          : null;
      const cnt =
        typeof payload.count === 'number' && Number.isFinite(payload.count)
          ? Math.floor(payload.count)
          : null;
      const counterText = idx !== null && idx >= 1 && cnt !== null && cnt >= 1 ? `${idx} / ${cnt}` : '';
      const note =
        typeof payload.note === 'string' ? payload.note.trim().slice(0, 60).trimEnd() : '';
      const point = normalizePiecePoint(payload.point);
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      const priceText = formatOptionalPrice(item.price);
      const src = stageUrl(rawImage, 900);

      state.view = 'picked';
      state.pickedOutfit = payload.outfit;
      state.highlightedSlot = nextSlot;
      state.highlightedOccurrence = nextOccurrence;
      setHasProducts();

      if (samePicked) {
        syncPieceListHighlight(activePickedRefs, nextSlot, nextOccurrence);
      } else {
        renderPickedView();
        window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        if (nextSlot && activePickedRefs) {
          const activeRow = activePickedRefs.pieceNotesList.querySelector(
            '.piece-note-item.is-pointed'
          );
          if (activeRow) scrollRowIntoList(activePickedRefs.pieceNotesList, activeRow);
        }
      }

      if (activePickedRefs && activePickedRefs.outfit === payload.outfit) {
        showPieceOnStage(
          activePickedRefs,
          look,
          media,
          {
            slot: nextSlot,
            occurrence: nextOccurrence,
            title,
            priceText,
            counterText,
            note,
            point,
            src,
            index: idx,
          },
          prevHighlight
        );
      }

      return { ok: true };
    }),

    hidePiece: safeHandler(() => {
      if (activePickedRefs && activePickedRefs.pieceState) {
        closePieceLayer(activePickedRefs, { clearHighlight: true });
      }
      return { ok: true };
    }),

    updateOutfit: safeHandler((payload) => {
      if (
        !payload ||
        typeof payload.outfit !== 'number' ||
        !Number.isFinite(payload.outfit) ||
        !payload.data ||
        typeof payload.data !== 'object' ||
        !Array.isArray(payload.data.pieces)
      ) {
        return { ok: false, error: 'updateOutfit requires numeric outfit and outfit data with pieces' };
      }

      closeProductPanel();

      const oldLook = state.outfits.get(payload.outfit) || null;
      const updated = normalizeOutfit({ ...payload.data, number: payload.outfit }, payload.outfit);
      state.outfits.set(payload.outfit, updated);

      // Reset try-on to rendering and clear all renders, flat-lay, boxes, ring and reveal
      const media = getMedia(payload.outfit);
      if (activePickedRefs && activePickedRefs.outfit === payload.outfit) {
        closePieceLayer(activePickedRefs);
        releaseStageVideo(activePickedRefs);
      }
      clearLookRenders(media);
      media.tryOnStatus = 'rendering';
      media.revealed = false;
      media.stageSwapped = false;
      media.collageUrl = null;
      media.collageBoxes = null;

      if (state.pickedOutfit === payload.outfit) {
        state.highlightedSlot = null;
        state.highlightedOccurrence = null;
      }

      let flippedInPlace = false;
      if (state.view === 'looks') {
        renderLooksView();
        if (!prefersReducedMotion() && oldLook && Number(oldLook.total) !== Number(updated.total)) {
          const totalNode = mainEl.querySelector(
            `.look-card[data-look-card="${CSS.escape(String(payload.outfit))}"] .look-total-value`
          );
          if (totalNode) {
            const rollState = { rafId: null };
            looksTotalRolls.set(payload.outfit, rollState);
            rollPriceText(totalNode, oldLook.total, updated.total, rollState, () => {
              if (looksTotalRolls.get(payload.outfit) === rollState) {
                looksTotalRolls.delete(payload.outfit);
              }
            });
          }
        }
      } else if (state.view === 'picked' && state.pickedOutfit === payload.outfit) {
        const isSamePicked = Boolean(activePickedRefs && activePickedRefs.outfit === payload.outfit);
        const midFlip = Boolean(isSamePicked && activePickedRefs.swapState && activePickedRefs.swapState.active);
        if (midFlip) {
          renderPickedView();
        } else if (!prefersReducedMotion() && isSamePicked && canSwapInPlace(oldLook, updated)) {
          const swappedIndices = findSwappedIndices(oldLook, updated, payload.slot);
          if (swappedIndices.length > 0) {
            const nextLabel = updated.name || `Look ${updated.number}`;
            activePickedRefs.lookLabel = nextLabel;
            if (activePickedRefs.lookNameEl) activePickedRefs.lookNameEl.textContent = nextLabel;
            applyStageState(activePickedRefs, media);
            applyPointerInPlace(null, null);
            flippedInPlace = applyInPlaceSwap(activePickedRefs, oldLook, updated, swappedIndices);
          }
          if (!flippedInPlace) {
            renderPickedView();
            if (oldLook && activePickedRefs && activePickedRefs.lookTotalEl && Number(oldLook.total) !== Number(updated.total)) {
              const totalRoll = { rafId: null };
              activePickedRefs.swapState = {
                active: false,
                committed: true,
                entries: [],
                halfTimer: null,
                doneTimer: null,
                totalRoll,
                finalTotalText: formatPrice(updated.total),
              };
              rollPriceText(activePickedRefs.lookTotalEl, oldLook.total, updated.total, totalRoll, () => {
                if (activePickedRefs && activePickedRefs.swapState?.totalRoll === totalRoll) {
                  activePickedRefs.swapState = null;
                }
              });
            }
          }
        } else {
          renderPickedView();
          if (
            !prefersReducedMotion() &&
            oldLook &&
            activePickedRefs &&
            activePickedRefs.lookTotalEl &&
            Number(oldLook.total) !== Number(updated.total)
          ) {
            const totalRoll = { rafId: null };
            activePickedRefs.swapState = {
              active: false,
              committed: true,
              entries: [],
              halfTimer: null,
              doneTimer: null,
              totalRoll,
              finalTotalText: formatPrice(updated.total),
            };
            rollPriceText(activePickedRefs.lookTotalEl, oldLook.total, updated.total, totalRoll);
          }
        }
      }

      if (!flippedInPlace && typeof payload.slot === 'string' && payload.slot.trim()) {
        flashUpdatedSlot(payload.outfit, payload.slot.trim());
      }

      return { ok: true };
    }),

    tryOnStatus: safeHandler((payload) => {
      if (
        !payload ||
        typeof payload.outfit !== 'number' ||
        !Number.isFinite(payload.outfit) ||
        !['rendering', 'ready', 'failed'].includes(payload.status)
      ) {
        return { ok: false, error: 'tryOnStatus requires numeric outfit and valid status' };
      }

      const media = getMedia(payload.outfit);
      media.tryOnStatus = payload.status;
      if (payload.status === 'rendering' || payload.status === 'failed') {
        media.revealed = false;
        media.stageSwapped = false;
      }

      syncMediaInCurrentView(payload.outfit);
      return { ok: true };
    }),

    tryOnReady: safeHandler((payload) => {
      if (
        !payload ||
        typeof payload.outfit !== 'number' ||
        !Number.isFinite(payload.outfit) ||
        typeof payload.url !== 'string' ||
        !payload.url.trim()
      ) {
        return { ok: false, error: 'tryOnReady requires numeric outfit and image url' };
      }

      const url = payload.url.trim();
      const kind = normalizeRenderKind(payload.kind);
      const media = getMedia(payload.outfit);
      const isNewArrival = media.renders[kind] !== url;

      media.tryOnStatus = 'ready';
      media.renders[kind] = url;
      if (kind === 'video' && isNewArrival) {
        media.videoFailed = false;
      }
      if (!media.tryOnUrl || kind === 'studio') {
        media.tryOnUrl = url;
      }

      if (kind === 'video') {
        preloadVideo(media, url);
      } else {
        preloadImage(media, stageUrl(url, 900));
      }

      let newlyArrivedKind = null;
      let fadeRender = false;
      if (media.revealed && isNewArrival) {
        newlyArrivedKind = kind;
        markRenderNew(payload.outfit, media, kind);

        // A render that arrives after the reveal joins the strip; the stage changes only on a
        // reveal or a tile click, so the agent decides the order the renders are shown in
        if (!media.activeRender) {
          media.activeRender = kind;
          media.tryOnUrl = url;
          fadeRender = !media.stageSwapped;
        }
      }

      syncMediaInCurrentView(payload.outfit, { newlyArrivedKind, fadeRender });
      return { ok: true };
    }),

    collageReady: safeHandler((payload) => {
      if (
        !payload ||
        typeof payload.outfit !== 'number' ||
        !Number.isFinite(payload.outfit) ||
        typeof payload.url !== 'string' ||
        !payload.url.trim()
      ) {
        return { ok: false, error: 'collageReady requires numeric outfit and image url' };
      }

      const media = getMedia(payload.outfit);
      media.collageUrl = payload.url.trim();
      media.collageBoxes = normalizeBoxes(payload.boxes);
      preloadImage(media, stageUrl(media.collageUrl, 900));

      syncMediaInCurrentView(payload.outfit);
      return { ok: true };
    }),

    showAll: safeHandler(() => {
      cancelPickedMotion(activePickedRefs);
      releaseStageVideo();
      closeProductPanel();
      leaveSearchView();
      state.pickedOutfit = null;
      state.highlightedSlot = null;
      state.highlightedOccurrence = null;
      activePickedRefs = null;
      if (state.outfits.size > 0) {
        state.view = 'looks';
        renderLooksView();
      } else {
        renderHomeView();
      }
      window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      return { ok: true };
    }),

    reveal: safeHandler((payload) => {
      if (!payload || typeof payload.outfit !== 'number' || !Number.isFinite(payload.outfit)) {
        return { ok: false, error: 'reveal requires a numeric outfit' };
      }
      if (!state.outfits.has(payload.outfit)) {
        return { ok: false, error: `Unknown outfit: ${payload.outfit}` };
      }

      const media = getMedia(payload.outfit);
      const hasKind = typeof payload.kind === 'string' && payload.kind.trim().length > 0;
      const requestedKind = hasKind ? normalizeRenderKind(payload.kind) : null;

      if (typeof payload.url === 'string' && payload.url.trim()) {
        const url = payload.url.trim();
        const storeKind = requestedKind || 'studio';
        const isNewUrl = media.renders[storeKind] !== url;
        media.renders[storeKind] = url;
        if (storeKind === 'video' && isNewUrl) {
          media.videoFailed = false;
        }
        if (storeKind === 'video') {
          preloadVideo(media, url);
        } else {
          preloadImage(media, stageUrl(url, 900));
        }
      }

      // A first reveal that names no kind starts on the studio still when it has arrived
      const startOnStudio = !requestedKind && !media.revealed && Boolean(media.renders.studio);
      const chosenKind = pickRenderKind(media, startOnStudio ? 'studio' : requestedKind);
      if (!chosenKind) {
        return { ok: false, error: `No try-on image ready for outfit ${payload.outfit}` };
      }

      leaveSearchView();
      media.tryOnStatus = 'ready';
      const wasAlreadyShowingTryOn = media.revealed && !media.stageSwapped;
      const prevKind = media.activeRender;
      media.revealed = true;
      media.stageSwapped = false;
      media.activeRender = chosenKind;
      media.tryOnUrl = media.renders[chosenKind];
      setHasProducts();

      const renderChanged = wasAlreadyShowingTryOn && prevKind !== chosenKind;
      const needsPick = state.view !== 'picked' || state.pickedOutfit !== payload.outfit;
      if (needsPick) {
        state.view = 'picked';
        state.pickedOutfit = payload.outfit;
        state.highlightedSlot = null;
        state.highlightedOccurrence = null;
        renderPickedView({
          deferReveal: !wasAlreadyShowingTryOn,
          curtainReveal: !wasAlreadyShowingTryOn,
        });
        window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      } else {
        if (activePickedRefs && activePickedRefs.outfit === payload.outfit) {
          closePieceLayer(activePickedRefs);
          flushPendingSwap(activePickedRefs);
        }
        syncMediaInCurrentView(payload.outfit, {
          deferReveal: !wasAlreadyShowingTryOn,
          curtainReveal: !wasAlreadyShowingTryOn,
          fadeRender: renderChanged,
        });
        if (activePickedRefs && activePickedRefs.stagePanel && !isElementInView(activePickedRefs.stagePanel)) {
          const rect = activePickedRefs.stagePanel.getBoundingClientRect();
          const headerH = headerEl.offsetHeight || 0;
          window.scrollTo({
            top: Math.max(0, window.scrollY + rect.top - headerH - 16),
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          });
        }
      }

      return { ok: true, kind: media.activeRender || chosenKind };
    }),

    // -----------------------------------------------------------------------
    // Panel handlers: bag drawer, search results, product detail sheet
    // -----------------------------------------------------------------------

    bagReady: safeHandler((payload) => applyBagReady(payload, { fromAlice: true })),

    showOrderReview: safeHandler((payload) => {
      const raw =
        payload && payload.order && typeof payload.order === 'object' && !Array.isArray(payload.order)
          ? payload.order
          : null;
      // Before the shopper has signed in there is no order yet: the review arrives with an
      // empty order_id and only the sign-in link, and is shown as the connect step
      const awaitingSignIn = Boolean(raw) && raw.needs_sign_in === true;
      if (
        !raw ||
        typeof raw.order_id !== 'string' ||
        (!raw.order_id.trim() && !awaitingSignIn) ||
        !Array.isArray(raw.stores)
      ) {
        return { ok: false, error: 'showOrderReview requires order with order_id and stores array' };
      }

      const rawSignIn = raw.sign_in && typeof raw.sign_in === 'object' ? raw.sign_in : null;
      const signInCode =
        rawSignIn && typeof rawSignIn.code === 'string' && rawSignIn.code.trim()
          ? rawSignIn.code.trim()
          : rawSignIn && typeof rawSignIn.code === 'number' && Number.isFinite(rawSignIn.code)
            ? String(rawSignIn.code)
            : '';

      state.orderReview = {
        order_id: raw.order_id,
        stores: raw.stores.filter((s) => s && typeof s === 'object').map((s) => normalizeOrderStore(s)),
        total: formatOptionalPrice(raw.total),
        address_label:
          typeof raw.address_label === 'string' && raw.address_label.trim()
            ? raw.address_label.trim()
            : '',
        needs_sign_in: raw.needs_sign_in === true,
        sign_in: rawSignIn
          ? {
              url: safeOptionalUrl(rawSignIn.url),
              code: signInCode,
            }
          : null,
      };
      state.orderConfirmedId = null;
      state.orderResult = null;
      state.drawerMode = 'review';

      setHasProducts();
      renderOrderReviewDrawer();
      openBagDrawer();
      return { ok: true };
    }),

    confirmOrder: safeHandler((payload) => {
      const orderId = payload && typeof payload.order_id === 'string' ? payload.order_id : '';
      const confirmed = Boolean(
        orderId &&
          state.drawerMode === 'review' &&
          state.orderReview &&
          state.orderReview.order_id === orderId &&
          state.orderConfirmedId === orderId
      );
      return { ok: true, confirmed };
    }),

    orderPlaced: safeHandler((payload) => {
      if (!payload || !Array.isArray(payload.stores)) {
        return { ok: false, error: 'orderPlaced requires a stores array' };
      }

      const stores = payload.stores
        .filter((s) => s && typeof s === 'object')
        .map((s) => normalizeOrderStore(s));

      state.orderReview = null;
      state.orderConfirmedId = null;
      state.orderResult = {
        order_id: typeof payload.order_id === 'string' ? payload.order_id : '',
        stores,
      };
      state.drawerMode = 'result';

      setHasProducts();
      renderOrderResultDrawer(state.orderResult);
      openBagDrawer();
      return { ok: true };
    }),

    showSearch: safeHandler((payload) =>
      openSearchFromPayload(payload, { markProducts: true, fromBoutique: false })
    ),

    showProduct: safeHandler((payload) => {
      if (productAbortController) {
        productAbortController.abort();
        productAbortController = null;
      }
      productReqId += 1;
      return openProductFromPayload(payload, { markProducts: true });
    }),

    hideProduct: safeHandler(() => {
      closeProductPanel();
      return { ok: true };
    }),
  };

  // Render boutique skeleton immediately and load default department in parallel
  loadBoutique('women');

  return { handlers };
}
