// Shopper accounts on the page: the masthead button, the sign-in panel, the list of what
// Alice remembers, and the saveMemory page action the agent calls during a call.
//
// The server decides whether accounts exist at all. If GET /api/account is not a 200,
// nothing here is shown and saveMemory quietly does nothing.
//
// Everything a shopper or the model typed is put on the page with textContent only.

const API = '/api/account';
const SAVE_DELAY_MS = 400;
const REFRESH_RETRY_MS = [2000, 6000, 15000];

const MESSAGES = {
  invalid_email: "That email address doesn't look right.",
  weak_password: 'Use at least 10 characters for the password.',
  email_taken: 'There is already an account with that email. Sign in instead.',
  bad_credentials: "That email and password don't match.",
  slow_down: 'Too many tries. Wait a few minutes and try again.',
  accounts_full: 'New accounts are closed for now.',
  busy: 'Alice is busy right now. Try again in a moment.',
  shop_unavailable: "Shop isn't reachable right now. Try again in a moment.",
  shop_denied: 'The Shop sign-in was declined.',
  shop_expired: 'That sign-in ran out of time. Try again.',
  shop_failed: "The Shop sign-in didn't go through. Try again.",
  accounts_unavailable: 'Accounts are not available right now. Try again in a moment.',
  not_signed_in: 'You have been signed out. Sign in again.',
  offline: "Couldn't reach Alice. Check your connection and try again.",
  other: 'Something went wrong. Try again.',
};

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'textContent') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svg(paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const node = document.createElementNS(ns, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  for (const spec of paths) {
    const child = document.createElementNS(ns, spec.tag);
    for (const [key, value] of Object.entries(spec)) {
      if (key !== 'tag') child.setAttribute(key, value);
    }
    node.appendChild(child);
  }
  return node;
}

const personSvg = () =>
  svg([
    { tag: 'circle', cx: '12', cy: '8.5', r: '3.5' },
    { tag: 'path', d: 'M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6' },
  ]);

const closeSvg = () =>
  svg([
    { tag: 'line', x1: '6', y1: '6', x2: '18', y2: '18' },
    { tag: 'line', x1: '18', y1: '6', x2: '6', y2: '18' },
  ]);

async function request(method, path, body) {
  try {
    const res = await fetch(API + path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

function messageFor(reply) {
  if (reply.status === 0) return MESSAGES.offline;
  const code = reply.data && typeof reply.data.error === 'string' ? reply.data.error : '';
  return MESSAGES[code] || MESSAGES.other;
}

/**
 * @param {{ isLive?: () => boolean }} [options] isLive says whether a call is running.
 * @returns {{ handlers: { saveMemory: (payload: object) => { ok: boolean } }, ready: Promise<void>, open: () => void, close: () => void }}
 */
export function mountAccount(options = {}) {
  const isLive = () => {
    try {
      return Boolean(options.isLive && options.isLive());
    } catch {
      return false;
    }
  };

  const state = {
    enabled: false,
    account: null,
    memory: null,
    view: 'signin', // 'signin' | 'signup'
    busy: false,
    error: '',
    notice: '',
    confirm: null, // null | 'forget' | 'delete'
    open: false,
    shopEnabled: false,
    shop: null, // while waiting for approval at Shop: { url, code, intervalMs, timer }
  };

  // Which account a save belongs to is decided by the server: every saveMemory from the
  // agent carries a ticket for the account that started the call, and the server refuses
  // it when this browser is signed in as anyone else.
  let pendingSave = null;
  let saveTimer = null;
  let saving = false;
  let lastFocus = null;

  let buttonEl = null;
  let layerEl = null;
  let sheetEl = null;
  let titleEl = null;
  let bodyEl = null;

  function canSaveNow() {
    return Boolean(state.enabled && state.account);
  }

  // ---- the masthead button ----------------------------------------------------------

  function renderButton() {
    if (!buttonEl) return;
    const signedIn = Boolean(state.account);
    buttonEl.classList.toggle('is-signed-in', signedIn);
    buttonEl.setAttribute('aria-label', signedIn ? 'Your account' : 'Sign in');
    buttonEl.setAttribute('title', signedIn ? 'Your account' : 'Sign in');
  }

  function mountButton() {
    if (buttonEl || !state.enabled) return;
    const actions = document.querySelector('#store .masthead-actions');
    if (!actions) return;
    buttonEl = el(
      'button',
      { type: 'button', className: 'icon-btn account-btn', 'aria-haspopup': 'dialog', onClick: () => open() },
      personSvg(),
      el('span', { className: 'account-btn-dot', 'aria-hidden': 'true' }),
    );
    // Search, account, bag.
    actions.insertBefore(buttonEl, actions.lastElementChild);
    renderButton();
  }

  // ---- the panel ----------------------------------------------------------------------

  function mountPanel() {
    if (layerEl) return;
    titleEl = el('h2', { className: 'account-title', id: 'account-title' });
    bodyEl = el('div', { className: 'panel-body account-body' });
    sheetEl = el(
      'aside',
      { className: 'panel-sheet panel-sheet--account', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'account-title', tabindex: '-1' },
      el(
        'div',
        { className: 'panel-head account-head' },
        titleEl,
        el('button', { type: 'button', className: 'panel-close-btn', 'aria-label': 'Close account', onClick: () => close() }, closeSvg()),
      ),
      bodyEl,
    );
    layerEl = el(
      'div',
      { className: 'panel-layer panel-layer--account', 'aria-hidden': 'true' },
      el('div', { className: 'panel-backdrop', onClick: () => close() }),
      sheetEl,
    );
    document.body.appendChild(layerEl);

    // Capture phase, so Escape closes this panel and nothing underneath it.
    document.addEventListener(
      'keydown',
      (event) => {
        if (!state.open) return;
        if (event.key === 'Escape') {
          event.stopImmediatePropagation();
          event.preventDefault();
          close();
          return;
        }
        if (event.key === 'Tab') trapFocus(event);
      },
      true,
    );
  }

  function focusable() {
    return [...sheetEl.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])')].filter(
      (node) => !node.disabled && node.offsetParent !== null,
    );
  }

  function trapFocus(event) {
    const nodes = focusable();
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!sheetEl.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function open() {
    if (!state.enabled) return;
    mountPanel();
    // One side panel at a time: close the bag if it is showing.
    const bagClose = document.querySelector('#store-bag-slot .panel-layer.is-open [data-close-bag]');
    if (bagClose) bagClose.click();
    lastFocus = document.activeElement;
    state.open = true;
    state.error = '';
    state.notice = '';
    state.confirm = null;
    render();
    layerEl.classList.add('is-open');
    layerEl.setAttribute('aria-hidden', 'false');
    document.body.classList.add('account-open');
    focusFirst();
    // Show the freshest copy: Alice may have saved something since the page loaded.
    if (state.account) {
      const before = JSON.stringify([state.account, state.memory]);
      void refresh().then(() => {
        if (state.open && !state.busy && JSON.stringify([state.account, state.memory]) !== before) renderKeepingFocus();
      });
    }
  }

  function close() {
    if (!state.open || !layerEl) return;
    // Leaving the panel gives up a Shop sign-in that is still waiting.
    if (state.shop) void cancelShop();
    state.open = false;
    layerEl.classList.remove('is-open');
    layerEl.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('account-open');
    // Back to where the shopper was; the account button when that is nowhere in particular
    // (the panel was opened from a link, or the old control is gone).
    const cameFrom =
      lastFocus && lastFocus !== document.body && typeof lastFocus.focus === 'function' && document.contains(lastFocus)
        ? lastFocus
        : buttonEl;
    if (cameFrom) cameFrom.focus({ preventScroll: true });
  }

  function focusFirst() {
    const target = sheetEl.querySelector('input') || sheetEl.querySelector('.account-body button') || sheetEl;
    target.focus({ preventScroll: true });
    if (document.activeElement === target) return;
    // The panel was not focusable yet (it was still hidden). Try once more on the next
    // frame, but never pull focus away from wherever the shopper has put it since.
    requestAnimationFrame(() => {
      if (state.open && !sheetEl.contains(document.activeElement)) target.focus({ preventScroll: true });
    });
  }

  function setBusy(busy) {
    state.busy = busy;
    if (!bodyEl) return;
    for (const node of bodyEl.querySelectorAll('button, input')) node.disabled = busy;
    sheetEl.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  // The DOM's own replaceChildren would print a nested list, or a skipped (null) part, as text.
  function setBody(...children) {
    bodyEl.replaceChildren(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
  }

  function statusLine() {
    if (state.error) return el('p', { className: 'account-status account-status--error', role: 'alert' }, state.error);
    if (state.notice) return el('p', { className: 'account-status', role: 'status' }, state.notice);
    return el('p', { className: 'account-status', role: 'status', 'aria-live': 'polite' });
  }

  function render() {
    if (!bodyEl) return;
    if (state.account) renderSignedIn();
    else renderSignedOut();
    renderButton();
  }

  // For redraws the shopper did not ask for (fresh data arriving): rebuilding the panel
  // removes the focused control, so put focus back inside instead of losing it to the page.
  function renderKeepingFocus() {
    const hadFocus = Boolean(sheetEl && sheetEl.contains(document.activeElement));
    render();
    if (state.open && hadFocus && !sheetEl.contains(document.activeElement)) {
      const target = sheetEl.querySelector('.account-body button:not([disabled])') || sheetEl;
      target.focus({ preventScroll: true });
    }
  }

  // ---- signed out: sign in or create an account ------------------------------------

  function renderSignedOut() {
    if (state.shop) {
      renderShopWaiting();
      return;
    }
    const creating = state.view === 'signup';
    titleEl.textContent = creating ? 'Create account' : 'Sign in';

    const tab = (view, label) =>
      el(
        'button',
        {
          type: 'button',
          role: 'tab',
          className: `account-tab${state.view === view ? ' is-active' : ''}`,
          'aria-selected': state.view === view ? 'true' : 'false',
          onClick: () => {
            if (state.view === view) return;
            state.view = view;
            state.error = '';
            state.notice = '';
            render();
            focusFirst();
          },
        },
        label,
      );

    const field = (id, label, attrs, hint) =>
      el(
        'div',
        { className: 'account-field' },
        el('label', { className: 'account-label', for: id }, label),
        el('input', { id, name: id, className: 'account-input', ...attrs, 'aria-describedby': hint ? `${id}-hint` : undefined }),
        hint ? el('p', { className: 'account-hint', id: `${id}-hint` }, hint) : null,
      );

    const form = el(
      'form',
      { className: 'account-form', novalidate: true, onSubmit: (event) => submitCredentials(event) },
      creating
        ? field('account-name', 'First name', { type: 'text', autocomplete: 'given-name', maxlength: '60' }, 'Optional. What Alice calls you.')
        : null,
      field('account-email', 'Email', {
        type: 'email',
        autocomplete: creating ? 'email' : 'username',
        inputmode: 'email',
        autocapitalize: 'none',
        spellcheck: 'false',
        required: true,
        maxlength: '254',
      }),
      field(
        'account-password',
        'Password',
        { type: 'password', autocomplete: creating ? 'new-password' : 'current-password', required: true, maxlength: '200' },
        creating ? 'At least 10 characters.' : null,
      ),
      statusLine(),
      el('button', { type: 'submit', className: 'btn-primary account-submit' }, creating ? 'Create account' : 'Sign in'),
    );

    setBody(
      el(
        'p',
        { className: 'account-lede' },
        'Sign in and Alice remembers you between calls: your name, your sizes and what you tell her you like.',
      ),
      el('div', { className: 'account-tabs', role: 'tablist', 'aria-label': 'Sign in or create an account' }, tab('signin', 'Sign in'), tab('signup', 'Create account')),
      form,
      state.shopEnabled
        ? [
            el('p', { className: 'account-divider', 'aria-hidden': 'true' }, el('span', null, 'or')),
            el('button', { type: 'button', className: 'btn-secondary account-shop-btn', onClick: () => startShop() }, 'Sign in with Shop'),
          ]
        : null,
      el('p', { className: 'account-fineprint' }, 'Alice keeps no photos, addresses or payment details here.'),
    );
  }

  // ---- signed out: sign in with Shop ---------------------------------------------------

  function renderShopWaiting() {
    titleEl.textContent = 'Sign in with Shop';
    const shop = state.shop;
    // Only ever link to an https page; the server already checked it is Shop's own.
    const safeUrl = typeof shop.url === 'string' && shop.url.startsWith('https://') ? shop.url : null;
    setBody(
      el('p', { className: 'account-lede' }, 'Open Shop, check the code matches, and approve. This panel signs you in as soon as you do.'),
      shop.code ? el('p', { className: 'account-shop-code', 'aria-label': `Code ${shop.code}` }, shop.code) : null,
      safeUrl
        ? el('a', { className: 'btn-primary account-submit', href: safeUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open Shop')
        : null,
      el('p', { className: 'account-status', role: 'status' }, 'Waiting for your approval in Shop…'),
      el('div', { className: 'account-actions' }, el('button', { type: 'button', className: 'btn-secondary', onClick: () => cancelShop(true) }, 'Cancel')),
      el('p', { className: 'account-fineprint' }, 'Alice learns who you are from Shop: your email address and first name. She keeps nothing else from it.'),
    );
  }

  function stopShopTimer() {
    if (state.shop && state.shop.timer !== null) {
      clearTimeout(state.shop.timer);
      state.shop.timer = null;
    }
  }

  function endShop(message, isError) {
    stopShopTimer();
    state.shop = null;
    state.error = isError ? message : '';
    state.notice = isError ? '' : message;
    if (state.open) {
      render();
      focusFirst();
    }
  }

  async function startShop() {
    if (state.busy || state.shop) return;
    setBusy(true);
    const reply = await request('POST', '/shop/start', {});
    setBusy(false);
    if (reply.status !== 200 || !reply.data || typeof reply.data.url !== 'string') {
      state.error = messageFor(reply);
      state.notice = '';
      render();
      return;
    }
    state.error = '';
    state.notice = '';
    state.shop = {
      url: reply.data.url,
      code: typeof reply.data.code === 'string' ? reply.data.code : null,
      intervalMs: Math.max(2000, Number(reply.data.interval_s || 5) * 1000),
      timer: null,
    };
    render();
    focusFirst();
    scheduleShopPoll();
  }

  function scheduleShopPoll() {
    if (!state.shop) return;
    stopShopTimer();
    state.shop.timer = setTimeout(pollShop, state.shop.intervalMs);
  }

  async function pollShop() {
    const waiting = state.shop;
    if (!waiting) return;
    waiting.timer = null;
    const reply = await request('POST', '/shop/poll', {});
    if (state.shop !== waiting) return; // cancelled while the request was out
    const status = reply.data && reply.data.status;
    if (reply.status === 200 && status === 'signed_in') {
      stopShopTimer();
      state.shop = null;
      state.account = reply.data.account;
      state.memory = reply.data.memory;
      state.error = '';
      state.notice = isLive() ? "You're signed in. Alice will know you from your next call." : "You're signed in.";
      if (state.open) {
        render();
        focusFirst();
      } else {
        renderButton();
      }
      return;
    }
    if (reply.status === 200 && status === 'pending') {
      waiting.intervalMs = Math.max(2000, Number(reply.data.interval_s || 5) * 1000);
      scheduleShopPoll();
      return;
    }
    if (reply.status === 200 && status === 'denied') return endShop(MESSAGES.shop_denied, true);
    if (reply.status === 200 && status === 'expired') return endShop(MESSAGES.shop_expired, true);
    if (reply.status === 0 || reply.status === 429) {
      // Offline for a moment, or asked to slow down: keep waiting, a little more patiently.
      waiting.intervalMs = Math.min(30000, waiting.intervalMs + 2000);
      scheduleShopPoll();
      return;
    }
    endShop(reply.status === 200 ? MESSAGES.shop_failed : messageFor(reply), true);
  }

  async function cancelShop(showNotice) {
    if (!state.shop) return;
    stopShopTimer();
    state.shop = null;
    void request('POST', '/shop/cancel', {});
    if (showNotice && state.open) {
      state.error = '';
      state.notice = '';
      render();
      focusFirst();
    }
  }

  async function submitCredentials(event) {
    event.preventDefault();
    if (state.busy) return;
    const creating = state.view === 'signup';
    const email = bodyEl.querySelector('#account-email').value.trim();
    const password = bodyEl.querySelector('#account-password').value;
    const nameInput = bodyEl.querySelector('#account-name');
    const name = nameInput ? nameInput.value.trim() : '';

    const fail = (message, selector) => {
      state.error = message;
      state.notice = '';
      const keep = { email, name };
      render();
      bodyEl.querySelector('#account-email').value = keep.email;
      if (bodyEl.querySelector('#account-name')) bodyEl.querySelector('#account-name').value = keep.name;
      const target = bodyEl.querySelector(selector);
      if (target) target.focus();
    };

    if (!email) return fail('Enter your email address.', '#account-email');
    if (!password) return fail('Enter your password.', '#account-password');
    if (creating && [...password].length < 10) return fail(MESSAGES.weak_password, '#account-password');

    setBusy(true);
    const reply = await request('POST', creating ? '/signup' : '/signin', creating ? { email, password, name } : { email, password });
    setBusy(false);

    if (reply.status === 200 || reply.status === 201) {
      state.account = reply.data.account;
      state.memory = reply.data.memory;
      state.error = '';
      state.notice = isLive()
        ? "You're signed in. Alice will know you from your next call."
        : creating
          ? "You're in. Start a call and Alice will remember what she learns."
          : '';
      render();
      focusFirst();
      return;
    }
    fail(messageFor(reply), reply.data && reply.data.error === 'invalid_email' ? '#account-email' : '#account-password');
  }

  // ---- signed in: what Alice remembers ----------------------------------------------

  function memoryRows() {
    const memory = state.memory || { department: null, sizes: {}, facts: [] };
    const rows = [];
    if (state.account.name) rows.push(['Name', state.account.name]);
    if (memory.department) rows.push(['Shops', memory.department === 'men' ? "Men's" : "Women's"]);
    const sizes = Object.entries(memory.sizes || {});
    if (sizes.length > 0) {
      rows.push([
        'Sizes',
        el('ul', { className: 'account-chips' }, sizes.map(([slot, size]) => el('li', { className: 'account-chip' }, `${slot} ${size}`))),
      ]);
    }
    const facts = Array.isArray(memory.facts) ? memory.facts : [];
    if (facts.length > 0) {
      rows.push(['Notes', el('ul', { className: 'account-notes' }, facts.map((fact) => el('li', null, fact)))]);
    }
    return rows;
  }

  function renderSignedIn() {
    titleEl.textContent = 'Your account';
    const rows = memoryRows();
    const memory = state.memory || {};
    const hasMemory = Boolean(
      memory.department || Object.keys(memory.sizes || {}).length > 0 || (memory.facts || []).length > 0,
    );
    const remembers =
      rows.length > 0
        ? el(
            'dl',
            { className: 'account-memory' },
            rows.map(([label, value]) => [el('dt', null, label), el('dd', null, value)]),
          )
        : el('p', { className: 'account-empty' }, 'Nothing yet. Alice saves what she learns about you during a call.');

    let actions;
    if (state.confirm === 'forget') {
      actions = confirmBlock('Forget your sizes and notes? Your account stays.', 'Yes, forget', () => forgetEverything());
    } else if (state.confirm === 'delete') {
      actions = confirmBlock('Delete your account and everything Alice remembers? This cannot be undone.', 'Yes, delete my account', () => deleteAccount());
    } else {
      actions = el(
        'div',
        { className: 'account-actions' },
        el('button', { type: 'button', className: 'btn-secondary', onClick: () => signOut() }, 'Sign out'),
        el('button', { type: 'button', className: 'btn-secondary', onClick: () => askConfirm('forget'), disabled: hasMemory ? undefined : true }, 'Forget everything'),
        el('button', { type: 'button', className: 'account-link-btn', onClick: () => askConfirm('delete') }, 'Delete account'),
      );
    }

    setBody(
      el('p', { className: 'account-signed-in' }, 'Signed in as ', el('strong', null, state.account.email || 'your account')),
      el('h3', { className: 'account-subtitle' }, 'What Alice remembers'),
      remembers,
      el('p', { className: 'account-fineprint' }, 'Alice uses this from your next call on. No photos, addresses or payment details are kept.'),
      statusLine(),
      actions,
    );
  }

  function confirmBlock(question, yesLabel, onYes) {
    return el(
      'div',
      { className: 'account-confirm', role: 'group', 'aria-label': question },
      el('p', { className: 'account-confirm-text' }, question),
      el(
        'div',
        { className: 'account-actions' },
        el('button', { type: 'button', className: 'btn-primary', onClick: onYes }, yesLabel),
        el('button', { type: 'button', className: 'btn-secondary', onClick: () => askConfirm(null) }, 'Cancel'),
      ),
    );
  }

  function askConfirm(what) {
    state.confirm = what;
    state.error = '';
    state.notice = '';
    render();
    const target = bodyEl.querySelector(what ? '.account-confirm .btn-secondary' : '.account-actions button');
    if (target) target.focus();
  }

  function signedOutLocally(notice) {
    state.account = null;
    state.memory = null;
    state.confirm = null;
    state.view = 'signin';
    state.error = '';
    state.notice = notice || '';
    pendingSave = null;
  }

  async function signOut() {
    setBusy(true);
    const reply = await request('POST', '/signout', {});
    setBusy(false);
    if (reply.status !== 200) {
      state.error = messageFor(reply);
      render();
      return;
    }
    signedOutLocally('You are signed out.');
    render();
    focusFirst();
  }

  async function forgetEverything() {
    setBusy(true);
    const reply = await request('DELETE', '/memory', {});
    setBusy(false);
    if (reply.status === 401) {
      signedOutLocally(MESSAGES.not_signed_in);
      render();
      return;
    }
    if (reply.status !== 200) {
      state.error = messageFor(reply);
      state.confirm = null;
      render();
      return;
    }
    state.memory = reply.data.memory;
    state.confirm = null;
    pendingSave = null;
    // During a call Alice still holds what she learned; the server now refuses saves from it.
    state.notice = isLive() ? 'Forgotten. Nothing more from this call will be saved.' : 'Forgotten.';
    render();
    focusFirst();
  }

  async function deleteAccount() {
    setBusy(true);
    const reply = await request('DELETE', '', {});
    setBusy(false);
    if (reply.status !== 200 && reply.status !== 401) {
      state.error = messageFor(reply);
      state.confirm = null;
      render();
      return;
    }
    signedOutLocally('Your account is deleted.');
    render();
    focusFirst();
  }

  // ---- loading, and saving what Alice learns ----------------------------------------

  async function refresh() {
    const reply = await request('GET', '');
    if (reply.status !== 200 || !reply.data || reply.data.enabled !== true) {
      // 404 means accounts are switched off. Anything else (offline, busy, an error) is
      // passing: leave what is showing alone and let the caller try again.
      if (reply.status === 404) {
        state.enabled = false;
        return 'off';
      }
      return 'retry';
    }
    state.enabled = true;
    state.account = reply.data.account || null;
    state.memory = reply.data.memory || null;
    state.shopEnabled = reply.data.shop_sign_in === true;
    renderButton();
    return 'ok';
  }

  async function flushSave() {
    saveTimer = null;
    if (saving || !pendingSave) return;
    if (!canSaveNow()) {
      pendingSave = null;
      return;
    }
    const body = pendingSave;
    const savedFor = state.account;
    pendingSave = null;
    saving = true;
    const reply = await request('PUT', '/memory', body);
    saving = false;
    if (reply.status === 200 && state.account === savedFor) {
      state.account = reply.data.account;
      state.memory = reply.data.memory;
      if (state.open && !state.confirm && !state.busy) renderKeepingFocus();
      else renderButton();
    } else if (reply.status === 401) {
      signedOutLocally('');
      if (state.open) renderKeepingFocus();
      else renderButton();
    }
    if (pendingSave) saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
  }

  // Page action. Must answer at once (the agent is waiting), so the save runs afterwards.
  function saveMemory(payload) {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'saveMemory needs an object' };
    // No ticket means the call was not started by a signed-in shopper: nothing to save.
    if (!canSaveNow() || typeof payload.ticket !== 'string' || !payload.ticket) return { ok: true };
    // The agent sends everything it knows each time, so the newest call replaces the last.
    pendingSave = {
      ticket: payload.ticket,
      name: typeof payload.name === 'string' ? payload.name : null,
      department: payload.department === 'men' || payload.department === 'women' ? payload.department : null,
      sizes: payload.sizes && typeof payload.sizes === 'object' && !Array.isArray(payload.sizes) ? payload.sizes : {},
      facts: Array.isArray(payload.facts) ? payload.facts.filter((fact) => typeof fact === 'string') : [],
    };
    if (saveTimer === null) saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
    return { ok: true };
  }

  // A slow start or a busy moment must not hide the button for the whole visit.
  async function firstRefresh() {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await refresh();
      if (outcome !== 'retry' || attempt >= REFRESH_RETRY_MS.length) return;
      await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_MS[attempt]));
    }
  }

  const ready = firstRefresh().then(() => {
    mountButton();
    if (state.enabled && location.hash === '#account') {
      history.replaceState(null, '', location.pathname + location.search);
      open();
    }
  });

  return {
    handlers: {
      saveMemory: (payload) => {
        try {
          return saveMemory(payload);
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      },
    },
    ready,
    open,
    close,
  };
}
