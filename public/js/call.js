// The video-call layer: start screen, Alice's face (or a voice orb), the shopper's
// self-view, captions and the call controls. It also registers every page action
// as a LiveKit RPC method so the agent can drive the shop.
//
// Body classes this file sets:  call-idle | call-connecting | call-live,
//   no-face (no video of Alice yet, show the orb), face-hidden (shopper hid her face).
// Body classes it reads (set by store.js):  has-products, panel-open.

import { Room, RoomEvent, Track } from '../vendor/livekit-client.esm.mjs';

const CAPTION_LINGER_MS = 6000;

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
        <video class="selfview" autoplay playsinline muted aria-label="Your camera"></video>
      </div>
      <div class="captions" aria-live="polite"></div>
      <div class="controls" role="toolbar" aria-label="Call controls">
        <button type="button" data-act="mute" aria-pressed="false">Mute</button>
        <button type="button" data-act="video" aria-pressed="false">Stop video</button>
        <button type="button" data-act="face" aria-pressed="false">Hide face</button>
        <button type="button" data-act="end" class="controls__end">End</button>
      </div>
      <audio class="alice__audio" autoplay></audio>
    </section>`;

  const $ = (sel) => root.querySelector(sel);
  const el = {
    start: $('.call-start'), stage: $('.call-stage'), talk: $('.call-start__talk'),
    passcode: $('.call-start__passcode'), status: $('.call-start__status'),
    aliceVideo: $('.alice__video'), aliceAudio: $('.alice__audio'), orb: $('.alice__orb'),
    selfview: $('.selfview'), captions: $('.captions'), controls: $('.controls'),
  };

  let room = null;
  let orbStop = null;
  const body = document.body;

  function setState(state) {
    body.classList.remove('call-idle', 'call-connecting', 'call-live');
    body.classList.add(`call-${state}`);
    el.start.hidden = state === 'live';
    el.stage.hidden = state !== 'live';
    el.talk.disabled = state === 'connecting';
    el.talk.textContent = state === 'connecting' ? 'Connecting…' : 'Talk to Alice';
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
    pill.classList.add('is-on');
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

  el.controls.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button || !room) return;
    const pressed = button.getAttribute('aria-pressed') === 'true';
    try {
      if (button.dataset.act === 'mute') {
        await room.localParticipant.setMicrophoneEnabled(pressed);
        press(button, !pressed, 'Unmute', 'Mute');
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
    if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
    const json = await res.json();
    return { token: json.token ?? json.participantToken, url: json.url ?? json.serverUrl ?? json.livekit_url };
  }

  async function start() {
    if (room) return;
    setState('connecting');
    el.status.textContent = '';
    try {
      const grant = await getToken(el.passcode.value.trim());
      if (grant.needsPasscode) {
        el.passcode.hidden = false;
        el.passcode.focus();
        el.status.textContent = el.passcode.value ? 'That passcode did not work.' : 'Enter the passcode to start.';
        setState('idle');
        return;
      }
      if (!grant.token || !grant.url) throw new Error('the token reply had no token or url');

      room = new Room({ adaptiveStream: true, dynacast: true });
      registerPageActions({ ...handlers, say });
      room.registerTextStreamHandler('lk.transcription', onTranscription);
      room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
      room.on(RoomEvent.Disconnected, () => reset('Call ended. Talk to Alice again whenever you like.'));

      body.classList.add('no-face');
      await room.connect(grant.url, grant.token);
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
    body.classList.remove('no-face', 'face-hidden', 'camera-off');
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
    setState('live');
    showCaption('alice', 'Preview mode: this is where Alice talks.');
  }

  el.talk.addEventListener('click', start);
  el.passcode.addEventListener('keydown', (event) => { if (event.key === 'Enter') start(); });
  setState('idle');

  return { start, end, say, preview };
}
