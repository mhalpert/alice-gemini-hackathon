// Alice Store — renders the storefront and exposes synchronous page-action handlers.

// Every nav item does something: the departments switch the boutique, the other two jump to a section.
const NAV_ITEMS = [
  'Women',
  'Men',
  'Looks by Alice',
  'Stores',
];

const COUNT_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];

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

function formatPrice(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return '$0';
  return Number.isInteger(num) ? `$${num}` : `$${num.toFixed(2)}`;
}

function formatSlot(slot) {
  if (!slot || typeof slot !== 'string') return 'Piece';
  return slot.charAt(0).toUpperCase() + slot.slice(1).toLowerCase();
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

// Renders the shop into `root` (the #store element) and returns the page-action handlers.
export function mountStore(root, { onTalk } = {}) {
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
    media: new Map(), // look number -> { tryOnStatus, tryOnUrl, collageUrl, revealed, preloads }
    subtitleMeta: { raw: '', cleanSubtitle: '', occasion: '', budget: null },
    pickedOutfit: null,
    highlightedSlot: null,
    bagCount: 0,
    bagData: null,
    bagOpen: false,
    productOpen: false,
    lastSearch: null,
    searchFromBoutique: false,
  };

  // Boutique storefront state (kept separate from live-call outfits)
  const boutique = {
    department: 'women', // 'women' | 'men'
    looks: [],
    sections: [],
    looksPending: false,
    storefrontPending: false,
    reqId: 0,
    abortController: null,
  };

  // Header search and product detail request guards
  let searchBarOpen = false;
  let searchReqId = 0;
  let searchAbortController = null;
  let productReqId = 0;
  let productAbortController = null;

  // Live DOM slot refs while the boutique view is mounted
  let boutiqueRefs = null;

  // Optional hint set during local product-card clicks so multi-look items keep their look number
  let pendingProductOutfit = null;

  function getMedia(num) {
    if (!state.media.has(num)) {
      state.media.set(num, {
        tryOnStatus: null,
        tryOnUrl: null,
        collageUrl: null,
        revealed: false,
        preloads: [],
      });
    }
    return state.media.get(num);
  }

  function preloadImage(media, url) {
    if (!url) return;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    media.preloads.push(img);
    if (media.preloads.length > 4) media.preloads.shift();
  }

  function setHasProducts() {
    document.body.classList.add('has-products');
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
    return boutique.looks.length > 0 || boutique.sections.length > 0;
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
              } else if (state.bagData) {
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
                if (label === 'Looks by Alice') {
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
          return el('li', null, link);
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

  const bagBodyEl = el('div', { className: 'panel-body bag-panel-body' });
  const bagFooterEl = el('div', { className: 'panel-footer bag-panel-footer' });
  const bagLayerEl = el(
    'div',
    { className: 'panel-layer panel-layer--bag', 'aria-hidden': 'true' },
    el('div', {
      className: 'panel-backdrop',
      onClick: () => closeBagDrawer(),
    }),
    el(
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
        el('h2', { className: 'bag-panel-title' }, 'Your bag'),
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
    )
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

  function buildProductCard(piece, outfitNumber, { compact = false, pointed = false, onSelect = null } = {}) {
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

  function renderBoutiqueLooksSlot() {
    if (!boutiqueRefs) return;
    const { looksSlot } = boutiqueRefs;

    if (boutique.looksPending) {
      looksSlot.hidden = false;
      looksSlot.replaceChildren(
        el(
          'section',
          { className: 'boutique-looks-section', 'aria-label': 'Looks by Alice', 'aria-busy': 'true' },
          el(
            'div',
            { className: 'boutique-section-head' },
            el('h2', { className: 'boutique-section-title' }, 'Looks by Alice')
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
      looksSlot.replaceChildren();
      looksSlot.hidden = true;
      return;
    }

    looksSlot.hidden = false;
    looksSlot.replaceChildren(
      el(
        'section',
        { className: 'boutique-looks-section', 'aria-label': 'Looks by Alice' },
        el(
          'div',
          { className: 'boutique-section-head' },
          el('h2', { className: 'boutique-section-title' }, 'Looks by Alice')
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

    const looksSlot = el('div', { className: 'boutique-slot' });
    const railsSlot = el('div', { className: 'boutique-slot' });
    const footerNote = el(
      'p',
      { className: 'boutique-footer-note', hidden: !hasBoutiqueContent() },
      "Prices and stock come live from each store. Checkout happens on the store's own site."
    );

    boutiqueRefs = { deptButtons, looksSlot, railsSlot, footerNote };

    renderBoutiqueLooksSlot();
    renderBoutiqueRailsSlot();

    mainEl.replaceChildren(
      el('div', { className: 'boutique-view' }, hero, looksSlot, railsSlot, footerNote)
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
    closeProductPanel();
    leaveSearchView();
    state.pickedOutfit = null;
    state.highlightedSlot = null;
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

  function loadBoutique(department) {
    const dept = department === 'men' ? 'men' : 'women';
    if (boutique.abortController) {
      boutique.abortController.abort();
    }
    const controller = new AbortController();
    boutique.abortController = controller;
    const reqId = ++boutique.reqId;

    boutique.department = dept;
    boutique.looks = [];
    boutique.sections = [];
    boutique.looksPending = true;
    boutique.storefrontPending = true;

    if (state.view === 'boutique') {
      if (boutiqueRefs) {
        renderBoutiqueLooksSlot();
        renderBoutiqueRailsSlot();
        updateBoutiqueFooterNote();
        updateNavActive();
      } else {
        renderBoutiqueView();
      }
    }

    const encodedDept = encodeURIComponent(dept);

    // Fetch looks and storefront rails in parallel; ignore stale replies on department switch
    fetchJson(`/api/looks?department=${encodedDept}&limit=6`, { signal: controller.signal }).then(
      (data) => {
        if (reqId !== boutique.reqId) return;
        boutique.looksPending = false;
        // Keep only looks made for this department: a piece tagged for the other one rules the look out
        const fitsDepartment = (lk) =>
          !Array.isArray(lk.pieces) ||
          lk.pieces.every((p) => !p?.item?.department || p.item.department === dept);
        boutique.looks =
          data && Array.isArray(data.looks)
            ? data.looks.filter((lk) => lk && typeof lk === 'object' && fitsDepartment(lk)).slice(0, 6)
            : [];
        syncBoutiqueBodyClass();
        if (state.view === 'boutique' && boutiqueRefs) {
          renderBoutiqueLooksSlot();
        }
        finishBoutiqueCheck();
      }
    );

    fetchJson(`/api/storefront?department=${encodedDept}`, { signal: controller.signal }).then(
      (data) => {
        if (reqId !== boutique.reqId) return;
        boutique.storefrontPending = false;
        boutique.sections =
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
        syncBoutiqueBodyClass();
        if (state.view === 'boutique' && boutiqueRefs) {
          renderBoutiqueRailsSlot();
        }
        finishBoutiqueCheck();
      }
    );
  }

  function selectDepartment(department) {
    const dept = department === 'men' ? 'men' : 'women';
    const switchingDept = dept !== boutique.department;
    const alreadyLoadingSame =
      !switchingDept && (boutique.looksPending || boutique.storefrontPending);

    closeProductPanel();
    leaveSearchView();
    state.pickedOutfit = null;
    state.highlightedSlot = null;
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

  function renderLooksView() {
    boutiqueRefs = null;
    const looks = sortedOutfits();
    if (looks.length === 0) {
      renderHomeView();
      return;
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

        return el(
          'article',
          { className: 'look-card', dataset: { lookCard: look.number } },
          el(
            'div',
            { className: 'look-card-top' },
            el('span', { className: 'look-eyebrow' }, `Look ${look.number}`),
            badge
          ),
          el('h2', { className: 'look-name' }, look.name || `Look ${look.number}`),
          el('p', { className: 'look-difference' }, look.difference || ''),
          piecesGrid,
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
      })
    );

    mainEl.replaceChildren(headerBand, grid);
    updateNavActive();
  }

  function applyStageState(panelRefs, media, { deferReveal = false } = {}) {
    const { collagePanel, collageImg, tryOnPanel, tryOnImg, tryOnText, tryOnSub } = panelRefs;

    // Flat-lay board state
    if (media.collageUrl) {
      const nextSrc = stageUrl(media.collageUrl, 900);
      if (collageImg.getAttribute('src') !== nextSrc) {
        collageImg.setAttribute('src', nextSrc);
      }
      collagePanel.classList.add('has-collage');
    } else {
      collagePanel.classList.remove('has-collage');
      collageImg.removeAttribute('src');
    }

    // Try-on panel state
    tryOnPanel.classList.remove('is-tryon-ready');
    if (media.tryOnUrl) {
      const nextTryOn = stageUrl(media.tryOnUrl, 900);
      if (tryOnImg.getAttribute('src') !== nextTryOn) {
        tryOnImg.setAttribute('src', nextTryOn);
      }
    } else {
      tryOnImg.removeAttribute('src');
    }

    if (media.tryOnStatus === 'ready' && media.tryOnUrl) {
      tryOnText.textContent = "Try-on ready: say 'show me'";
      tryOnSub.textContent = 'Prepared for you';
      tryOnPanel.classList.add('is-tryon-ready');
    } else if (media.tryOnStatus === 'failed') {
      tryOnText.textContent = 'Try-on unavailable for this look';
      tryOnSub.textContent = '';
    } else {
      tryOnText.textContent = 'Rendering your try-on…';
      tryOnSub.textContent = 'Fitting each piece';
    }

    if (media.revealed && media.tryOnUrl) {
      if (deferReveal) {
        tryOnPanel.classList.remove('is-revealed');
        void tryOnPanel.offsetWidth;
        requestAnimationFrame(() => {
          if (state.view === 'picked') {
            tryOnPanel.classList.add('is-revealed');
          }
        });
      } else {
        tryOnPanel.classList.add('is-revealed');
      }
    } else {
      tryOnPanel.classList.remove('is-revealed');
    }
  }

  let activePickedRefs = null;

  function renderPickedView({ deferReveal = false } = {}) {
    boutiqueRefs = null;
    const look = state.outfits.get(state.pickedOutfit);
    if (!look) {
      state.pickedOutfit = null;
      if (state.outfits.size > 0) {
        state.view = 'looks';
        renderLooksView();
      } else {
        renderHomeView();
      }
      return;
    }

    const media = getMedia(look.number);

    const headerBand = el(
      'section',
      { className: 'picked-header' },
      el(
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
      ),
      el('span', { className: 'picked-kicker' }, 'Your look'),
      el('h1', { className: 'picked-title' }, look.name || `Look ${look.number}`),
      look.difference ? el('p', { className: 'picked-difference' }, look.difference) : null
    );

    const collageImg = el('img', {
      className: 'stage-collage-img',
      alt: `${look.name || 'Look'} flat lay`,
      decoding: 'async',
    });

    const collagePanel = el(
      'div',
      { className: 'stage-panel' },
      el(
        'div',
        { className: 'stage-placeholder' },
        el('p', { className: 'stage-placeholder-text' }, 'Laying it out…'),
        el('p', { className: 'stage-placeholder-sub' }, 'Styling board')
      ),
      collageImg
    );

    const tryOnImg = el('img', {
      className: 'stage-tryon-img',
      alt: `${look.name || 'Look'} try-on`,
      decoding: 'async',
    });

    const tryOnText = el('p', { className: 'stage-placeholder-text' }, 'Rendering your try-on…');
    const tryOnSub = el('p', { className: 'stage-placeholder-sub' }, 'Fitting each piece');

    const tryOnPanel = el(
      'div',
      { className: 'stage-panel' },
      el('div', { className: 'stage-placeholder' }, tryOnText, tryOnSub),
      tryOnImg
    );

    const stage = el(
      'section',
      { className: 'stage-grid', 'aria-label': 'Look preview stage' },
      el(
        'figure',
        { className: 'stage-figure' },
        collagePanel,
        el('figcaption', { className: 'stage-caption' }, 'The flat lay')
      ),
      el(
        'figure',
        { className: 'stage-figure' },
        tryOnPanel,
        el('figcaption', { className: 'stage-caption' }, 'On you')
      )
    );

    const ctaStatus = el('span', { className: 'summary-cta-status', 'aria-live': 'polite' }, '');
    const addLookBtn = el(
      'button',
      {
        type: 'button',
        className: 'btn-primary',
        onClick: () => {
          ctaStatus.textContent = 'Ask Alice to add this look to your bag.';
          root.dispatchEvent(
            new CustomEvent('alice:add-look', { detail: { outfit: look.number } })
          );
        },
      },
      'Add the look to bag'
    );

    const pieceNotesList = el(
      'ul',
      { className: 'piece-notes-list' },
      (look.pieces || []).map((piece) => {
        const isPointed = Boolean(state.highlightedSlot && piece.slot === state.highlightedSlot);
        return el(
          'li',
          {
            className: `piece-note-item${isPointed ? ' is-pointed' : ''}`,
            dataset: { slot: piece.slot || '', outfit: look.number },
          },
          el('span', { className: 'piece-slot-name' }, formatSlot(piece.slot)),
          el(
            'div',
            { className: 'piece-note-body' },
            el('span', { className: 'piece-note-title' }, piece.item?.title || ''),
            piece.why ? el('p', { className: 'piece-note-why' }, piece.why) : null
          ),
          el('span', { className: 'piece-note-price' }, formatPrice(piece.item?.price))
        );
      })
    );

    const summary = el(
      'section',
      { className: 'summary-panel', 'aria-label': 'Look details' },
      el(
        'div',
        { className: 'summary-overview' },
        el(
          'div',
          { className: 'summary-head' },
          el('h2', { className: 'summary-name' }, look.name || `Look ${look.number}`),
          el('span', { className: 'summary-total' }, formatPrice(look.total))
        ),
        el('div', { className: 'summary-cta-row' }, addLookBtn, ctaStatus),
        look.story
          ? el(
              'div',
              { className: 'alice-notes' },
              el('h3', { className: 'section-label' }, "Alice's notes"),
              el('p', { className: 'alice-notes-text' }, look.story)
            )
          : null
      ),
      el(
        'div',
        { className: 'summary-pieces' },
        el('h3', { className: 'section-label' }, 'Why each piece works'),
        pieceNotesList
      )
    );

    const piecesCount = (look.pieces || []).length;
    const shopGrid = el(
      'div',
      { className: 'shop-look-grid' },
      (look.pieces || []).map((piece) =>
        buildProductCard(piece, look.number, {
          compact: false,
          pointed: Boolean(state.highlightedSlot && piece.slot === state.highlightedSlot),
        })
      )
    );

    const shopSection = el(
      'section',
      { className: 'shop-look-section', 'aria-label': 'Shop the look' },
      el(
        'div',
        { className: 'shop-look-head' },
        el('h2', { className: 'shop-look-title' }, 'Shop the look'),
        el('span', { className: 'shop-look-count' }, `${piecesCount} ${piecesCount === 1 ? 'piece' : 'pieces'}`)
      ),
      shopGrid
    );

    activePickedRefs = {
      outfit: look.number,
      collagePanel,
      collageImg,
      tryOnPanel,
      tryOnImg,
      tryOnText,
      tryOnSub,
      pieceNotesList,
      shopGrid,
    };

    applyStageState(activePickedRefs, media, { deferReveal });
    mainEl.replaceChildren(headerBand, stage, summary, shopSection);
    updateNavActive();
  }

  function applyPointerInPlace(slot) {
    if (!activePickedRefs) return;
    const normalized = typeof slot === 'string' && slot.trim() ? slot.trim() : null;
    let targetCard = null;

    for (const card of activePickedRefs.shopGrid.querySelectorAll('.product-card')) {
      const match = Boolean(normalized && card.dataset.slot === normalized);
      card.classList.toggle('is-pointed', match);
      if (match) targetCard = card;
    }

    for (const row of activePickedRefs.pieceNotesList.querySelectorAll('.piece-note-item')) {
      const match = Boolean(normalized && row.dataset.slot === normalized);
      row.classList.toggle('is-pointed', match);
    }

    if (targetCard) {
      targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (activePickedRefs.tryOnPanel) {
      activePickedRefs.tryOnPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  }

  function syncMediaInCurrentView(outfitNumber, { deferReveal = false } = {}) {
    const media = getMedia(outfitNumber);
    if (state.view === 'looks') {
      const badge = mainEl.querySelector(`[data-tryon-badge="${CSS.escape(String(outfitNumber))}"]`);
      if (badge) renderTryOnBadge(badge, media.tryOnStatus);
    } else if (state.view === 'picked' && activePickedRefs && activePickedRefs.outfit === outfitNumber) {
      applyStageState(activePickedRefs, media, { deferReveal });
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

  function closeBagDrawer() {
    state.bagOpen = false;
    bagLayerEl.classList.remove('is-open');
    bagLayerEl.setAttribute('aria-hidden', 'true');
    syncPanelOpen();
  }

  function openBagDrawer() {
    if (!state.bagData) return;
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

    // Display-only size chips: prefer sizes_detail (with sold-out state), falling back to sizes / item.sizes
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
    const sizes = rawSizes
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean);

    const sizeChipNodes =
      rawSizesDetail.length > 0
        ? rawSizesDetail.map((entry) =>
            entry.available
              ? el('span', { className: 'size-chip' }, entry.label)
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
        : sizes.map((size) => el('span', { className: 'size-chip' }, size));

    const sizesSection =
      sizeChipNodes.length > 0
        ? el(
            'section',
            { className: 'product-panel-block', 'aria-label': 'Available sizes' },
            el('h3', { className: 'section-label' }, 'Sizes'),
            el('div', { className: 'size-chips' }, sizeChipNodes)
          )
        : null;

    // Styling rationale box, hidden when empty
    const whyText = typeof payload.why === 'string' ? payload.why.trim() : '';
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

  function renderBagDrawer({ stores, links, total }) {
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
      const storeNodes = stores.map((storeObj) => {
        const storeName =
          typeof storeObj.store === 'string' && storeObj.store.trim()
            ? storeObj.store.trim()
            : 'Store';
        const addedLines = Array.isArray(storeObj.added)
          ? storeObj.added.filter((line) => line && typeof line === 'object')
          : [];
        const notAddedLines = Array.isArray(storeObj.not_added)
          ? storeObj.not_added.filter((line) => line && typeof line === 'object')
          : [];
        const hasSubtotal =
          typeof storeObj.subtotal === 'number' && Number.isFinite(storeObj.subtotal);
        const checkoutUrl =
          linkByStore.get(storeName) || linkByStore.get(storeName.toLowerCase()) || null;

        const addedList =
          addedLines.length > 0
            ? el(
                'ul',
                { className: 'bag-lines' },
                addedLines.map((line) => {
                  const thumbUrl = sized(line.image, 160);
                  const sizeText =
                    typeof line.size === 'string' && line.size.trim() ? line.size.trim() : '';
                  return el(
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
                      sizeText ? el('span', { className: 'bag-line-size' }, `Size ${sizeText}`) : null
                    ),
                    el('span', { className: 'bag-line-price' }, formatPrice(line.price))
                  );
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

        const checkoutBtn = checkoutUrl
          ? el(
              'a',
              {
                className: 'btn-primary bag-checkout-btn',
                href: checkoutUrl,
                target: '_blank',
                rel: 'noopener',
              },
              `Checkout at ${storeName}`
            )
          : null;

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

  function renderSearchView(query, items) {
    const cleanQuery = query.trim();
    const visibleItems = items.filter((it) => it && typeof it === 'object').slice(0, 8);

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
          el('span', null, 'Search'),
          el('span', { className: 'breadcrumb-sep', 'aria-hidden': 'true' }, '/'),
          el('span', { className: 'breadcrumb-current' }, cleanQuery || 'All')
        )
      ),
      el(
        'div',
        { className: 'collection-heading-row' },
        el('h1', { className: 'collection-title' }, `Results for "${cleanQuery}"`),
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
    state.lastSearch = { query: payload.query, items: payload.items };
    state.searchFromBoutique = fromBoutique;
    state.view = 'search';
    if (markProducts) setHasProducts();
    renderSearchView(payload.query, payload.items);
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
        state.outfits.clear();
        state.media.clear();
        state.pickedOutfit = null;
        state.highlightedSlot = null;
        activePickedRefs = null;
        state.subtitleMeta = { raw: '', cleanSubtitle: '', occasion: '', budget: null };
      }

      if (typeof payload.subtitle === 'string' || payload.occasion || payload.budget_usd || payload.brief) {
        state.subtitleMeta = parseSubtitleMeta(payload.subtitle, payload);
      }

      let nextNum = state.outfits.size + 1;
      for (const rawOutfit of payload.outfits) {
        if (!rawOutfit || typeof rawOutfit !== 'object') continue;
        const outfit = normalizeOutfit(rawOutfit, nextNum);
        state.outfits.set(outfit.number, outfit);
        nextNum = Math.max(nextNum, outfit.number + 1);
      }

      if (state.outfits.size > 0) {
        state.view = 'looks';
        state.pickedOutfit = null;
        state.highlightedSlot = null;
        activePickedRefs = null;
        setHasProducts();
        renderLooksView();
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

      const nextSlot =
        typeof payload.piece === 'string' && payload.piece.trim() ? payload.piece.trim() : null;
      const samePicked =
        state.view === 'picked' &&
        state.pickedOutfit === payload.outfit &&
        activePickedRefs &&
        activePickedRefs.outfit === payload.outfit;

      state.view = 'picked';
      state.pickedOutfit = payload.outfit;
      state.highlightedSlot = nextSlot;
      setHasProducts();

      if (samePicked) {
        applyPointerInPlace(nextSlot);
      } else {
        renderPickedView();
        if (nextSlot) {
          applyPointerInPlace(nextSlot);
        } else {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
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

      const updated = normalizeOutfit({ ...payload.data, number: payload.outfit }, payload.outfit);
      state.outfits.set(payload.outfit, updated);

      // Reset try-on to rendering and clear flat-lay until a fresh collageReady arrives
      const media = getMedia(payload.outfit);
      media.tryOnStatus = 'rendering';
      media.tryOnUrl = null;
      media.revealed = false;
      media.collageUrl = null;

      if (state.view === 'looks') {
        renderLooksView();
      } else if (state.view === 'picked' && state.pickedOutfit === payload.outfit) {
        renderPickedView();
      }

      if (typeof payload.slot === 'string' && payload.slot.trim()) {
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

      const media = getMedia(payload.outfit);
      media.tryOnStatus = 'ready';
      media.tryOnUrl = payload.url.trim();
      preloadImage(media, stageUrl(media.tryOnUrl, 900));

      syncMediaInCurrentView(payload.outfit);
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
      preloadImage(media, stageUrl(media.collageUrl, 900));

      syncMediaInCurrentView(payload.outfit);
      return { ok: true };
    }),

    showAll: safeHandler(() => {
      closeProductPanel();
      leaveSearchView();
      state.pickedOutfit = null;
      state.highlightedSlot = null;
      activePickedRefs = null;
      if (state.outfits.size > 0) {
        state.view = 'looks';
        renderLooksView();
      } else {
        renderHomeView();
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
      if (typeof payload.url === 'string' && payload.url.trim()) {
        media.tryOnUrl = payload.url.trim();
      }
      if (!media.tryOnUrl) {
        return { ok: false, error: `No try-on image ready for outfit ${payload.outfit}` };
      }

      leaveSearchView();
      media.tryOnStatus = 'ready';
      const wasAlreadyRevealed = media.revealed;
      media.revealed = true;
      setHasProducts();

      const needsPick = state.view !== 'picked' || state.pickedOutfit !== payload.outfit;
      if (needsPick) {
        state.view = 'picked';
        state.pickedOutfit = payload.outfit;
        state.highlightedSlot = null;
        renderPickedView({ deferReveal: !wasAlreadyRevealed });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        syncMediaInCurrentView(payload.outfit, { deferReveal: !wasAlreadyRevealed });
        if (activePickedRefs && activePickedRefs.tryOnPanel) {
          activePickedRefs.tryOnPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }

      return { ok: true };
    }),

    // -----------------------------------------------------------------------
    // Panel handlers: bag drawer, search results, product detail sheet
    // -----------------------------------------------------------------------

    bagReady: safeHandler((payload) => {
      if (!payload || !Array.isArray(payload.stores)) {
        return { ok: false, error: 'bagReady requires a stores array' };
      }

      const stores = payload.stores.filter((s) => s && typeof s === 'object');
      const links = Array.isArray(payload.links) ? payload.links : [];
      const total =
        typeof payload.total === 'number' && Number.isFinite(payload.total) ? payload.total : null;

      state.bagData = { stores, links, total };
      state.bagCount = stores.reduce(
        (sum, s) => sum + (Array.isArray(s.added) ? s.added.length : 0),
        0
      );
      updateBagBadge();
      setHasProducts();
      renderBagDrawer(state.bagData);
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
