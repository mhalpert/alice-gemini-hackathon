// Alice Store — renders the storefront and exposes synchronous page-action handlers.

const NAV_ITEMS = [
  'New In',
  'Women',
  'Men',
  'Occasions',
  'Looks by Alice',
  'Stores',
];

const COUNT_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];

// Module-level store for stubbed panels (built in a later task)
const stubPanels = {
  bag: null,
  search: null,
  product: null,
};

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

// Renders the shop into `root` (the #store element) and returns the page-action handlers.
export function mountStore(root) {
  if (!root || !(root instanceof HTMLElement)) {
    throw new Error('mountStore requires a valid DOM container');
  }

  // Single state object for the entire shop view
  const state = {
    view: 'empty', // 'empty' | 'looks' | 'picked'
    outfits: new Map(), // look number -> Outfit
    media: new Map(), // look number -> { tryOnStatus, tryOnUrl, collageUrl, revealed, preloads }
    subtitleMeta: { raw: '', cleanSubtitle: '', occasion: '', budget: null },
    pickedOutfit: null,
    highlightedSlot: null,
    bagCount: 0,
  };

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

  // Contract helper for the upcoming bag drawer and product detail panel
  function setPanelOpen(isOpen) {
    document.body.classList.toggle('panel-open', Boolean(isOpen));
  }

  function sortedOutfits() {
    return Array.from(state.outfits.values()).sort((a, b) => a.number - b.number);
  }

  // Build persistent store chrome
  const bagBadge = el('span', { className: 'bag-badge', hidden: true, 'aria-live': 'polite' }, '0');
  const navLinks = new Map();

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
            if (state.outfits.size > 0) handlers.showAll({});
          },
        },
        'ALICE'
      ),
      el(
        'div',
        { className: 'masthead-actions' },
        el(
          'button',
          {
            type: 'button',
            className: 'icon-btn',
            'aria-label': 'Search',
            onClick: () => {
              // Hook for the search panel task
            },
          },
          searchSvg()
        ),
        el(
          'button',
          {
            type: 'button',
            className: 'icon-btn',
            'aria-label': 'Shopping bag',
            onClick: () => {
              // Hook for the bag drawer task (will call setPanelOpen(true))
            },
          },
          bagSvg(),
          bagBadge
        )
      )
    ),
    el(
      'nav',
      { className: 'store-nav', 'aria-label': 'Store navigation' },
      el(
        'ul',
        { className: 'store-nav-list' },
        NAV_ITEMS.map((label) => {
          const link = el(
            'a',
            {
              href: '#',
              className: 'nav-link',
              onClick: (e) => {
                e.preventDefault();
                if (label === 'Looks by Alice' && state.outfits.size > 0) {
                  handlers.showAll({});
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

  // Clearly marked mount slots for upcoming bag drawer, search view, and product panel
  const panelSlotsEl = el(
    'div',
    { className: 'store-panel-slots' },
    el('div', { id: 'store-bag-slot', dataset: { panel: 'bag' } }),
    el('div', { id: 'store-search-slot', dataset: { panel: 'search' } }),
    el('div', { id: 'store-product-slot', dataset: { panel: 'product' } })
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
    if (!looksLink) return;
    const active = state.view === 'looks' || state.view === 'picked';
    looksLink.classList.toggle('is-active', active);
    if (active) looksLink.setAttribute('aria-current', 'page');
    else looksLink.removeAttribute('aria-current');
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

  function buildProductCard(piece, outfitNumber, { compact = false, pointed = false } = {}) {
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
          // Later task: call handlers.showProduct for this item
          e.preventDefault();
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

  function renderEmptyView() {
    mainEl.replaceChildren(
      el(
        'section',
        { className: 'empty-hero', 'aria-label': 'Waiting for your stylist' },
        el('p', { className: 'empty-hero-line' }, 'Your stylist is on the line.')
      )
    );
    updateNavActive();
  }

  function renderLooksView() {
    const looks = sortedOutfits();
    if (looks.length === 0) {
      renderEmptyView();
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
    const look = state.outfits.get(state.pickedOutfit);
    if (!look) {
      state.view = state.outfits.size > 0 ? 'looks' : 'empty';
      state.pickedOutfit = null;
      renderLooksView();
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
        state.view = 'empty';
        renderEmptyView();
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
      state.pickedOutfit = null;
      state.highlightedSlot = null;
      activePickedRefs = null;
      if (state.outfits.size > 0) {
        state.view = 'looks';
        renderLooksView();
      } else {
        state.view = 'empty';
        renderEmptyView();
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
    // Working stubs for panels built in the next task (#store-bag-slot,
    // #store-search-slot, #store-product-slot). Toggle setPanelOpen(true/false)
    // once those drawers/overlays are rendered.
    // -----------------------------------------------------------------------

    bagReady: safeHandler((payload) => {
      if (!payload || !Array.isArray(payload.stores)) {
        return { ok: false, error: 'bagReady requires a stores array' };
      }
      stubPanels.bag = payload;
      state.bagCount = payload.stores.reduce(
        (sum, s) => sum + (Array.isArray(s?.added) ? s.added.length : 0),
        0
      );
      updateBagBadge();
      return { ok: true };
    }),

    showSearch: safeHandler((payload) => {
      if (!payload || typeof payload.query !== 'string' || !Array.isArray(payload.items)) {
        return { ok: false, error: 'showSearch requires a query string and items array' };
      }
      stubPanels.search = payload;
      if (payload.items.length > 0) {
        setHasProducts();
      }
      return { ok: true };
    }),

    showProduct: safeHandler((payload) => {
      if (!payload || !payload.item || typeof payload.item !== 'object') {
        return { ok: false, error: 'showProduct requires an item object' };
      }
      stubPanels.product = payload;
      // Later task: render product sheet into #store-product-slot and call setPanelOpen(true)
      return { ok: true };
    }),

    hideProduct: safeHandler(() => {
      stubPanels.product = null;
      setPanelOpen(false);
      return { ok: true };
    }),
  };

  // Initial empty state
  renderEmptyView();

  return { handlers };
}
