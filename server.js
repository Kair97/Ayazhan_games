const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const PACKS = require('./packs');
const ai = require('./ai');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {} // optional: AI key, PORT, PUBLIC_URL

const PORT = Number(process.env.PORT) || 3001;
const MAX_PLAYERS = 200;
const GRACE_MS = 600;            // network latency allowance after the timer hits zero
const ROOM_TTL_MS = 3 * 3600e3;  // idle rooms are swept after 3 hours
const MIN_TIME = { year: 25, order: 30, clues: 40, anagram: 30 }; // seconds; these types need thinking time whatever the host picked
const TEAMS = [
  { name: 'Көк бөрілер', icon: '🐺' }, { name: 'Алтын қырандар', icon: '🦅' },
  { name: 'Жүйрік тұлпарлар', icon: '🐎' }, { name: 'Ақ барыстар', icon: '🐆' },
];
const AVATARS = ['🐺', '🦅', '🐎', '🐆', '🦌', '🐫', '🦉', '🐻'];
// Power-ups, earned for every 2 correct answers in a row (max 2 in hand), used before answering.
const POWERS = ['shield', 'fifty', 'double'];

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '20kb' }));

app.get('/api/packs', (req, res) => {
  res.json(PACKS.map(p => ({ id: p.id, title: p.title, mode: p.mode, badge: p.badge, description: p.description, count: p.mix || p.questions.length })));
});

// Where phones should connect. PUBLIC_URL wins (tunnel / deployed domain), else the best Wi-Fi/LAN address.
app.get('/api/info', (req, res) => {
  res.json({ joinBase: process.env.PUBLIC_URL || (lanIp() ? `http://${lanIp()}:${PORT}` : null) });
});

app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 500);
  if (!text) return res.status(400).end();
  res.type('image/svg+xml').send(await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#0b1b33', light: '#ffffff' } }));
});

// ---------- AI generator ----------
// ponytail: per-IP hourly limit + global concurrency cap, so nobody on the Wi-Fi can burn the free quota.
const aiHits = new Map();
let aiBusy = 0;
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
app.get('/api/ai/status', (req, res) => res.json({ enabled: ai.enabled(), provider: ai.provider(), providerName: ai.providerName(), model: ai.model(), canSetKey: isLocal(req) }));

// The host pastes the key in the game instead of editing .env by hand. Only from the computer running the game.
app.post('/api/ai/key', async (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Кілтті тек ойын іске қосылған компьютерден енгізуге болады' });
  const key = String(req.body?.key ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{20,200}$/.test(key)) return res.status(400).json({ error: 'Бұл кілтке ұқсамайды. Оны толық көшіріп қойыңыз.' });
  const check = await ai.checkKey(key);
  if (!check.ok) return res.status(400).json({ error: check.error });
  const file = path.join(__dirname, '.env');
  let env = '';
  try { env = fs.readFileSync(file, 'utf8'); } catch {}
  const lines = env.split(/\r?\n/).filter(l => l && !l.startsWith('AI_API_KEY='));
  fs.writeFileSync(file, [...lines, `AI_API_KEY=${key}`, ''].join('\n'));
  process.env.AI_API_KEY = key;
  res.json({ ok: true });
});
app.post('/api/ai/generate', async (req, res) => {
  const now = Date.now();
  const hits = (aiHits.get(req.ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= 12) return res.status(429).json({ error: 'Бір сағатта 12 квизден көп жасауға болмайды' });
  if (aiBusy >= 2) return res.status(429).json({ error: 'ЖИ қазір бос емес, бір минуттан кейін қайталаңыз' });
  aiHits.set(req.ip, [...hits, now]);
  aiBusy++;
  try {
    res.json(await ai.generateQuiz(req.body || {}));
  } catch (e) {
    console.error('AI generate failed:', e.message);
    res.status(502).json({ error: e instanceof SyntaxError ? 'ЖИ дұрыс емес жауап қайтарды. Қайталап көріңіз.' : e.message });
  } finally {
    aiBusy--;
  }
});

// ---------- helpers ----------
const token = () => crypto.randomBytes(12).toString('hex');
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const typeOf = q => q.type || 'choice';

function newPin() {
  let pin;
  do pin = String(crypto.randomInt(100000, 1000000)); while (rooms.has(pin));
  return pin;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// "Аралас бәйге": a couple of random questions from every other game.
function mixQuestions(count) {
  const sources = PACKS.filter(p => !p.mix);
  const per = Math.ceil(count / sources.length) + 1;
  return shuffled(sources.flatMap(p => shuffled(p.questions).slice(0, per))).slice(0, count);
}

// Validates a host-made quiz (the in-browser editor makes 'choice' questions only). Returns an error string or null.
function validateQuiz(quiz) {
  if (!quiz || typeof quiz !== 'object') return 'Квиз табылмады';
  if (!Array.isArray(quiz.questions) || quiz.questions.length < 1 || quiz.questions.length > 50) return 'Квизде 1–50 сұрақ болуы керек';
  for (const [i, q] of quiz.questions.entries()) {
    const n = i + 1;
    if (!q || !clean(q.text, 200)) return `${n}-сұрақтың мәтіні жоқ`;
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return `${n}-сұрақта 2–4 жауап болуы керек`;
    if (q.options.some(o => !clean(o, 80))) return `${n}-сұрақта бос жауап бар`;
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) return `${n}-сұрақта дұрыс жауап белгіленбеген`;
    if (q.source && !/^https:\/\/[a-z]{2,3}\.wikipedia\.org\//.test(String(q.source.url))) return `${n}-сұрақтың дереккөзі жарамсыз`;
  }
  return null;
}

function sanitizeQuiz(quiz) {
  return {
    title: clean(quiz.title, 60) || 'Менің квизім',
    questions: quiz.questions.map(q => ({
      text: clean(q.text, 200), options: q.options.map(o => clean(o, 80)), correct: q.correct,
      fact: clean(q.fact, 300) || undefined,
      source: q.source ? { title: clean(q.source.title, 120), url: clean(q.source.url, 400) } : undefined,
    })),
  };
}

// ---------- rooms ----------
// ponytail: rooms live in memory, a server restart ends all games; add Redis if it ever runs on >1 process.
const rooms = new Map();
const current = room => room.questions[room.q];

const answeredAll = room => {
  const online = [...room.players.values()].filter(p => p.connected);
  return online.length > 0 && online.every(p => p.answer !== null);
};

// Team score is the members' average, so a team with one extra player gets no advantage.
function teamStandings(room) {
  if (!room.teams) return null;
  return TEAMS.slice(0, room.teams).map((t, i) => {
    const members = [...room.players.values()].filter(p => p.team === i);
    const total = members.reduce((n, p) => n + p.score, 0);
    return { ...t, members: members.length, score: members.length ? Math.round(total / members.length) : 0 };
  });
}

// New players join the smallest team (ties go to a random one of them).
function pickTeam(room) {
  const sizes = TEAMS.slice(0, room.teams).map((_, i) => [...room.players.values()].filter(p => p.team === i).length);
  const smallest = sizes.map((n, i) => [n, i]).filter(([n]) => n === Math.min(...sizes)).map(([, i]) => i);
  return smallest[crypto.randomInt(smallest.length)];
}

// Which options a 50/50 may hide: plain choice-style questions with at least 3 options.
const canFifty = q => ['choice', 'clues'].includes(typeOf(q)) && q.options.length >= 3;

// End-of-game awards from each player's per-question log.
function awards(room) {
  const players = [...room.players.values()];
  const out = [];
  const fast = players.flatMap(p => p.log.filter(l => l?.hit && l.ms != null).map(l => ({ p, ms: l.ms }))).sort((a, b) => a.ms - b.ms)[0];
  if (fast) out.push({ icon: '⚡', title: 'Ең жылдам', name: fast.p.name, avatar: fast.p.avatar, value: `${(fast.ms / 1000).toFixed(1)} с` });
  const streak = [...players].sort((a, b) => b.bestStreak - a.bestStreak || b.score - a.score)[0];
  if (streak?.bestStreak >= 2) out.push({ icon: '🔥', title: 'Ең ұзақ серия', name: streak.name, avatar: streak.avatar, value: `${streak.bestStreak} қатарынан` });
  const acc = p => { const done = p.log.filter(l => l && l.ms != null); return done.length ? done.filter(l => l.hit).length / done.length : -1; };
  const sniper = [...players].sort((a, b) => acc(b) - acc(a) || b.score - a.score)[0];
  if (sniper && acc(sniper) > 0) out.push({ icon: '🎯', title: 'Мерген', name: sniper.name, avatar: sniper.avatar, value: `${Math.round(acc(sniper) * 100)}% дәл` });
  return out;
}

// Teacher report: how the class did on every question (hardest first) and a results table.
function report(room) {
  const players = [...room.players.values()];
  return {
    questions: room.history.filter(Boolean).map(hq => ({ ...hq, pct: hq.players ? Math.round((hq.hits / hq.players) * 100) : 0 })).sort((a, b) => a.pct - b.pct),
    results: [...players].sort((a, b) => b.score - a.score).map(p => ({
      name: p.name, avatar: p.avatar, team: room.teams ? TEAMS[p.team].name : '', score: p.score,
      correct: p.log.filter(l => l?.hit).length, answers: room.questions.map((_, i) => (p.log[i] ? (p.log[i].hit ? 1 : 0) : null)),
    })),
    awards: awards(room),
  };
}

const rankOf = (room, p) => 1 + [...room.players.values()].filter(o => o.score > p.score).length;

// Speed-weighted: 1000 for an instant answer, 500 at the buzzer.
const speedPoints = (elapsedMs, limitMs) => Math.round(1000 - 500 * Math.min(1, Math.max(0, elapsedMs / limitMs)));
const streakBonus = streak => Math.min(streak, 3) * 100; // +100 per streak step, max +300

const isPermutation = (a, n) => Array.isArray(a) && a.length === n && new Set(a).size === n && a.every(i => Number.isInteger(i) && i >= 0 && i < n);

function validAnswer(room, a) {
  const q = current(room);
  switch (typeOf(q)) {
    case 'year': return Number.isInteger(a) && a >= q.min && a <= q.max;
    case 'order': return isPermutation(a, q.items.length);
    case 'anagram': return isPermutation(a, [...q.answer].length);
    default: return Number.isInteger(a) && a >= 0 && a < q.options.length;
  }
}

// → { hit, gained, diff?, right? }. `hit` keeps the streak going.
function grade(room, p) {
  const q = current(room);
  if (p.answer === null) return { hit: false, gained: 0 };
  switch (typeOf(q)) {
    case 'year': {
      const diff = Math.abs(p.answer - q.answer);
      const hit = diff <= q.tolerance / 10;
      const base = Math.round(1000 * Math.max(0, 1 - diff / q.tolerance));
      return { hit, diff, gained: base + (hit ? streakBonus(p.streak) : 0) };
    }
    case 'order': {
      const right = p.answer.filter((shown, pos) => room.display[shown] === pos).length;
      if (right === q.items.length) return { hit: true, right, gained: speedPoints(p.answerMs, room.limit) + streakBonus(p.streak) };
      return { hit: false, right, gained: right * 150 };
    }
    case 'anagram': {
      const letters = [...q.answer];
      const hit = p.answer.map(shown => letters[room.display[shown]]).join('') === q.answer; // compare text: repeated letters are interchangeable
      return { hit, gained: hit ? speedPoints(p.answerMs, room.limit) + streakBonus(p.streak) : 0 };
    }
    default: {
      const hit = p.answer === q.correct;
      return { hit, gained: hit ? speedPoints(p.answerMs, room.limit) + streakBonus(p.streak) : 0 };
    }
  }
}

function cluesShown(room) {
  const q = current(room);
  if (room.phase !== 'question') return q.clues.length;
  const step = room.limit / q.clues.length;
  return Math.min(q.clues.length, 1 + Math.floor((Date.now() - room.startedAt) / step));
}

// What everyone may see of the current question. Never includes the answer while it is open.
function publicQuestion(room) {
  const q = current(room);
  const type = typeOf(q);
  const v = { type, text: q.text, rune: q.rune, quote: q.quote, emoji: q.emoji, image: q.image, golden: isGolden(room) };
  if (type === 'choice' || type === 'clues') v.options = q.options;
  if (type === 'clues') { v.clues = q.clues.slice(0, cluesShown(room)); v.clueTotal = q.clues.length; }
  if (type === 'year') { v.min = q.min; v.max = q.max; }
  if (type === 'order') v.items = room.display.map(i => q.items[i]);
  if (type === 'anagram') v.letters = room.display.map(i => [...q.answer][i]);
  return v;
}

const solutionOf = q => ({ year: q.answer, order: q.items, anagram: q.answer }[typeOf(q)] ?? q.correct);
const isGolden = room => room.golden && room.q === room.questions.length - 1 && room.questions.length > 1;

function hostView(room) {
  const v = {
    phase: room.phase, pin: room.pin, title: room.title, q: room.q, total: room.questions.length,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, gained: p.gained, streak: p.streak, connected: p.connected, answered: p.answer !== null, team: p.team, power: room.phase === 'reveal' ? p.active : null })),
    teams: teamStandings(room),
    golden: room.golden,
  };
  if (room.phase === 'question' || room.phase === 'reveal') v.question = publicQuestion(room);
  if (room.phase === 'question') { v.remaining = Math.max(0, room.endsAt - Date.now()); v.timeLimit = room.limit / 1000; }
  if (room.phase === 'reveal') {
    const q = current(room);
    const all = [...room.players.values()];
    v.solution = solutionOf(q);
    v.fact = q.fact;
    v.source = q.source;
    v.hits = all.filter(p => p.hit).length;
    if (v.question.options) v.counts = q.options.map((_, i) => all.filter(p => p.answer === i).length);
    if (typeOf(q) === 'year') v.guesses = all.filter(p => p.answer !== null).map(p => ({ name: p.name, value: p.answer }));
  }
  if (room.phase === 'final') v.report = report(room);
  return v;
}

function playerView(room, p) {
  const v = { phase: room.phase, pin: room.pin, title: room.title, id: p.id, name: p.name, avatar: p.avatar, score: p.score, streak: p.streak, q: room.q, total: room.questions.length, playerCount: room.players.size, powers: p.powers, active: p.active };
  if (room.teams) { v.team = TEAMS[p.team]; v.teams = teamStandings(room); }
  if (room.phase === 'question' || room.phase === 'reveal') { v.question = publicQuestion(room); v.answer = p.answer; v.hidden = p.hidden; v.canFifty = canFifty(current(room)); }
  if (room.phase === 'question') { v.remaining = Math.max(0, room.endsAt - Date.now()); v.timeLimit = room.limit / 1000; }
  if (room.phase === 'reveal') {
    const q = current(room);
    Object.assign(v, { solution: solutionOf(q), fact: q.fact, source: q.source, gained: p.gained, hit: p.hit, diff: p.diff, right: p.right, shielded: p.shielded, newPower: p.newPower });
  }
  if (room.phase === 'final') v.awards = awards(room).filter(a => a.name === p.name);
  if (room.phase !== 'lobby' && room.phase !== 'question') v.rank = rankOf(room, p);
  return v;
}

const emitHost = room => io.to(`h:${room.pin}`).emit('host:state', hostView(room));
const emitPlayer = (room, p) => p.socketId && io.to(p.socketId).emit('player:state', playerView(room, p));
function emitAll(room) {
  emitHost(room);
  for (const p of room.players.values()) emitPlayer(room, p);
}

function clearTimers(room) {
  room.timers.forEach(clearTimeout);
  room.timers = [];
}

function askQuestion(room, index) {
  clearTimers(room);
  room.phase = 'question';
  room.q = index;
  const q = current(room);
  room.limit = Math.max(room.timeLimit, MIN_TIME[typeOf(q)] || 0) * 1000;
  room.startedAt = Date.now();
  room.endsAt = room.startedAt + room.limit;
  if (typeOf(q) === 'order') {
    do room.display = shuffled(q.items.map((_, i) => i)); while (room.display.every((v, i) => v === i));
  }
  if (typeOf(q) === 'anagram') {
    const letters = [...q.answer];
    do room.display = shuffled(letters.map((_, i) => i)); while (room.display.map(i => letters[i]).join('') === q.answer);
  }
  for (const p of room.players.values()) Object.assign(p, { answer: null, answerMs: 0, gained: 0, hit: false, diff: undefined, right: undefined, active: null, hidden: [], shielded: false, newPower: null });
  room.timers.push(setTimeout(() => reveal(room), room.limit + GRACE_MS));
  if (typeOf(q) === 'clues') {
    const step = room.limit / q.clues.length;
    for (let k = 1; k < q.clues.length; k++) room.timers.push(setTimeout(() => emitAll(room), k * step + 30));
  }
  emitAll(room);
}

function reveal(room) {
  if (room.phase !== 'question') return;
  clearTimers(room);
  const golden = isGolden(room);
  const q = current(room);
  for (const p of room.players.values()) {
    const g = grade(room, p);
    if (golden) g.gained *= 2;
    if (p.active === 'double') g.gained *= 2;
    Object.assign(p, g);
    p.score += g.gained;
    p.shielded = !g.hit && p.active === 'shield' && p.streak > 0;
    if (!p.shielded) p.streak = g.hit ? p.streak + 1 : 0;
    p.bestStreak = Math.max(p.bestStreak, p.streak);
    p.newPower = null;
    if (g.hit && p.streak % 2 === 0 && p.powers.length < 2) {
      p.newPower = POWERS[crypto.randomInt(POWERS.length)];
      p.powers.push(p.newPower);
    }
    p.log[room.q] = { hit: g.hit, ms: p.answer !== null ? p.answerMs : null };
  }
  const plain = typeOf(q) === 'choice' && !q.rune && !q.quote && !q.emoji && !q.image;
  room.history[room.q] = {
    text: q.text, type: typeOf(q), players: room.players.size, hits: [...room.players.values()].filter(p => p.hit).length,
    // plain multiple-choice questions can be re-used for a "hard questions" quiz
    quiz: plain ? { text: q.text, options: q.options, correct: q.correct, fact: q.fact, source: q.source } : undefined,
  };
  room.phase = 'reveal';
  emitAll(room);
}

function advance(room) {
  if (room.phase === 'question') return reveal(room);
  if (room.phase === 'reveal') room.phase = 'leaderboard';
  else if (room.phase === 'leaderboard') {
    if (room.q + 1 < room.questions.length) return askQuestion(room, room.q + 1);
    room.phase = 'final';
  } else return;
  emitAll(room);
}

function resetRoom(room) {
  clearTimers(room);
  room.phase = 'lobby';
  room.q = -1;
  room.questions = room.pick();
  room.history = [];
  for (const p of room.players.values()) Object.assign(p, { score: 0, streak: 0, bestStreak: 0, answer: null, gained: 0, hit: false, powers: [], active: null, hidden: [], log: [] });
  emitAll(room);
}

function closeRoom(room) {
  clearTimers(room);
  io.to(`r:${room.pin}`).emit('room:closed');
  io.in(`r:${room.pin}`).socketsLeave([`r:${room.pin}`, `h:${room.pin}`]);
  rooms.delete(room.pin);
}

setInterval(() => {
  for (const room of rooms.values()) if (Date.now() - room.touched > ROOM_TTL_MS) closeRoom(room);
}, 10 * 60e3).unref();

// ---------- sockets ----------
const reply = (ack, data) => typeof ack === 'function' && ack(data);

io.on('connection', socket => {
  const hostRoom = () => {
    const room = rooms.get(socket.data.hostOf);
    if (room) room.touched = Date.now();
    return room;
  };

  function becomeHost(room) {
    socket.data.hostOf = room.pin;
    socket.join([`h:${room.pin}`, `r:${room.pin}`]);
    socket.emit('host:state', hostView(room));
  }

  socket.on('host:create', (opts = {}, ack) => {
    let title, source;
    if (opts.custom) {
      const err = validateQuiz(opts.custom);
      if (err) return reply(ack, { error: err });
      const quiz = sanitizeQuiz(opts.custom);
      title = quiz.title;
      source = () => quiz.questions;
    } else {
      const pack = PACKS.find(p => p.id === opts.packId);
      if (!pack) return reply(ack, { error: 'Ойынды таңдаңыз' });
      title = pack.title;
      source = pack.mix ? () => mixQuestions(pack.mix) : () => pack.questions;
    }
    const shuffle = !!opts.shuffle;
    const pick = () => (shuffle ? shuffled(source()) : source().slice());
    const room = {
      pin: newPin(), hostKey: token(), title, pick, questions: pick(),
      timeLimit: [10, 20, 30, 60].includes(opts.timeLimit) ? opts.timeLimit : 20,
      teams: [2, 3, 4].includes(Number(opts.teams)) ? Number(opts.teams) : opts.teams === true ? 2 : 0,
      golden: opts.golden !== false, history: [],
      players: new Map(), phase: 'lobby', q: -1, limit: 0, startedAt: 0, endsAt: 0, display: [], timers: [], touched: Date.now(),
    };
    rooms.set(room.pin, room);
    reply(ack, { pin: room.pin, key: room.hostKey });
    becomeHost(room);
  });

  // Any device holding the host key can control the room (laptop screen + phone remote at once).
  socket.on('host:resume', ({ pin, key } = {}, ack) => {
    const room = rooms.get(String(pin));
    if (!room || room.hostKey !== key) return reply(ack, { error: 'Ойын табылмады' });
    room.touched = Date.now();
    reply(ack, { ok: true });
    becomeHost(room);
  });

  // "Жаңа ойын құру" with an unfinished game saved in the browser: look at it without taking control.
  socket.on('host:peek', ({ pin, key } = {}, ack) => {
    const room = rooms.get(String(pin));
    if (!room || room.hostKey !== key) return reply(ack, { error: 'Ойын табылмады' });
    reply(ack, { pin: room.pin, title: room.title, phase: room.phase, players: room.players.size, q: room.q, total: room.questions.length });
  });

  // End a game by its key (the host chose to start a new one instead).
  socket.on('host:end', ({ pin, key } = {}) => {
    const room = rooms.get(String(pin));
    if (room && room.hostKey === key) closeRoom(room);
  });

  socket.on('host:start', () => {
    const room = hostRoom();
    if (room && room.phase === 'lobby' && room.players.size > 0) askQuestion(room, 0);
  });
  socket.on('host:next', () => { const room = hostRoom(); if (room) advance(room); });
  socket.on('host:restart', () => { const room = hostRoom(); if (room) resetRoom(room); });
  socket.on('host:close', (ack) => { const room = hostRoom(); if (room) closeRoom(room); reply(ack, { ok: true }); });

  socket.on('host:kick', id => {
    const room = hostRoom();
    const p = room?.players.get(id);
    if (!p) return;
    room.players.delete(id);
    if (p.socketId) {
      io.to(p.socketId).emit('player:kicked');
      io.in(p.socketId).socketsLeave(`r:${room.pin}`);
    }
    if (room.phase === 'question' && answeredAll(room)) return reveal(room);
    emitAll(room);
  });

  socket.on('player:join', ({ pin, name, id, avatar } = {}, ack) => {
    const room = rooms.get(clean(pin, 6));
    if (!room) return reply(ack, { error: 'Мұндай PIN-кодпен ойын жоқ' });
    room.touched = Date.now();

    let p = room.players.get(id);
    if (!p) {
      name = clean(name, 20);
      if (!name) return reply(ack, { error: 'Есіміңді жаз' });
      if ([...room.players.values()].some(o => o.name.toLowerCase() === name.toLowerCase())) return reply(ack, { error: 'Бұл есім бос емес, басқасын таңда' });
      if (room.players.size >= MAX_PLAYERS) return reply(ack, { error: 'Ойын толы' });
      p = {
        id: token(), name, avatar: AVATARS.includes(avatar) ? avatar : AVATARS[crypto.randomInt(AVATARS.length)],
        score: 0, streak: 0, bestStreak: 0, answer: null, answerMs: 0, gained: 0, hit: false,
        powers: [], active: null, hidden: [], log: [], team: room.teams ? pickTeam(room) : undefined,
      };
      room.players.set(p.id, p);
    } else if (p.socketId && p.socketId !== socket.id) {
      io.in(p.socketId).socketsLeave(`r:${room.pin}`); // same player opened a second tab
    }
    p.socketId = socket.id;
    p.connected = true;
    socket.data.player = { pin: room.pin, id: p.id };
    socket.join(`r:${room.pin}`);
    reply(ack, { pin: room.pin, id: p.id, name: p.name });
    emitPlayer(room, p);
    emitHost(room);
  });

  // Use a power-up on the open question, before answering.
  socket.on('player:power', type => {
    const { pin, id } = socket.data.player || {};
    const room = rooms.get(pin);
    const p = room?.players.get(id);
    if (!p || p.socketId !== socket.id || room.phase !== 'question' || p.answer !== null || p.active || !p.powers.includes(type)) return;
    const q = current(room);
    if (type === 'fifty' && !canFifty(q)) return;
    p.powers.splice(p.powers.indexOf(type), 1);
    p.active = type;
    if (type === 'fifty') {
      const wrong = shuffled(q.options.map((_, i) => i).filter(i => i !== q.correct));
      p.hidden = wrong.slice(0, q.options.length >= 4 ? 2 : 1);
    }
    emitPlayer(room, p);
  });

  socket.on('player:answer', answer => {
    const { pin, id } = socket.data.player || {};
    const room = rooms.get(pin);
    const p = room?.players.get(id);
    if (!p || p.socketId !== socket.id || room.phase !== 'question' || p.answer !== null) return;
    if (!validAnswer(room, answer) || Date.now() > room.endsAt + GRACE_MS) return;
    p.answer = answer;
    p.answerMs = Date.now() - room.startedAt;
    if (answeredAll(room)) return reveal(room);
    emitPlayer(room, p);
    emitHost(room);
  });

  socket.on('player:leave', ack => {
    const { pin, id } = socket.data.player || {};
    const room = rooms.get(pin);
    socket.data.player = null;
    socket.leave(`r:${pin}`);
    reply(ack, { ok: true });
    if (!room?.players.delete(id)) return;
    if (room.phase === 'question' && answeredAll(room)) return reveal(room);
    emitHost(room);
  });

  socket.on('disconnect', () => {
    const { pin, id } = socket.data.player || {};
    const room = rooms.get(pin);
    const p = room?.players.get(id);
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = null;
    // No early reveal here: a phone reloading mid-question would end it for everyone.
    emitHost(room);
  });
});

// Best guess at the address phones on the same Wi-Fi can reach. Skips VPN/VM adapters
// (Radmin, VirtualBox, WSL, Docker...), which is what broke the old QR link.
function lanIp() {
  const virtual = /vethernet|virtualbox|vmware|wsl|docker|hyper-v|radmin|hamachi|zerotier|tailscale|bluetooth|vpn|loopback/i;
  let best = null;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      let score = virtual.test(name) || i.address.startsWith('192.168.56.') ? 0 : 10;
      if (/wi-?fi|wlan|wireless/i.test(name)) score += 3;
      else if (/ethernet|^eth|^en/i.test(name)) score += 1;
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) score += 1;
      if (!best || score > best.score) best = { score, address: i.address };
    }
  }
  return best?.address || null;
}

// Used by start-game.bat so a non-technical host lands straight on the game.
function openBrowser(url) {
  const { spawn } = require('child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

module.exports = { server, rooms, speedPoints };

if (require.main === module) {
  server.on('error', err => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`\n  ⚠ ${PORT} порты бос емес: сервер бұрыннан қосулы тұр.`);
    console.error('  Ескі терезеде Ctrl+C басып тоқтатыңыз немесе басқа порт: PORT=3002 npm start\n');
    process.exit(1);
  });
  server.listen(PORT, '0.0.0.0', () => {
    const lan = process.env.PUBLIC_URL || (lanIp() ? `http://${lanIp()}:${PORT}` : null);
    console.log('\n  Түрік қағанаты · Бәйге');
    console.log(`  Осы компьютерде:  http://localhost:${PORT}`);
    console.log(lan ? `  Телефондар үшін:  ${lan}  (бір Wi-Fi желісінде)` : '  ⚠ Wi-Fi/LAN табылмады — телефондар қосыла алмайды');
    console.log(`  ЖИ: ${ai.providerName()} · ${ai.model()}`);
    console.log('\n  Ойынды тоқтату үшін осы терезені жабыңыз.\n');
    if (process.env.OPEN_BROWSER) openBrowser(`http://localhost:${PORT}/host.html`);
  });
}
