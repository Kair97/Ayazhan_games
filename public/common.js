// Shared by host.html and player.html
const socket = io();
const $ = (sel, root = document) => root.querySelector(sel);

// Element builder. Text children are always set as text, never HTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// Wi-Fi drops are normal in a classroom: socket.io reconnects by itself, the banner just says so.
// Shown only after 1.5 s so a short blip doesn't flash it.
const offlineBanner = document.body.appendChild(h('div', { class: 'offline', role: 'status', hidden: true }, 'Байланыс үзілді. Қайта қосылып жатыр…'));
let offlineTimer = 0;
socket.on('disconnect', () => { offlineTimer = setTimeout(() => { offlineBanner.hidden = false; }, 1500); });
socket.on('connect', () => { clearTimeout(offlineTimer); offlineBanner.hidden = true; });

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

function show(id) {
  const target = document.getElementById(id);
  if (!target.hidden) return;
  document.querySelectorAll('.screen').forEach(s => { s.hidden = s !== target; });
  scrollTo(0, 0);
}

// Tamga-style answer symbols: sun, crescent, arrowhead, mountain.
const SHAPES = [
  '<circle cx="12" cy="12" r="8"/>',
  '<path d="M15.5 3a9.5 9.5 0 1 0 0 18 7.6 7.6 0 1 1 0-18z"/>',
  '<path d="M12 2.5 21.5 20h-19z"/>',
  '<path d="M12 2 22 12 12 22 2 12z"/>',
];
const SHAPE_NAMES = ['Күн', 'Ай', 'Жебе', 'Тау'];
const AVATARS = ['🐺', '🦅', '🐎', '🐆', '🦌', '🐫', '🦉', '🐻'];
const POWER_INFO = {
  shield: { icon: '🛡️', name: 'Қалқан', hint: 'Қате жауап серияңды үзбейді' },
  fifty: { icon: '✂️', name: '50/50', hint: 'Екі қате жауапты алып тастайды' },
  double: { icon: '⚡', name: 'Екі есе', hint: 'Осы сұрақтың ұпайы ×2' },
};
function shape(i) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'shape');
  s.setAttribute('fill', 'currentColor');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = SHAPES[i]; // constant markup, not user data
  return s;
}

const RUNE_RE = /[\u{10C00}-\u{10C4F}]/u;

// What sits between the question and the answers: a rune stele, a quote with a gap, or the clue list.
// `fill` puts the answer into the quote gap on reveal; clues from index `seen` on get the entrance animation.
function extras(q, fill = null, seen = 0) {
  const out = [];
  if (q.golden) out.push(h('span', { class: 'golden-banner' }, '✨ Алтын сұрақ · ұпай ×2'));
  if (q.image) {
    out.push(h('figure', { class: 'qimage' },
      h('img', { src: q.image.src, alt: 'Сұраққа арналған сурет' }),
      h('figcaption', {}, 'Фото: ', h('a', { href: q.image.url, target: '_blank', rel: 'noopener' }, q.image.credit))));
  }
  if (q.emoji) out.push(h('div', { class: 'emoji-big', role: 'img', 'aria-label': 'Эмодзи-жұмбақ' }, q.emoji));
  if (q.rune) out.push(h('div', { class: 'stone' }, h('span', { class: 'rune-font', dir: 'rtl', lang: 'otk' }, q.rune)));
  if (q.quote) {
    const [before, after] = q.quote.split('___');
    out.push(h('blockquote', { class: 'quote' }, '«', before, h('span', { class: fill ? 'gap filled' : 'gap' }, fill || ' '), after, '»'));
  }
  if (q.clues) {
    out.push(h('ol', { class: 'clues' },
      ...q.clues.map((c, i) => h('li', { class: i >= seen ? 'fresh' : '' }, c)),
      ...Array.from({ length: q.clueTotal - q.clues.length }, () => h('li', { class: 'locked' }, 'Келесі кеңес жақында ашылады…'))));
  }
  return out;
}

// Only https links are rendered, so a crafted quiz can't inject javascript: URLs.
const sourceLine = src => (src && /^https:\/\//.test(src.url)
  ? h('p', { class: 'source-line' }, 'Дереккөз: ', h('a', { href: src.url, target: '_blank', rel: 'noopener' }, src.title || 'Уикипедия'))
  : '');
const factBox = (text, src) => (text || src
  ? h('div', { class: 'fact' }, h('b', {}, 'Білесің бе?'), h('span', {}, text || '', sourceLine(src)))
  : '');

// Countdown ring. `remaining` comes from the server so phone clocks don't matter.
let countdownRaf = 0;
function countdown(el, remainingMs, totalMs) {
  cancelAnimationFrame(countdownRaf);
  const end = performance.now() + remainingMs;
  const num = el.querySelector('span');
  const tick = () => {
    const left = Math.max(0, end - performance.now());
    const sec = Math.ceil(left / 1000);
    if (sec <= 5 && sec > 0 && String(sec) !== num.textContent && typeof Sound !== 'undefined') Sound.sfx('tick');
    el.style.setProperty('--p', (left / totalMs).toFixed(4));
    num.textContent = sec;
    el.classList.toggle('low', left < 5000);
    if (left > 0) countdownRaf = requestAnimationFrame(tick);
  };
  tick();
}
const stopCountdown = () => cancelAnimationFrame(countdownRaf);

const buzz = pattern => navigator.vibrate?.(pattern);

// Small canvas confetti, gold and sky colours.
function confetti(ms = 4000) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.getElementById('confetti') || document.body.appendChild(h('canvas', { id: 'confetti' }));
  const ctx = c.getContext('2d');
  c.width = innerWidth; c.height = innerHeight;
  const colors = ['#f2b233', '#ffffff', '#4ea3e8', '#c8412b', '#1f8a5b'];
  const bits = Array.from({ length: 160 }, () => ({
    x: Math.random() * c.width, y: -20 - Math.random() * c.height * 0.6,
    vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3.5,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
    w: 6 + Math.random() * 8, color: colors[(Math.random() * colors.length) | 0],
  }));
  const stopAt = performance.now() + ms;
  (function frame(now) {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.r += b.vr;
      if (b.y > c.height && now < stopAt) { b.y = -20; b.x = Math.random() * c.width; }
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r);
      ctx.fillStyle = b.color; ctx.fillRect(-b.w / 2, -b.w / 4, b.w, b.w / 2);
      ctx.restore();
    }
    if (bits.some(b => b.y < c.height)) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, c.width, c.height);
  })(performance.now());
}

// ---------- confirm dialog + leaving a running game ----------
// Native <dialog> styled like the rest of the app; resolves true when the person confirms.
function confirmBox({ title, text, ok, cancel = 'Болдырмау', danger = false }) {
  return new Promise(resolve => {
    const dlg = h('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' },
      h('div', { class: 'dlg-body' }, h('h2', { id: 'confirm-title' }, title), h('p', {}, text)),
      h('div', { class: 'dlg-foot' },
        h('button', { class: 'btn btn-ghost', value: 'no', onclick: () => dlg.close('no') }, cancel),
        h('button', { class: danger ? 'btn btn-danger' : 'btn', value: 'yes', onclick: () => dlg.close('yes') }, ok)));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'yes'); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('.btn-ghost').focus(); // safe default: Enter keeps you in the game
  });
}

// A page sets `leaveGuard = { active: () => bool, ask: () => Promise<bool>, leave: () => Promise }`.
// While active, the logo link, the browser Back button and closing the tab all ask first.
let leaveGuard = null;
let backTrapped = false;

function syncBackTrap() {
  const on = !!leaveGuard?.active();
  if (on && !backTrapped) { history.pushState({ baigeGuard: true }, ''); backTrapped = true; }
}

async function tryLeave(go) {
  if (!leaveGuard?.active() || await leaveGuard.ask()) {
    if (leaveGuard?.active()) await leaveGuard.leave(); // wait for the server, or navigating away could drop the message
    backTrapped = false;
    go();
    return true;
  }
  return false;
}

document.querySelector('.brand')?.addEventListener('click', e => {
  if (!leaveGuard?.active()) return;
  e.preventDefault();
  tryLeave(() => { location.href = '/'; });
});

addEventListener('popstate', async () => {
  if (!backTrapped) return;
  backTrapped = false;
  const left = await tryLeave(() => history.back());
  if (!left) syncBackTrap(); // stayed: re-arm the trap
});

addEventListener('beforeunload', e => {
  if (leaveGuard?.active()) { e.preventDefault(); e.returnValue = ''; }
});

// Emit and wait for the server's ack, but never hang the UI longer than `ms`.
const emitAck = (ev, data, ms = 1500) => new Promise(resolve => socket.timeout(ms).emit(ev, ...(data === undefined ? [] : [data]), () => resolve()));
