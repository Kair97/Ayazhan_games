// Music and sound effects, synthesised in the browser: no audio files, no licences, works offline.
// Dombra-like plucks use Karplus-Strong synthesis; hooves are filtered noise bursts.
const Sound = (() => {
  const N = { D2: 73.42, A2: 110, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196, A3: 220, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392, A4: 440, C5: 523.25, D5: 587.33, F5: 698.46, A5: 880 };
  // 8 eighth-notes per bar: a küy-like riff over the open D string ('' = rest).
  const RIFF = [
    ['D4', 'D3', 'F4', 'D3', 'G4', 'D3', 'A4', 'G4'],
    ['F4', 'D3', 'E4', 'D3', 'D4', 'D3', 'C4', 'D4'],
    ['A3', 'D3', 'C4', 'D3', 'D4', 'F4', 'E4', 'D4'],
    ['C4', 'A3', 'C4', 'D4', 'D3', 'D3', 'D4', ''],
  ];
  const TENSION = [['D3', '', 'A2', '', 'D3', '', 'A2', 'D5']];

  let ctx = null, master = null, music = null, timer = 0, nextTime = 0, step = 0, mode = null, wanted = null;
  let muted = store.get('bayge.muted') === true;
  const cache = new Map();

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.7;
    master.connect(ctx.destination);
    return true;
  }

  function pluckBuffer(freq) {
    const key = Math.round(freq * 10);
    if (cache.has(key)) return cache.get(key);
    const sr = ctx.sampleRate, len = Math.round(sr * 1.3), period = Math.round(sr / freq);
    const buf = ctx.createBuffer(1, len, sr), out = buf.getChannelData(0);
    const ring = Float32Array.from({ length: period }, () => Math.random() * 2 - 1);
    for (let i = 0, j = 0; i < len; i++, j = (j + 1) % period) {
      out[i] = ring[j];
      ring[j] = (ring[j] + ring[(j + 1) % period]) * 0.4985; // lowpass + decay = plucked string
    }
    cache.set(key, buf);
    return buf;
  }

  function pluck(freq, t, vol = 0.3, dest = master) {
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = pluckBuffer(freq);
    g.gain.value = vol;
    src.connect(g).connect(dest);
    src.start(t);
  }

  function tone(freq, t, dur, vol = 0.2, type = 'sine', dest = master, endFreq = freq) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq !== freq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function hoof(t, vol = 0.5, dest = master) {
    const len = Math.round(ctx.sampleRate * 0.06);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf;
    f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 1.2;
    g.gain.value = vol;
    src.connect(f).connect(g).connect(dest);
    src.start(t);
  }

  // ---------- music loops (look-ahead scheduler) ----------
  const LOOPS = {
    lobby: { bpm: 138, bars: RIFF, vol: 0.32 },
    question: { bpm: 104, bars: TENSION, vol: 0.2 },
  };

  function schedule() {
    const loop = LOOPS[mode];
    const eighth = 30 / loop.bpm;
    nextTime = Math.max(nextTime, ctx.currentTime + 0.05); // a throttled background tab must not replay a backlog
    while (nextTime < ctx.currentTime + 0.25) {
      const bar = loop.bars[Math.floor(step / 8) % loop.bars.length];
      const note = bar[step % 8];
      if (note) pluck(N[note], nextTime, note.endsWith('2') || note.endsWith('3') ? loop.vol * 0.8 : loop.vol, music);
      if (mode === 'lobby' && step % 4 === 0) pluck(N.G3, nextTime + eighth / 2, loop.vol * 0.35, music); // second string
      nextTime += eighth;
      step++;
    }
  }

  function stopMusic() {
    clearInterval(timer);
    timer = 0;
    if (music) {
      const m = music;
      m.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
      setTimeout(() => m.disconnect(), 800);
    }
    music = null;
    mode = null;
  }

  // A one-shot piece ends by itself; `then` is what plays afterwards (null = silence).
  let shotTimer = 0;
  function oneShot(ms, then) {
    const piece = mode;
    clearTimeout(shotTimer);
    shotTimer = setTimeout(() => { if (mode === piece) { stopMusic(); wanted = then; if (then) play(then); } }, ms);
  }

  function play(name) {
    wanted = name;
    if (!ctx || ctx.state !== 'running') return; // starts after the first tap (browser autoplay rules)
    if (name === mode) return;
    stopMusic();
    if (!name) return;
    music = ctx.createGain();
    music.gain.value = 1;
    music.connect(master);
    const t = ctx.currentTime + 0.05;
    if (name === 'race') {
      for (let i = 0; i < 9; i++) { // gallop: ta-ka-TAK
        const b = t + i * 0.3;
        hoof(b, 0.35, music); hoof(b + 0.09, 0.3, music); hoof(b + 0.18, 0.55, music);
        pluck(N.D3, b, 0.18, music); pluck(N.A3, b + 0.15, 0.14, music);
      }
      mode = name;
      oneShot(2900, null);
      return;
    }
    if (name === 'final') {
      ['D4', 'F4', 'A4', 'D5'].forEach((n, i) => pluck(N[n], t + i * 0.13, 0.4, music));
      [0.7, 1.0, 1.3].forEach(dt => ['D4', 'A4', 'D5', 'F5'].forEach((n, i) => pluck(N[n], t + dt + i * 0.012, 0.28, music)));
      tone(N.D2, t + 0.7, 1.2, 0.35, 'sine', music, N.D2 * 0.7);
      ['A4', 'C5', 'D5', 'F5', 'A5'].forEach((n, i) => pluck(N[n], t + 1.9 + i * 0.1, 0.3, music));
      mode = name;
      oneShot(3600, 'lobby');
      return;
    }
    mode = name;
    step = 0;
    nextTime = t;
    schedule();
    timer = setInterval(schedule, 100);
  }

  function sfx(name) {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.01;
    switch (name) {
      case 'tick': tone(1800, t, 0.05, 0.12, 'square'); break;
      case 'tap': pluck(N.A4, t, 0.25); break;
      case 'join': pluck(N.D4, t, 0.3); pluck(N.A4, t + 0.08, 0.3); break;
      case 'correct': pluck(N.A4, t, 0.4); pluck(N.D5, t + 0.1, 0.45); pluck(N.F5, t + 0.2, 0.4); break;
      case 'wrong': tone(220, t, 0.45, 0.25, 'triangle', master, 110); break;
      case 'reveal': pluck(N.D5, t, 0.3); pluck(N.A4, t + 0.06, 0.25); break;
      case 'golden': ['D5', 'F5', 'A5'].forEach((n, i) => { pluck(N[n], t + i * 0.08, 0.3); tone(N[n] * 2, t + i * 0.08, 0.5, 0.05); }); break;
    }
  }

  function setMuted(v) {
    muted = v;
    store.set('bayge.muted', v);
    if (master) master.gain.setTargetAtTime(v ? 0 : 0.7, ctx.currentTime, 0.05);
  }

  // Browsers only allow sound after a user gesture.
  function unlock() {
    if (!init()) return;
    ctx.resume().then(() => { if (wanted && wanted !== mode) play(wanted); });
  }
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, unlock, { passive: true }));

  return { play, sfx, setMuted, get muted() { return muted; } };
})();

// A 🔊/🔇 button, same behaviour on every page.
function soundToggle() {
  const btn = h('button', { class: 'btn btn-ghost btn-small sound-btn', type: 'button' });
  const paint = () => {
    btn.textContent = Sound.muted ? '🔇' : '🔊';
    btn.setAttribute('aria-label', Sound.muted ? 'Дыбысты қосу' : 'Дыбысты өшіру');
    btn.setAttribute('aria-pressed', String(!Sound.muted));
  };
  btn.addEventListener('click', () => { Sound.setMuted(!Sound.muted); paint(); });
  paint();
  return btn;
}
