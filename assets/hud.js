/* ────────────────────────────────────────────────────────────────────────
   weave HUD — shared runtime
   Chrome (clock, toasts), the waveform renderer, and the ambient voice
   engine. The voice engine uses the browser's real SpeechRecognition +
   getUserMedia analyser when available, and degrades to a synthesised
   amplitude source so the HUD stays honest about what it is doing.
   ──────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  /* ── small helpers ───────────────────────────────────────────────── */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const el = (tag, attrs, kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach((c) => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ── storage ──────────────────────────────────────────────────────
     A sandboxed iframe without allow-same-origin throws a SecurityError on
     any sessionStorage access. That must never be able to kill a page, so
     every read/write goes through here and degrades to a no-op. */
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* storage denied */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* storage denied */ } }
  };

  /* ── clock: mission time, mono, tabular ──────────────────────────── */
  function clock(node) {
    if (!node) return;
    const tick = () => {
      const d = new Date();
      node.textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ── toasts ──────────────────────────────────────────────────────── */
  let toastHost = null;
  function toast(message, ms) {
    if (!toastHost) {
      toastHost = el('div', { class: 'toasts' });
      document.body.appendChild(toastHost);
    }
    const t = el('div', { class: 'toast', text: message });
    toastHost.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity 200ms';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 220);
    }, ms || 2600);
  }

  /* ── waveform ────────────────────────────────────────────────────── */
  function waveform(node, bars) {
    if (!node) return { set() {}, idle() {} };
    const count = bars || 28;
    node.innerHTML = '';
    const items = [];
    for (let i = 0; i < count; i++) {
      const b = el('i');
      node.appendChild(b);
      items.push(b);
    }
    // a fixed envelope so the centre of the waveform reads taller than the edges
    const envelope = items.map((_, i) => {
      const t = i / (count - 1);
      return 0.35 + 0.65 * Math.sin(Math.PI * t);
    });
    let phase = 0;
    return {
      set(level) {
        node.dataset.live = level > 0.04 ? 'true' : 'false';
        phase += 0.55;
        items.forEach((b, i) => {
          const jitter = 0.55 + 0.45 * Math.abs(Math.sin(phase * 0.5 + i * 0.7));
          const h = 3 + level * 30 * envelope[i] * jitter;
          b.style.height = `${clamp(h, 3, 34)}px`;
        });
      },
      idle() {
        node.dataset.live = 'false';
        items.forEach((b, i) => { b.style.height = `${3 + envelope[i] * 2}px`; });
      }
    };
  }

  /* ── voice engine ────────────────────────────────────────────────── */
  const SR = global.SpeechRecognition || global.webkitSpeechRecognition;

  class VoiceEngine {
    constructor(opts) {
      this.opts = opts || {};
      this.state = 'idle';          // idle | listening | thinking | speaking | muted
      this.micMuted = false;
      this.speakerMuted = false;
      this.level = 0;
      this._raf = null;
      this._sim = null;
      this._rec = null;
      this._stream = null;
      this._ctx = null;
      this._analyser = null;
      this._buf = null;
      // capability report — surfaced in the UI so the HUD never lies
      this.caps = {
        recognition: !!SR,
        synthesis: 'speechSynthesis' in global,
        mic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
      };
    }

    _setState(s) {
      if (this.state === s) return;
      this.state = s;
      this.opts.onState && this.opts.onState(s);
    }

    /* Begin a listening turn. Resolves once the pipeline is running —
       whether that pipeline is a real mic or the synthesised fallback. */
    async listen() {
      if (this.state === 'listening') return;
      if (this.micMuted) { toast('mic muted — unmute to talk'); return; }
      this._setState('listening');
      let real = false;
      if (this.caps.mic) {
        try {
          this._stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true }
          });
          const Ctx = global.AudioContext || global.webkitAudioContext;
          this._ctx = new Ctx();
          const src = this._ctx.createMediaStreamSource(this._stream);
          this._analyser = this._ctx.createAnalyser();
          this._analyser.fftSize = 512;
          this._analyser.smoothingTimeConstant = 0.72;
          src.connect(this._analyser);
          this._buf = new Uint8Array(this._analyser.frequencyBinCount);
          real = true;
        } catch (e) {
          real = false;
        }
      }
      this.usingRealMic = real;
      if (real) this._pumpAnalyser(); else this._pumpSimulated();

      if (this.caps.recognition && real) {
        try {
          const rec = new SR();
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = 'en-US';
          rec.onresult = (ev) => {
            let interim = '', final = '';
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
              const r = ev.results[i];
              if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
            }
            if (interim) this.opts.onInterim && this.opts.onInterim(interim.trim());
            if (final) this.opts.onFinal && this.opts.onFinal(final.trim());
          };
          rec.onerror = () => {};
          rec.onend = () => { if (this.state === 'listening') { try { rec.start(); } catch (e) {} } };
          rec.start();
          this._rec = rec;
        } catch (e) { this._rec = null; }
      } else if (!real) {
        this.opts.onNoMic && this.opts.onNoMic();
      }
    }

    stop() {
      if (this._rec) { try { this._rec.onend = null; this._rec.stop(); } catch (e) {} this._rec = null; }
      if (this._stream) { this._stream.getTracks().forEach((t) => t.stop()); this._stream = null; }
      if (this._ctx) { try { this._ctx.close(); } catch (e) {} this._ctx = null; }
      cancelAnimationFrame(this._raf);
      clearInterval(this._sim);
      this._sim = null;
      this.level = 0;
      this.opts.onLevel && this.opts.onLevel(0);
      if (this.state === 'listening') this._setState(this.micMuted ? 'muted' : 'idle');
    }

    _pumpAnalyser() {
      const loop = () => {
        if (!this._analyser) return;
        this._analyser.getByteTimeDomainData(this._buf);
        let sum = 0;
        for (let i = 0; i < this._buf.length; i++) {
          const v = (this._buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / this._buf.length);
        this.level = clamp(rms * 3.4, 0, 1);
        this.opts.onLevel && this.opts.onLevel(this.level);
        this._raf = requestAnimationFrame(loop);
      };
      loop();
    }

    /* No mic (denied / unavailable): drive the waveform from a smoothed
       random walk so the HUD still animates, and say so in the caption. */
    _pumpSimulated() {
      let v = 0.2;
      this._sim = setInterval(() => {
        v = clamp(v + (Math.random() - 0.45) * 0.3, 0.05, 0.9);
        this.level = v;
        this.opts.onLevel && this.opts.onLevel(v);
      }, 70);
    }

    /* Speak a line. weave's voice persona is terse by contract — she
       displays data and narrates only the outcome. */
    speak(text) {
      if (this.speakerMuted || !this.caps.synthesis) {
        this._setState('idle');
        return;
      }
      try {
        global.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.06;
        u.pitch = 0.92;
        const pick = (global.speechSynthesis.getVoices() || []).find((v) =>
          /Daniel|Serena|Samantha|Google UK English/.test(v.name));
        if (pick) u.voice = pick;
        u.onstart = () => this._setState('speaking');
        u.onend = () => this._setState(this.micMuted ? 'muted' : 'idle');
        global.speechSynthesis.speak(u);
      } catch (e) {
        this._setState('idle');
      }
    }

    setMicMuted(v) {
      this.micMuted = v;
      if (v) this.stop();
      this._setState(v ? 'muted' : 'idle');
    }

    setSpeakerMuted(v) {
      this.speakerMuted = v;
      if (v && this.caps.synthesis) global.speechSynthesis.cancel();
    }

    thinking() { this._setState('thinking'); }
    settle() { this._setState(this.micMuted ? 'muted' : 'idle'); }
  }

  /* ── orb wiring: click to toggle, hold Space for push-to-talk ─────── */
  function bindOrb(orbNode, engine, captionNode) {
    if (!orbNode) return;
    const caption = () => {
      if (!captionNode) return;
      const map = {
        idle: engine.caps.recognition ? 'Hold Space · push to talk' : 'Tap to talk · text fallback',
        listening: engine.usingRealMic ? 'Listening' : 'Listening · no mic, demo signal',
        thinking: 'Working',
        speaking: 'Speaking',
        muted: 'Mic muted'
      };
      captionNode.textContent = map[engine.state] || '';
    };
    orbNode.addEventListener('click', () => {
      if (engine.state === 'listening') engine.stop(); else engine.listen();
      setTimeout(caption, 30);
    });
    const prev = engine.opts.onState;
    engine.opts.onState = (s) => {
      orbNode.dataset.state = s;
      caption();
      prev && prev(s);
    };
    orbNode.dataset.state = engine.state;
    caption();

    let held = false;
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || held) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      held = true;
      e.preventDefault();
      engine.listen();
    });
    document.addEventListener('keyup', (e) => {
      if (e.code !== 'Space' || !held) return;
      held = false;
      engine.stop();
    });
  }

  /* ── typewriter: streams a string into a node, token-ish ─────────── */
  function stream(node, text, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const words = text.split(/(\s+)/);
      let i = 0;
      const caret = el('span', { class: 'caret' });
      node.appendChild(caret);
      const step = () => {
        if (i >= words.length) {
          caret.remove();
          resolve();
          return;
        }
        caret.insertAdjacentText('beforebegin', words[i++]);
        o.onTick && o.onTick();
        setTimeout(step, 12 + Math.random() * 34);
      };
      step();
    });
  }

  /* ── boot sequence: reveals a HUD one line at a time ─────────────── */
  function boot(lines, node, done) {
    let i = 0;
    const next = () => {
      if (i >= lines.length) { done && done(); return; }
      const row = el('div', { class: 'meta' });
      row.innerHTML = lines[i++];
      node.appendChild(row);
      setTimeout(next, 90 + Math.random() * 120);
    };
    next();
  }

  global.WeaveHUD = { $, $$, el, clock, toast, waveform, VoiceEngine, bindOrb, stream, boot, clamp, pad, store };
})(window);
