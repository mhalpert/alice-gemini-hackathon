// The video-call layer: start screen, Alice's face (or a voice orb), the shopper's
// self-view, captions and the call controls. It also registers every page action
// as a LiveKit RPC method so the agent can drive the shop.
//
// Body classes this file sets:  call-idle | call-connecting | call-live,
//   no-face (no video of Alice yet, show the orb), face-hidden (shopper hid her face),
//   camera-off (shopper's camera is off), controls-open (phone controls row expanded),
//   alice-joining | alice-listening | alice-thinking | alice-speaking (agent state),
//   call-reconnecting (connection interrupted), mic-muted (shopper's mic is muted),
//   typing-open (text reply row open).
// Body classes it reads (set by store.js):  has-products, panel-open.

import { Room, RoomEvent, Track } from '../vendor/livekit-client.esm.mjs';

const CAPTION_LINGER_MS = 6000;
const ALICE_STATE_LABELS = {
  joining: 'Alice is joining…',
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: '',
};

export function mountCall(root, { handlers = {} } = {}) {
  root.innerHTML = `
    <section class="call-start" aria-label="Start a call">
      <div class="call-start__card">
        <p class="call-start__eyebrow">Live styling · real stores</p>
        <h1 class="call-start__title">Talk to Alice</h1>
        <p class="call-start__lede">She sees your outfit, shops real stores while you chat, and shows the look on you.</p>
        <input class="call-start__passcode" type="password" placeholder="Passcode" autocomplete="off" aria-label="Passcode" hidden>
        <button class="call-start__talk" type="button">Talk to Alice</button>
        <p class="call-start__status" role="status" aria-live="polite"></p>
      </div>
    </section>

    <section class="call-stage" aria-label="Your call with Alice" hidden>
      <div class="alice">
        <video class="alice__video" autoplay playsinline></video>
        <div class="alice__orb" aria-hidden="true"><span></span></div>
        <p class="alice__badge"><span class="alice__dot"></span>Alice <em>live stylist</em></p>
        <span class="alice__state" role="status" aria-live="polite"></span>
        <video class="selfview" autoplay playsinline muted aria-label="Your camera"></video>
        <span class="selfview__muted" aria-hidden="true">Muted<span class="selfview__muted-hint"> · press M</span></span>
      </div>
      <div class="captions" aria-live="polite"></div>
      <form class="typebox" aria-label="Type to Alice">
        <input class="typebox__input" type="text" placeholder="Type to Alice…" maxlength="300" autocomplete="off" aria-label="Type to Alice">
        <button class="typebox__send" type="submit">Send</button>
      </form>
      <button type="button" class="mute-quick" aria-label="Mute" aria-pressed="false"><span class="mute-quick__mic" aria-hidden="true"></span></button>
      <button type="button" class="controls-toggle" aria-label="Call controls" aria-expanded="false"><span aria-hidden="true"></span></button>
      <div class="controls" role="toolbar" aria-label="Call controls">
        <button type="button" data-act="mute" aria-pressed="false">Mute</button>
        <button type="button" data-act="video" aria-pressed="false">Stop video</button>
        <button type="button" data-act="face" aria-pressed="false">Hide face</button>
        <button type="button" data-act="type" aria-expanded="false">Type instead</button>
        <button type="button" data-act="end" class="controls__end">End</button>
      </div>
      <audio class="alice__audio" autoplay></audio>
    </section>`;

  const $ = (sel) => root.querySelector(sel);
  const el = {
    start: $('.call-start'), stage: $('.call-stage'), talk: $('.call-start__talk'),
    passcode: $('.call-start__passcode'), status: $('.call-start__status'),
    aliceVideo: $('.alice__video'), aliceAudio: $('.alice__audio'), orb: $('.alice__orb'),
    aliceState: $('.alice__state'), selfview: $('.selfview'), captions: $('.captions'),
    controls: $('.controls'), controlsToggle: $('.controls-toggle'),
    muteBtn: $('[data-act="mute"]'), muteQuick: $('.mute-quick'),
    typeBtn: $('[data-act="type"]'), typebox: $('.typebox'),
    typeInput: $('.typebox__input'), typeSend: $('.typebox__send'),
  };

  let room = null;
  let orbStop = null;
  let aliceState = null;
  let muteBusy = false;
  let sendingText = false;
  let unsentTimer = 0;
  const body = document.body;

  function setState(state) {
    body.classList.remove('call-idle', 'call-connecting', 'call-live');
    body.classList.add(`call-${state}`);
    el.start.hidden = state === 'live';
    el.stage.hidden = state !== 'live';
    el.talk.disabled = state === 'connecting';
    el.talk.textContent = state === 'connecting' ? 'Connecting…' : 'Talk to Alice';
  }

  // Reflect what Alice is doing; reconnecting text overrides the agent state until restored.
  function setAliceState(state) {
    const next = state === 'listening' || state === 'thinking' || state === 'speaking' ? state : 'joining';
    aliceState = next;
    body.classList.remove('alice-joining', 'alice-listening', 'alice-thinking', 'alice-speaking');
    body.classList.add(`alice-${next}`);
    if (!body.classList.contains('call-reconnecting')) {
      el.aliceState.textContent = ALICE_STATE_LABELS[next];
    }
  }

  function setReconnecting(reconnecting) {
    body.classList.toggle('call-reconnecting', reconnecting);
    el.aliceState.textContent = reconnecting
      ? 'Reconnecting…'
      : (aliceState ? ALICE_STATE_LABELS[aliceState] : '');
  }

  // Only the participant that publishes an agent state drives the line. A video-avatar worker
  // joins as a second agent participant with no state of its own, so it is ignored here.
  function syncAgentState(participant) {
    const value = participant?.attributes?.['lk.agent.state'];
    if (!participant?.isAgent || !value) return;
    setAliceState(value);
  }

  // ---- captions -----------------------------------------------------------

  const captionTimers = new Map();

  // One pill per speaker. A new line from the same speaker replaces the old one.
  function showCaption(who, text) {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    let pill = el.captions.querySelector(`[data-who="${who}"]`);
    if (!pill) {
      pill = document.createElement('p');
      pill.className = `caption caption--${who}`;
      pill.dataset.who = who;
      el.captions.append(pill);
    }
    pill.textContent = clean;
    for (const other of el.captions.querySelectorAll('.caption.is-latest')) {
      if (other !== pill) other.classList.remove('is-latest');
    }
    pill.classList.add('is-on', 'is-latest');
    clearTimeout(captionTimers.get(who));
    captionTimers.set(who, setTimeout(() => pill.classList.remove('is-on'), CAPTION_LINGER_MS));
  }

  // Page action: the agent can put a caption up directly.
  function say(payload) {
    try {
      showCaption('alice', payload?.caption);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // Live transcripts of both sides arrive on the lk.transcription text stream.
  async function onTranscription(reader, participantInfo) {
    try {
      const mine = room && participantInfo?.identity === room.localParticipant.identity;
      const who = mine ? 'you' : 'alice';
      let text = '';
      for await (const chunk of reader) {
        text += chunk;
        showCaption(who, text);
      }
    } catch (err) {
      console.warn('[call] transcription stream failed', err);
    }
  }

  // ---- Alice's face and voice --------------------------------------------

  // Pulse the orb with the loudness of Alice's voice.
  function startOrb(mediaStreamTrack) {
    stopOrb();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(new MediaStream([mediaStreamTrack])).connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      let frame = 0;
      const tick = () => {
        analyser.getByteFrequencyData(bins);
        let sum = 0;
        for (const b of bins) sum += b;
        const level = Math.min(1, sum / bins.length / 90);
        el.orb.style.setProperty('--level', level.toFixed(3));
        frame = requestAnimationFrame(tick);
      };
      tick();
      orbStop = () => { cancelAnimationFrame(frame); ctx.close().catch(() => {}); };
    } catch (err) {
      console.warn('[call] orb unavailable', err);
    }
  }

  function stopOrb() {
    if (orbStop) orbStop();
    orbStop = null;
    el.orb.style.removeProperty('--level');
  }

  function onTrackSubscribed(track) {
    if (track.kind === Track.Kind.Video) {
      track.attach(el.aliceVideo);
      body.classList.remove('no-face');
    } else if (track.kind === Track.Kind.Audio) {
      track.attach(el.aliceAudio);
      startOrb(track.mediaStreamTrack);
    }
  }

  function onTrackUnsubscribed(track) {
    track.detach();
    if (track.kind === Track.Kind.Video) body.classList.add('no-face');
    if (track.kind === Track.Kind.Audio) stopOrb();
  }

  // ---- the shopper's camera and mic --------------------------------------

  async function setCamera(on) {
    let ok = on;
    try {
      const pub = await room.localParticipant.setCameraEnabled(on);
      if (on && pub?.track) pub.track.attach(el.selfview);
    } catch (err) {
      console.warn('[call] camera unavailable', err);
      ok = false;
    }
    body.classList.toggle('camera-off', !ok);
    // The agent reads this attribute to know whether it can see the shopper.
    try { await room.localParticipant.setAttributes({ camera: ok ? 'on' : 'off' }); } catch (err) { console.warn('[call] attribute not set', err); }
    return ok;
  }

  function press(button, pressed, labelOn, labelOff) {
    button.setAttribute('aria-pressed', String(pressed));
    button.textContent = pressed ? labelOn : labelOff;
  }

  function setMutedUi(muted) {
    body.classList.toggle('mic-muted', muted);
    press(el.muteBtn, muted, 'Unmute', 'Mute');
    el.muteQuick.setAttribute('aria-pressed', String(muted));
    el.muteQuick.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  }

  async function toggleMute() {
    if (!room || muteBusy) return;
    const activeRoom = room;
    const nextMuted = !body.classList.contains('mic-muted');
    muteBusy = true;
    try {
      await activeRoom.localParticipant.setMicrophoneEnabled(!nextMuted);
      if (room === activeRoom) setMutedUi(nextMuted);
    } catch (err) {
      console.warn('[call] mute failed', err);
    } finally {
      muteBusy = false;
    }
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    return target.isContentEditable || Boolean(target.closest('input, textarea, select'));
  }

  // Toggle the collapsed call controls on phones; tapping outside or pressing Escape closes them.
  function setControlsOpen(open) {
    body.classList.toggle('controls-open', open);
    el.controlsToggle.setAttribute('aria-expanded', String(open));
  }

  function setTypingOpen(open, { returnFocus = false } = {}) {
    body.classList.toggle('typing-open', open);
    el.typeBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      if (body.classList.contains('controls-open')) setControlsOpen(false);
      el.typeInput.focus();
    } else if (returnFocus) {
      if (el.typeBtn.offsetParent) el.typeBtn.focus();
      else if (el.controlsToggle.offsetParent) el.controlsToggle.focus();
    }
  }

  async function sendTypedText() {
    if (!room || sendingText) return;
    const text = el.typeInput.value.trim();
    if (!text) return;
    const activeRoom = room;
    sendingText = true;
    el.typeSend.disabled = true;
    try {
      await activeRoom.localParticipant.sendText(text, { topic: 'lk.chat' });
      if (room !== activeRoom) return;
      showCaption('you', text);
      el.typeInput.value = '';
      el.typeInput.focus();
    } catch (err) {
      console.warn('[call] sendText failed', err);
      el.typebox.classList.remove('is-unsent');
      void el.typebox.offsetWidth;
      el.typebox.classList.add('is-unsent');
      clearTimeout(unsentTimer);
      unsentTimer = setTimeout(() => el.typebox.classList.remove('is-unsent'), 600);
    } finally {
      sendingText = false;
      el.typeSend.disabled = false;
    }
  }

  el.controlsToggle.addEventListener('click', () => {
    setControlsOpen(!body.classList.contains('controls-open'));
  });

  el.muteQuick.addEventListener('click', toggleMute);

  el.typebox.addEventListener('submit', (event) => {
    event.preventDefault();
    sendTypedText();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!body.classList.contains('controls-open')) return;
    if (el.controls.contains(event.target) || el.controlsToggle.contains(event.target)) return;
    setControlsOpen(false);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (body.classList.contains('typing-open')) {
        setTypingOpen(false, { returnFocus: true });
        return;
      }
      if (body.classList.contains('controls-open')) setControlsOpen(false);
      return;
    }
    if (
      (event.key === 'm' || event.key === 'M') &&
      !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
      !event.repeat &&
      room &&
      body.classList.contains('call-live') &&
      !isEditableTarget(event.target)
    ) {
      toggleMute();
    }
  });

  el.controls.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    if (button.dataset.act === 'type') {
      setTypingOpen(!body.classList.contains('typing-open'), { returnFocus: true });
      return;
    }
    if (!room) return;
    const pressed = button.getAttribute('aria-pressed') === 'true';
    try {
      if (button.dataset.act === 'mute') {
        await toggleMute();
      } else if (button.dataset.act === 'video') {
        const on = await setCamera(pressed);
        press(button, !on, 'Start video', 'Stop video');
      } else if (button.dataset.act === 'face') {
        body.classList.toggle('face-hidden', !pressed);
        press(button, !pressed, 'Show face', 'Hide face');
      } else if (button.dataset.act === 'end') {
        await end();
      }
    } catch (err) {
      console.warn('[call] control failed', button.dataset.act, err);
    }
  });

  // ---- page actions over RPC ---------------------------------------------

  // Each page action becomes an RPC method of the same name. A handler never throws to the agent.
  function registerPageActions(allHandlers) {
    for (const [name, handler] of Object.entries(allHandlers)) {
      room.registerRpcMethod(name, async (data) => {
        const started = performance.now();
        let reply;
        try {
          const payload = data.payload ? JSON.parse(data.payload) : {};
          reply = handler(payload) ?? { ok: true };
        } catch (err) {
          reply = { ok: false, error: String(err?.message ?? err) };
        }
        const ms = Math.round(performance.now() - started);
        if (!reply.ok) console.error(`[page] ${name} failed in ${ms} ms:`, reply.error);
        else if (ms > 300) console.warn(`[page] ${name} was slow: ${ms} ms`);
        return JSON.stringify(reply);
      });
    }
  }

  // ---- connecting ----------------------------------------------------------

  // A link can carry the passcode after the # (for example in a QR code): #k=... .
  // It is read once, kept for this tab, and taken out of the address bar.
  // A passcode typed into the field always wins over it.
  const LINK_CODE_KEY = 'alice.linkCode';
  function readLinkCode() {
    let code = '';
    try {
      const match = /(?:^#|&)k=([^&]+)/.exec(location.hash);
      if (match) {
        code = decodeURIComponent(match[1]).slice(0, 80);
        sessionStorage.setItem(LINK_CODE_KEY, code);
        history.replaceState(null, '', location.pathname + location.search);
      } else {
        code = sessionStorage.getItem(LINK_CODE_KEY) || '';
      }
    } catch {
      // Storage or history unavailable: the passcode field still works
    }
    return code;
  }
  const linkCode = readLinkCode();

  // A dev link can carry ?token=...&url=... ; otherwise the server hands out a token.
  async function getToken(passcode) {
    const query = new URLSearchParams(location.search);
    if (query.get('token') && query.get('url')) return { token: query.get('token'), url: query.get('url') };
    const res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(passcode ? { passcode } : {}),
    });
    if (res.status === 401 || res.status === 403) return { needsPasscode: true };
    // 429: the hourly call limit is reached, or this visitor tried too many passcodes
    if (res.status === 429) {
      let reason = '';
      try {
        reason = String((await res.json()).error || '');
      } catch {
        // no readable body: treat it as busy
      }
      return { busy: true, reason };
    }
    if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
    const json = await res.json();
    return { token: json.token ?? json.participantToken, url: json.url ?? json.serverUrl ?? json.livekit_url };
  }

  async function start() {
    if (room) return;
    setState('connecting');
    el.status.textContent = '';
    try {
      const grant = await getToken(el.passcode.value.trim() || linkCode);
      if (grant.needsPasscode) {
        el.passcode.hidden = false;
        el.passcode.focus();
        el.status.textContent = el.passcode.value ? 'That passcode did not work.' : 'Enter the passcode to start.';
        setState('idle');
        return;
      }
      if (grant.busy) {
        el.status.textContent =
          grant.reason === 'passcode_locked'
            ? 'Too many tries. Give it a minute, then try again.'
            : 'Alice is with another shopper. Try again in a minute.';
        setState('idle');
        return;
      }
      if (!grant.token || !grant.url) throw new Error('the token reply had no token or url');

      const currentRoom = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          voiceIsolation: true,
        },
      });
      room = currentRoom;
      registerPageActions({ ...handlers, say });
      room.registerTextStreamHandler('lk.transcription', onTranscription);
      room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
      room.on(RoomEvent.ParticipantConnected, (participant) => {
        if (room !== currentRoom) return;
        syncAgentState(participant);
      });
      room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
        if (room !== currentRoom || !participant?.isAgent) return;
        if (changed && 'lk.agent.state' in changed) setAliceState(changed['lk.agent.state']);
      });
      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (room !== currentRoom) return;
        if (participant?.isAgent && participant.attributes?.['lk.agent.state']) setAliceState('joining');
      });
      room.on(RoomEvent.Reconnecting, () => {
        if (room === currentRoom) setReconnecting(true);
      });
      if (RoomEvent.SignalReconnecting) {
        room.on(RoomEvent.SignalReconnecting, () => {
          if (room === currentRoom) setReconnecting(true);
        });
      }
      room.on(RoomEvent.Reconnected, () => {
        if (room !== currentRoom) return;
        setReconnecting(false);
        for (const participant of room.remoteParticipants.values()) syncAgentState(participant);
      });
      room.on(RoomEvent.Disconnected, () => reset('Call ended. Talk to Alice again whenever you like.'));

      body.classList.add('no-face');
      setAliceState('joining');
      await room.connect(grant.url, grant.token);
      for (const participant of room.remoteParticipants.values()) syncAgentState(participant);
      await room.startAudio().catch(() => {});
      await room.localParticipant.setMicrophoneEnabled(true);
      await setCamera(true);
      setState('live');
    } catch (err) {
      console.error('[call] could not start', err);
      await end();
      el.status.textContent = 'Alice could not pick up. Give it another try.';
    }
  }

  function reset(message = '') {
    stopOrb();
    room = null;
    aliceState = null;
    muteBusy = false;
    sendingText = false;
    clearTimeout(unsentTimer);
    unsentTimer = 0;
    body.classList.remove(
      'no-face', 'face-hidden', 'camera-off',
      'alice-joining', 'alice-listening', 'alice-thinking', 'alice-speaking',
      'call-reconnecting',
    );
    el.aliceState.textContent = '';
    setControlsOpen(false);
    setMutedUi(false);
    setTypingOpen(false);
    el.typeInput.value = '';
    el.typeSend.disabled = false;
    el.typebox.classList.remove('is-unsent');
    for (const button of el.controls.querySelectorAll('button[aria-pressed]')) button.setAttribute('aria-pressed', 'false');
    el.controls.querySelector('[data-act="mute"]').textContent = 'Mute';
    el.controls.querySelector('[data-act="video"]').textContent = 'Stop video';
    el.controls.querySelector('[data-act="face"]').textContent = 'Hide face';
    el.captions.replaceChildren();
    el.status.textContent = message;
    setState('idle');
  }

  async function end() {
    const current = room;
    room = null;
    try { await current?.disconnect(); } catch (err) { console.warn('[call] disconnect failed', err); }
    reset();
  }

  // Shows the live layout with no connection, so the page can be checked without a call.
  function preview() {
    body.classList.add('no-face');
    setAliceState('listening');
    setState('live');
    showCaption('alice', 'Preview mode: this is where Alice talks.');
  }

  el.talk.addEventListener('click', start);
  el.passcode.addEventListener('keydown', (event) => { if (event.key === 'Enter') start(); });
  setState('idle');

  return { start, end, say, preview };
}
