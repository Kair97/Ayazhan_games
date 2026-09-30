const HOST_KEY = 'bayge.host';
const QUIZZES_KEY = 'bayge.quizzes';

let state = null;
let packs = [];
let joinBase = location.origin;
let editingId = null;
let aiEnabled = false;
let aiCanSetKey = false;
let aiProvider = 'free';
let aiShowKey = false;

$('#sound-slot').append(soundToggle());
const loadAiStatus = () => fetch('/api/ai/status').then(r => r.json()).then(r => { aiEnabled = r.enabled; aiCanSetKey = r.canSetKey; aiProvider = r.provider; aiProviderName = r.providerName; }).catch(() => {});
let aiProviderName = '';
loadAiStatus();

// ---------- boot ----------
// A control link (host.html?pin=..&key=..) opened on a phone makes it a second remote for the same game.
const params = new URLSearchParams(location.search);
let wantsNew = params.has('new'); // came from "Жаңа ойын құру": don't silently reopen an old game
if (params.get('pin') && params.get('key')) {
  store.set(HOST_KEY, { pin: params.get('pin'), key: params.get('key') });
  wantsNew = false;
}
if (params.toString()) history.replaceState(null, '', location.pathname);

leaveGuard = {
  active: () => !!state && !!store.get(HOST_KEY) && state.phase !== 'final',
  ask: () => confirmBox({
    title: 'Ойынды аяқтайсыз ба?',
    text: 'Ойын жабылып, барлық ойыншылар шығып қалады. Ұпайлар сақталмайды.',
    ok: 'Ойынды аяқтау', cancel: 'Ойынға оралу', danger: true,
  }),
  leave: () => { store.del(HOST_KEY); state = null; return emitAck('host:close'); },
};

const infoReady = (async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  // Opened as localhost: phones can't use that address, ask the server for its Wi-Fi address.
  const info = await fetch('/api/info').then(r => r.json()).catch(() => ({}));
  if (info.joinBase) joinBase = info.joinBase;
  else {
    $('#lan-warn').hidden = false;
    $('#lan-warn').textContent = 'Wi-Fi желісі табылмады. Ноутбукті телефондар қосылған Wi-Fi желісіне қосыңыз, сосын серверді қайта іске қосыңыз.';
  }
})();

function resume() {
  const session = store.get(HOST_KEY);
  if (!session) { if (!state) showSetup(); return; }
  if (wantsNew) return offerOldGame(session);
  socket.emit('host:resume', session, r => {
    if (r?.error) { store.del(HOST_KEY); showSetup(); }
  });
}

// An unfinished game is still saved in this browser: continue it or close it and start fresh.
function offerOldGame(session) {
  wantsNew = false;
  socket.emit('host:peek', session, async r => {
    if (r?.error || r.phase === 'final') {
      if (!r?.error) socket.emit('host:end', session);
      store.del(HOST_KEY);
      return showSetup();
    }
    const where = r.phase === 'lobby' ? 'әлі басталмаған' : `жүріп жатыр (сұрақ ${r.q + 1} / ${r.total})`;
    const keep = await confirmBox({
      title: 'Аяқталмаған ойын бар',
      text: `«${r.title}» (PIN ${r.pin}, ${r.players} ойыншы) ойыны ${where}. Оны жалғастырасыз ба, әлде жабып, жаңа ойын құрасыз ба?`,
      ok: 'Ескі ойынды жалғастыру', cancel: 'Жабу және жаңа ойын',
    });
    if (keep) return resume();
    socket.emit('host:end', session);
    store.del(HOST_KEY);
    showSetup();
  });
}
socket.on('connect', resume);
// Host running the game from a phone that slept: refresh the state on wake.
document.addEventListener('visibilitychange', () => { if (!document.hidden && socket.connected && state) resume(); });

socket.on('host:state', async s => {
  await infoReady;
  const prev = state;
  state = s;
  syncBackTrap();
  $('#game-actions').hidden = false;
  $('#top-pin').textContent = s.pin;
  const fresh = !prev || prev.phase !== s.phase || prev.q !== s.q || prev.pin !== s.pin;
  if (s.phase === 'lobby') renderLobby(s, fresh);
  else if (s.phase === 'question' || s.phase === 'reveal') renderPlay(s, prev);
  else if (s.phase === 'leaderboard') renderBoard(s, fresh);
  else if (s.phase === 'final') renderFinal(s, fresh);
});

socket.on('room:closed', () => { store.del(HOST_KEY); showSetup(); });

// ---------- setup ----------
const myQuizzes = () => store.get(QUIZZES_KEY) || [];

async function showSetup() {
  state = null;
  stopCountdown();
  $('#game-actions').hidden = true;
  Sound.play(null);
  show('setup');
  $('#ai-open').hidden = false;
  if (!packs.length) packs = await fetch('/api/packs').then(r => r.json()).catch(() => []);
  renderPacks();
}

function renderPacks(select) {
  const current = select || $('#packs input:checked')?.value;
  const cards = [
    ...packs.map(p => packCard(`pack:${p.id}`, p.title, p.description, p.count, p.mode, p.badge)),
    ...myQuizzes().map(q => packCard(`mine:${q.id}`, q.title, 'Өз сұрақтарым', q.questions.length, 'Менің квизім', '✎', q.id)),
    h('button', { type: 'button', class: 'pack pack-new', onclick: () => openEditor() }, '+ Өз квизіңді құру'),
  ];
  $('#packs').replaceChildren(...cards);
  const radios = [...$('#packs').querySelectorAll('input')];
  (radios.find(r => r.value === current) || radios[0]).checked = true;
}

function packCard(value, title, desc, count, mode, badge, mineId) {
  const stop = fn => e => { e.preventDefault(); fn(); };
  return h('label', { class: 'pack' },
    h('input', { type: 'radio', name: 'pack', value }),
    h('span', { class: RUNE_RE.test(badge) ? 'pack-badge rune-font' : 'pack-badge', 'aria-hidden': 'true' }, badge),
    h('span', { class: 'pack-body' },
      h('span', { class: 'pack-mode' }, `${mode} · ${count} сұрақ`),
      h('div', { class: 'pack-title' }, title),
      h('div', { class: 'pack-desc' }, desc)),
    mineId && h('span', { class: 'pack-tools' },
      h('button', { type: 'button', onclick: stop(() => openEditor(mineId)) }, 'Өзгерту'),
      h('button', { type: 'button', onclick: stop(() => deleteQuiz(mineId)) }, 'Жою')));
}

$('#setup-form').addEventListener('submit', e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const [kind, id] = String(f.get('pack') || '').split(':');
  const opts = { timeLimit: Number(f.get('time')), shuffle: f.get('shuffle') === 'on', golden: f.get('golden') === 'on', teams: f.get('teams') === 'on' };
  if (kind === 'mine') opts.custom = myQuizzes().find(q => q.id === id);
  else opts.packId = id;
  const btn = $('#create-btn');
  btn.disabled = true;
  $('#setup-error').textContent = '';
  socket.timeout(8000).emit('host:create', opts, (err, r) => {
    btn.disabled = false;
    if (err) return ($('#setup-error').textContent = 'Сервер жауап бермеді. Сервер қосулы екенін тексеріңіз.');
    if (r.error) return ($('#setup-error').textContent = r.error);
    store.set(HOST_KEY, { pin: r.pin, key: r.key });
  });
});

// ---------- lobby ----------
function renderLobby(s, fresh) {
  show('lobby');
  Sound.play('lobby');
  if (fresh) {
    const url = `${joinBase}/player.html?pin=${s.pin}`;
    $('#join-url').textContent = joinBase.replace(/^https?:\/\//, '');
    $('#pin').textContent = s.pin.replace(/(\d{3})(\d{3})/, '$1 $2');
    $('#qr').src = `/qr.svg?text=${encodeURIComponent(url)}`;
    $('#pack-title').textContent = s.title;
  }
  $('#player-count').textContent = s.players.length;
  $('#pack-title').textContent = s.teams ? s.teams.map(t => `${t.icon} ${t.members}`).join('  ·  ') : s.title;

  // Update chips in place so already-joined players don't re-animate.
  const chips = $('#chips');
  const ids = new Set(s.players.map(p => p.id));
  for (const c of [...chips.children]) if (!ids.has(c.dataset.id)) c.remove();
  for (const p of s.players) {
    let c = chips.querySelector(`[data-id="${p.id}"]`);
    if (!c) {
      Sound.sfx('join');
      c = h('span', { class: p.team === undefined ? 'chip' : `chip team${p.team}`, 'data-id': p.id, title: p.team === undefined ? '' : s.teams[p.team].name },
        p.team === undefined ? '' : h('span', { 'aria-hidden': 'true' }, s.teams[p.team].icon),
        h('span', {}, p.name),
        h('button', { title: 'Ойыннан шығару', 'aria-label': `${p.name}: ойыннан шығару`, onclick: () => socket.emit('host:kick', p.id) }, '×'));
      chips.append(c);
    }
    c.classList.toggle('off', !p.connected);
  }
  if (!s.players.length) chips.replaceChildren(h('div', { class: 'empty muted' }, 'Әзірге ешкім жоқ. Ойыншылар QR-кодты сканерлеп немесе PIN-кодты енгізіп қосылады.'));
  $('#start-btn').disabled = !s.players.length;
}

// ---------- question / reveal ----------
let extrasKey = '';
let seenClues = 0;

function renderPlay(s, prev) {
  show('play');
  const q = s.question;
  const rebuild = !prev || prev.q !== s.q || prev.pin !== s.pin || !['question', 'reveal'].includes(prev.phase);
  const justRevealed = s.phase === 'reveal' && (rebuild || prev.phase !== 'reveal');

  if (rebuild) {
    seenClues = 0;
    if (s.phase === 'question') { Sound.play('question'); if (q.golden) Sound.sfx('golden'); }
    $('#qcount').textContent = `Сұрақ ${s.q + 1} / ${s.total}`;
    $('#qtext').textContent = q.text;
    $('#qbody').replaceChildren(questionBody(q));
    $('#fact').replaceChildren();
  }

  // Extras change when a clue opens or the quote gap gets its answer, not on every answer count update.
  const key = `${s.pin}|${s.q}|${s.phase}|${q.clues?.length}`;
  if (key !== extrasKey) {
    extrasKey = key;
    const fill = s.phase === 'reveal' && q.quote ? q.options[s.solution] : null;
    $('#qextra').replaceChildren(...extras(q, fill, seenClues));
    seenClues = q.clues?.length || 0;
  }

  if (s.phase === 'question') {
    if (rebuild) { $('#timer').hidden = false; countdown($('#timer'), s.remaining, s.timeLimit * 1000); }
    const online = s.players.filter(p => p.connected).length;
    $('#answered').replaceChildren('Жауап берді: ', h('b', {}, `${s.players.filter(p => p.answered).length} / ${online}`));
    $('#next-btn').textContent = 'Уақытты тоқтату';
    return;
  }

  if (justRevealed) {
    stopCountdown();
    Sound.play(null);
    Sound.sfx('reveal');
    $('#timer').hidden = true;
    if (q.type === 'year') $('#qbody').replaceChildren(yearReveal(q, s));
    else if (q.type === 'order') $('#qbody').replaceChildren(orderList(s.solution.map(t => q.items.indexOf(t)), q.items, true));
    else if (q.type === 'anagram') $('#qbody').replaceChildren(letterRow([...s.solution], 'letters answer'));
    else revealTiles(s);
    $('#fact').replaceChildren(factBox(s.fact, s.source));
  }
  const label = { year: 'Дәл тапты', order: 'Толық дұрыс', anagram: 'Сөзді құрады' }[q.type] || 'Дұрыс жауап';
  $('#answered').replaceChildren(`${label}: `, h('b', {}, `${s.hits} / ${s.players.length}`));
  $('#next-btn').textContent = 'Бәйгені көрсету';
}

function questionBody(q) {
  if (q.type === 'year') {
    return h('div', { class: 'yearq' },
      h('div', { class: 'year-big', 'aria-hidden': 'true' }, '?'),
      h('p', { class: 'year-range' }, `${q.min} — ${q.max}`),
      h('p', { class: 'muted' }, 'Телефоныңнан жылды таңда. Неғұрлым жақын болсаң, соғұрлым көп ұпай аласың'));
  }
  if (q.type === 'order') return orderList(q.items.map((_, i) => i), q.items, false);
  if (q.type === 'anagram') return letterRow(q.letters, 'letters');
  return h('div', { class: q.options.length === 2 ? 'tiles two' : 'tiles', id: 'tiles' },
    ...q.options.map((o, i) => h('div', { class: `tile t${i}` },
      shape(i), h('span', { class: 'label' }, o, h('span', { class: 'tick' }, '✓')), h('span', { class: 'num' }), h('span', { class: 'bar' }))));
}

const letterRow = (letters, cls) => h('div', { class: cls, 'aria-label': letters.join('') }, ...letters.map(l => h('span', { class: 'letter' }, l)));

// Items keep the colour/shape they had on the players' phones, so the correct order is easy to follow.
function orderList(shownIdx, items, solved) {
  return h(solved ? 'ol' : 'ul', { class: solved ? 'orderlist solved' : 'orderlist' },
    ...shownIdx.map((i, pos) => h('li', { class: `t${i}` },
      solved ? h('span', { class: 'n' }, pos + 1) : shape(i),
      h('span', {}, items[i]))));
}

function revealTiles(s) {
  const tiles = $('#tiles');
  tiles.classList.add('revealed');
  const max = Math.max(1, ...s.counts);
  [...tiles.children].forEach((t, i) => {
    t.classList.toggle('right', i === s.solution);
    t.querySelector('.num').textContent = s.counts[i];
  });
  void tiles.offsetHeight; // let the bars start from 0 so the height transition runs
  [...tiles.children].forEach((t, i) => { t.querySelector('.bar').style.height = `${(s.counts[i] / max) * 100}%`; });
}

function yearReveal(q, s) {
  const values = s.guesses.map(g => g.value);
  const span = Math.max(20, Math.max(s.solution, ...values) - Math.min(s.solution, ...values));
  const lo = Math.max(q.min, Math.min(s.solution, ...values) - Math.round(span * 0.15));
  const hi = Math.min(q.max, Math.max(s.solution, ...values) + Math.round(span * 0.15));
  const at = v => `${((v - lo) / (hi - lo || 1)) * 100}%`;
  const closest = [...s.guesses].sort((a, b) => Math.abs(a.value - s.solution) - Math.abs(b.value - s.solution)).slice(0, 3);
  return h('div', { class: 'yearq' },
    h('div', { class: 'year-big' }, s.solution),
    h('div', { class: 'numline' },
      h('span', { class: 'nl-edge', style: 'left:0' }, lo),
      h('span', { class: 'nl-edge', style: 'left:100%' }, hi),
      ...s.guesses.map(g => h('span', { class: 'nl-dot', style: `left:${at(g.value)}`, title: `${g.name}: ${g.value}` })),
      h('span', { class: 'nl-answer', style: `left:${at(s.solution)}` }, h('span', {}, s.solution))),
    closest.length
      ? h('div', { class: 'closest' }, ...closest.map((g, i) => h('span', { class: 'pill' }, `${['🥇', '🥈', '🥉'][i]} ${g.name} — ${g.value}`)))
      : h('p', { class: 'muted' }, 'Ешкім жауап бермеді'));
}

// ---------- бәйге ----------
const ranked = players => [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
const rankIn = (players, p) => 1 + players.filter(o => o.score > p.score).length;

function renderBoard(s, fresh) {
  show('board');
  if (!fresh) return;
  const top = ranked(s.players).slice(0, 8);
  const max = Math.max(1, top[0]?.score || 0);
  $('#board-sub').textContent = `Сұрақ ${s.q + 1} / ${s.total} аяқталды`;
  $('#board-next').textContent = s.q + 1 < s.total ? 'Келесі сұрақ' : 'Нәтижелер';

  Sound.play('race');
  $('#board-teams').replaceChildren(teamBar(s.teams));
  const race = $('#race');
  const pos = x => `calc(${x.toFixed(4)} * (100% - 44px))`;
  race.replaceChildren(...top.map((p, i) => h('div', { class: i === 0 ? 'lane first' : 'lane' },
    h('span', { class: 'lane-rank' }, rankIn(s.players, p)),
    h('span', { class: 'lane-name' }, p.name),
    h('div', { class: 'track' }, h('span', { class: 'horse', style: `left:${pos((p.score - p.gained) / max)}`, 'data-to': p.score / max, 'aria-hidden': 'true' }, '🐎')),
    h('span', { class: 'lane-score' }, p.score, p.gained ? h('span', { class: 'lane-gain' }, `+${p.gained}`) : ''))));
  if (!top.length) race.append(h('p', { class: 'muted', style: 'text-align:center' }, 'Ойыншылар жоқ'));

  // Horses start where they were before this question and gallop forward by the points just won.
  void race.offsetWidth;
  race.classList.add('running');
  race.querySelectorAll('.horse').forEach(el => { el.style.left = pos(Number(el.dataset.to)); });
  setTimeout(() => race.classList.remove('running'), 2300);
}

function teamBar(teams) {
  if (!teams) return '';
  const lead = teams[0].score === teams[1].score ? -1 : teams[0].score > teams[1].score ? 0 : 1;
  return h('div', { class: 'team-bar' }, ...teams.map((t, i) => h('div', { class: i === lead ? 'team-card lead' : 'team-card' },
    h('span', { class: 'ic', 'aria-hidden': 'true' }, t.icon),
    h('span', {}, h('div', { class: 'nm' }, t.name), h('div', { class: 'sub' }, `${t.members} ойыншы · орташа ұпай`)),
    h('span', { class: 'sc' }, t.score))));
}

// ---------- final ----------
function renderFinal(s, fresh) {
  show('final');
  if (!fresh) return;
  const list = ranked(s.players);
  Sound.play('final');
  $('#final-sub').textContent = s.title;
  if (s.teams) {
    const [a, b] = s.teams;
    const win = a.score === b.score ? 'Командалар тең түсті!' : `Жеңімпаз команда: ${(a.score > b.score ? a : b).icon} ${(a.score > b.score ? a : b).name}`;
    $('#final-teams').replaceChildren(h('p', { class: 'winner-team' }, win), teamBar(s.teams));
  } else $('#final-teams').replaceChildren();
  $('#podium').replaceChildren(...list.slice(0, 3).map((p, i) => h('div', { class: `step p${i + 1}` },
    i === 0 && h('span', { class: 'crown', 'aria-hidden': 'true' }, '👑'),
    h('div', { class: 'who' }, p.name),
    h('div', { class: 'pts' }, `${p.score} ұпай`),
    h('div', { class: 'block' }, rankIn(s.players, p)))));
  $('#rest').replaceChildren(...list.slice(3).map(p =>
    h('li', {}, h('span', {}, `${rankIn(s.players, p)}. ${p.name}`), h('b', {}, p.score))));
  confetti(6000);
}

// ---------- controls ----------
$('#start-btn').addEventListener('click', () => socket.emit('host:start'));
$('#next-btn').addEventListener('click', () => socket.emit('host:next'));
$('#board-next').addEventListener('click', () => socket.emit('host:next'));
$('#again-btn').addEventListener('click', () => socket.emit('host:restart'));
$('#new-btn').addEventListener('click', endGame);
$('#close-btn').addEventListener('click', async () => {
  if (state?.phase === 'final' || await leaveGuard.ask()) endGame();
});

function endGame() {
  socket.emit('host:close');
  store.del(HOST_KEY);
  state = null;
  showSetup();
}

$('#remote-btn').addEventListener('click', () => {
  const { pin, key } = store.get(HOST_KEY) || {};
  $('#remote-qr').src = `/qr.svg?text=${encodeURIComponent(`${joinBase}/host.html?pin=${pin}&key=${key}`)}`;
  $('#remote').showModal();
});

// Presentation clickers send → / PageDown.
document.addEventListener('keydown', e => {
  if (!['ArrowRight', 'PageDown'].includes(e.key) || document.querySelector('dialog[open]')) return;
  const btn = [...document.querySelectorAll('#start-btn, #next-btn, #board-next')].find(b => b.offsetParent && !b.disabled);
  if (btn) { e.preventDefault(); btn.click(); }
});

// ---------- quiz editor ----------
function openEditor(id) {
  const quiz = (id && myQuizzes().find(q => q.id === id)) || { title: '', questions: [{ text: '', options: [], correct: 0 }] };
  editingId = id || null;
  $('#quiz-title').value = quiz.title;
  $('#qlist').replaceChildren(...quiz.questions.map(questionEditor));
  renumber();
  $('#editor-error').textContent = '';
  $('#editor').showModal();
}

function questionEditor(q) {
  const group = `c${Math.random().toString(36).slice(2)}`;
  const box = h('div', { class: 'qedit' },
    h('div', { class: 'qedit-head' },
      h('span', { class: 'qnum' }),
      h('button', { type: 'button', class: 'link', onclick: () => { box.remove(); renumber(); } }, 'Жою')),
    h('textarea', { class: 'input q-text', maxlength: 200, rows: 2, placeholder: 'Сұрақ мәтіні', 'aria-label': 'Сұрақ мәтіні' }, q.text),
    ...[0, 1, 2, 3].map(i => h('div', { class: 'opt' },
      h('input', { type: 'radio', name: group, value: i, checked: q.correct === i, 'aria-label': `${i + 1}-жауап дұрыс` }),
      h('span', { style: `color:var(--a${i});display:flex` }, shape(i)),
      h('input', { class: 'input q-opt', maxlength: 80, value: q.options[i] || '', placeholder: i < 2 ? `${i + 1}-жауап` : `${i + 1}-жауап (міндетті емес)`, 'aria-label': `${i + 1}-жауап` }))),
    h('input', { class: 'input q-fact', maxlength: 300, value: q.fact || '', placeholder: '«Білесің бе?» фактісі (міндетті емес)', 'aria-label': 'Қызықты факт', style: 'margin-top:8px;font-size:15px' }),
    q.source ? h('p', { class: 'hint' }, 'Дереккөз: ', h('a', { href: q.source.url, target: '_blank', rel: 'noopener' }, q.source.title)) : '');
  if (q.source) box.dataset.source = JSON.stringify(q.source);
  return box;
}

function renumber() {
  const boxes = [...$('#qlist').children];
  boxes.forEach((b, i) => { b.querySelector('.qnum').textContent = `${i + 1}-сұрақ`; });
  $('#add-q').disabled = boxes.length >= 50;
}

$('#add-q').addEventListener('click', () => {
  const box = questionEditor({ text: '', options: [], correct: 0 });
  $('#qlist').append(box);
  renumber();
  box.querySelector('textarea').focus();
});

function readEditor() {
  return {
    title: $('#quiz-title').value.trim(),
    questions: [...$('#qlist').children].map(box => {
      const picked = Number(box.querySelector('input[type=radio]:checked')?.value ?? -1);
      const kept = [...box.querySelectorAll('.q-opt')].map((el, i) => ({ text: el.value.trim(), i })).filter(o => o.text);
      return {
        text: box.querySelector('.q-text').value.trim(), options: kept.map(o => o.text), correct: kept.findIndex(o => o.i === picked),
        fact: box.querySelector('.q-fact').value.trim() || undefined,
        source: box.dataset.source ? JSON.parse(box.dataset.source) : undefined,
      };
    }),
  };
}

function checkQuiz(quiz) {
  if (!quiz.title) return 'Квиз атауын жазыңыз';
  if (!quiz.questions.length) return 'Кемінде бір сұрақ қосыңыз';
  for (const [i, q] of quiz.questions.entries()) {
    if (!q.text) return `${i + 1}-сұрақтың мәтінін жазыңыз`;
    if (q.options.length < 2) return `${i + 1}-сұраққа кемінде 2 жауап жазыңыз`;
    if (q.correct < 0) return `${i + 1}-сұрақта дұрыс жауапты белгілеңіз`;
  }
  return '';
}

$('#editor-form').addEventListener('submit', e => {
  if (e.submitter?.value === 'cancel') return; // let the dialog close
  e.preventDefault();
  const quiz = readEditor();
  const err = checkQuiz(quiz);
  if (err) return ($('#editor-error').textContent = err);
  const list = myQuizzes();
  const id = editingId || Date.now().toString(36);
  const i = list.findIndex(q => q.id === id);
  if (i >= 0) list[i] = { id, ...quiz }; else list.push({ id, ...quiz });
  store.set(QUIZZES_KEY, list);
  $('#editor').close();
  renderPacks(`mine:${id}`);
});

async function deleteQuiz(id) {
  const quiz = myQuizzes().find(q => q.id === id);
  if (!quiz || !await confirmBox({ title: 'Квизді жою', text: `«${quiz.title}» квизі осы браузерден біржола жойылады.`, ok: 'Жою', danger: true })) return;
  store.set(QUIZZES_KEY, myQuizzes().filter(q => q.id !== id));
  renderPacks();
}

// ---------- AI generator ----------
let aiDraft = null;
let aiStepTimers = [];

// Works out of the box on keyless free services; a free personal key makes it faster and reliable.
function paintAi() {
  const free = aiProvider === 'free';
  $('#ai-setup').hidden = !(aiShowKey && aiCanSetKey);
  $('#ai-form').hidden = aiShowKey && aiCanSetKey;
  $('#ai-error').textContent = '';
  $('#ai-mode').replaceChildren(
    free ? 'Қазір: тегін кілтсіз режим. Баяу жұмыс істейді (2–4 минут) және кейде уақытша істемей қалуы мүмкін. ' : `ЖИ: ${aiProviderName}. `,
    aiCanSetKey ? h('button', { type: 'button', class: 'link', onclick: () => { aiShowKey = true; paintAi(); $('#ai-key').focus(); } }, free ? 'Өз тегін кілтімді қосу' : 'Кілтті ауыстыру') : '');
}

$('#ai-key-back').addEventListener('click', () => { aiShowKey = false; paintAi(); });

$('#ai-open').addEventListener('click', () => {
  paintAi();
  $('#ai').showModal();
  (aiEnabled ? $('#ai-topic') : $('#ai-key'))?.focus();
});

$('#ai-setup').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#ai-key-save');
  btn.disabled = true;
  btn.textContent = 'Тексерілуде…';
  $('#ai-error').textContent = '';
  try {
    const res = await fetch('/api/ai/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: $('#ai-key').value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Қате');
    $('#ai-key').value = '';
    aiShowKey = false;
    await loadAiStatus();
    paintAi();
    $('#ai-topic').focus();
  } catch (err) {
    $('#ai-error').textContent = err.message === 'Failed to fetch' ? 'Серверге қосылу мүмкін болмады' : err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Қосу';
  }
});

// The server does it in one request; the steps show roughly where it is.
function aiSteps(active) {
  $('#ai-steps').hidden = active < 0;
  [...$('#ai-steps').children].forEach((li, i) => { li.className = i < active ? 'done' : i === active ? 'active' : ''; });
}

$('#ai-form').addEventListener('submit', async e => {
  e.preventDefault();
  const body = { topic: $('#ai-topic').value, count: Number($('#ai-count').value), level: $('#ai-level').value, lang: $('#ai-lang').value };
  $('#ai-go').disabled = true;
  $('#ai-error').textContent = '';
  $('#ai-result').replaceChildren();
  $('#ai-foot').hidden = true;
  aiSteps(0);
  aiStepTimers = [setTimeout(() => aiSteps(1), 3000), setTimeout(() => aiSteps(2), 30000)];
  try {
    const res = await fetch('/api/ai/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({ error: 'Сервер дұрыс жауап бермеді' }));
    if (!res.ok) throw new Error(data.error || 'Қате');
    aiDraft = data;
    aiSteps(3);
    renderAiResult();
  } catch (err) {
    aiSteps(-1);
    $('#ai-error').textContent = err.message === 'Failed to fetch' ? 'Серверге қосылу мүмкін болмады' : err.message;
  } finally {
    aiStepTimers.forEach(clearTimeout);
    $('#ai-go').disabled = false;
  }
});

function renderAiResult() {
  const d = aiDraft;
  $('#ai-result').replaceChildren(
    d.questions.length ? '' : h('p', { class: 'error' }, 'Тексеруден бірде-бір сұрақ өтпеді. Тақырыпты нақтырақ жазып көріңіз.'),
    ...d.questions.map((q, i) => h('div', { class: 'qedit ai-q' },
      h('div', { class: 'qedit-head' },
        h('span', {}, `${i + 1}-сұрақ`),
        h('button', { type: 'button', class: 'link', onclick: () => { d.questions.splice(i, 1); renderAiResult(); } }, 'Алып тастау')),
      h('b', {}, q.text),
      h('ol', { class: 'opts' }, ...q.options.map((o, j) => h('li', { class: j === q.correct ? 'right' : '' }, o))),
      q.fact ? h('p', { class: 'hint' }, q.fact) : '',
      h('details', {},
        h('summary', {}, `Дәлел: ${q.source.title} (${q.source.lang}.wikipedia)`),
        h('blockquote', {}, q.quote),
        h('a', { href: q.source.url, target: '_blank', rel: 'noopener' }, 'Мақаланы ашу')))),
    d.dropped.length
      ? h('details', { class: 'ai-dropped' },
        h('summary', {}, `Тексеруден өтпей алынып тасталған сұрақтар: ${d.dropped.length}`),
        h('ul', {}, ...d.dropped.map(x => h('li', {}, `${x.text || '—'} — ${x.reason}`))))
      : '');
  $('#ai-foot').hidden = !d.questions.length;
  $('#ai-summary').textContent = `${d.questions.length} сұрақ тексеруден өтті`;
}

// Saved as an ordinary "my quiz" and opened in the editor, so the host reads and polishes it before playing.
$('#ai-save').addEventListener('click', () => {
  const quiz = {
    title: aiDraft.topic.slice(0, 60),
    questions: aiDraft.questions.map(({ text, options, correct, fact, source }) => ({ text, options, correct, fact, source: { title: source.title, url: source.url } })),
  };
  const id = Date.now().toString(36);
  store.set(QUIZZES_KEY, [...myQuizzes(), { id, ...quiz }]);
  $('#ai').close();
  renderPacks(`mine:${id}`);
  openEditor(id);
});
