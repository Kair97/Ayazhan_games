const SESSION_KEY = 'bayge.player';
const NAME_KEY = 'bayge.name';
const AVATAR_KEY = 'bayge.avatar';

// Avatar picker: remembered between games.
let myAvatar = AVATARS.includes(store.get(AVATAR_KEY)) ? store.get(AVATAR_KEY) : AVATARS[Math.floor(Math.random() * AVATARS.length)];
$('#avatars').replaceChildren(...AVATARS.map(a => h('button', {
  type: 'button', class: 'avatar', role: 'radio', 'aria-label': a, 'aria-checked': String(a === myAvatar),
  onclick: e => { myAvatar = a; store.set(AVATAR_KEY, a); [...$('#avatars').children].forEach(b => b.setAttribute('aria-checked', String(b === e.currentTarget))); },
}, a)));

let state = null;
$('#sound-slot').append(soundToggle());

leaveGuard = {
  active: () => !!state && state.phase !== 'final',
  ask: () => confirmBox({
    title: 'Ойыннан шығасың ба?',
    text: 'Шықсаң, осы ойындағы ұпайларың жойылады.',
    ok: 'Шығу', cancel: 'Ойынға оралу', danger: true,
  }),
  leave: () => { store.del(SESSION_KEY); state = null; return emitAck('player:leave'); },
};
if (!store.get(SESSION_KEY)) addEventListener('DOMContentLoaded', () => state || showJoin());

const urlPin = new URLSearchParams(location.search).get('pin');
$('#pin-input').value = urlPin || '';
$('#name-input').value = store.get(NAME_KEY) || '';

function showJoin(message = '') {
  state = null;
  stopCountdown();
  $('#me').hidden = true;
  $('#join-error').textContent = message;
  show('join');
  ($('#pin-input').value ? $('#name-input') : $('#pin-input')).focus();
}

// On every (re)connect, resume the saved seat so a refresh or a dropped connection keeps the score.
function resume() {
  const session = store.get(SESSION_KEY);
  const sameGame = session && (!urlPin || urlPin === session.pin);
  if (!sameGame) return state || showJoin();
  socket.emit('player:join', session, r => {
    if (r?.error) { store.del(SESSION_KEY); showJoin(); }
  });
}
socket.on('connect', resume);
// A locked phone screen can freeze the tab; when it comes back, fetch the current state instead of trusting a stale screen.
document.addEventListener('visibilitychange', () => { if (!document.hidden && socket.connected) resume(); });

$('#join-form').addEventListener('submit', e => {
  e.preventDefault();
  const pin = $('#pin-input').value.replace(/\D/g, '');
  const name = $('#name-input').value.trim();
  const btn = $('#join-btn');
  btn.disabled = true;
  $('#join-error').textContent = '';
  socket.timeout(8000).emit('player:join', { pin, name, avatar: myAvatar }, (err, r) => {
    btn.disabled = false;
    if (err) return ($('#join-error').textContent = 'Серверге қосылу мүмкін болмады. Интернетті тексер.');
    if (r.error) return ($('#join-error').textContent = r.error);
    store.set(SESSION_KEY, { pin: r.pin, id: r.id });
    store.set(NAME_KEY, r.name);
  });
});

socket.on('player:state', s => {
  const prev = state;
  state = s;
  syncBackTrap();
  $('#me').hidden = false;
  $('#me').textContent = `${s.avatar || ''} ${s.name} · ${s.score}${s.team ? ` · ${s.team.icon}` : ''}`;
  const fresh = !prev || prev.phase !== s.phase || prev.q !== s.q;

  if (s.phase === 'lobby') {
    if (!prev) Sound.sfx('join');
    show('wait');
    $('#wait-name').textContent = s.name;
    $('#wait-info').textContent = `${s.title} · ${s.playerCount} ойыншы`;
    $('#wait-team').hidden = !s.team;
    if (s.team) $('#wait-team').textContent = `Сенің командаң: ${s.team.icon} ${s.team.name}`;
  } else if (s.phase === 'question') {
    if (s.answer === null) renderAsk(s, fresh); else renderSent(s.answer, s.question);
  } else if (s.phase === 'reveal') {
    if (fresh) renderResult(s);
  } else if (s.phase === 'leaderboard') {
    show('standing');
    $('#standing-place').textContent = `${s.rank}`;
    $('#standing-info').textContent = `${s.playerCount} ойыншының ішінде · ${s.score} ұпай`;
  } else if (s.phase === 'final' && fresh) {
    show('final');
    $('#final-place').textContent = s.rank <= 3 ? ['🥇', '🥈', '🥉'][s.rank - 1] : `${s.rank}`;
    $('#final-title').textContent = s.rank === 1 ? 'Сен — бәйгенің жүйрігі!' : `${s.rank}-орын`;
    let teamLine = '';
    if (s.team && s.teams) {
      const mine = s.teams.find(t => t.name === s.team.name);
      const place = 1 + s.teams.filter(t => t.score > mine.score).length;
      const tied = s.teams.filter(t => t.score === mine.score).length > 1;
      teamLine = place === 1 ? (tied ? ' · командаң бірінші орынды бөлісті' : ' · командаң жеңді! 🎉') : ` · командаң ${place}-орында`;
    }
    $('#final-info').textContent = `${s.score} ұпай · ${s.playerCount} ойыншы${teamLine}`;
    $('#final-awards').replaceChildren(...(s.awards || []).map(a => h('span', { class: 'pill' }, `${a.icon} ${a.title} · ${a.value}`)));
    if (s.rank <= 3) { confetti(5000); buzz([80, 60, 80, 60, 200]); }
  }
});

let seenClues = 0;

function renderAsk(s, fresh) {
  show('ask');
  const q = s.question;
  const rebuild = fresh || !$('#pad').children.length;
  if (rebuild) {
    seenClues = 0;
    if (q.golden) Sound.sfx('golden');
    $('#qcount').textContent = `${s.q + 1} / ${s.total}`;
    $('#qtext').textContent = q.text;
    $('#pad').replaceChildren(...answerPad(q));
    countdown($('#timer'), s.remaining, s.timeLimit * 1000);
  }
  paintPowers(s);
  if (rebuild || (q.clues?.length || 0) !== seenClues) {
    $('#qextra').replaceChildren(...extras(q, null, seenClues));
    if (!rebuild) buzz(30); // a new clue opened
    seenClues = q.clues?.length || 0;
  }
}

// Power-ups in hand; one per question, used before answering.
function paintPowers(s) {
  const bar = $('#powerbar');
  const active = s.active && POWER_INFO[s.active];
  bar.replaceChildren(
    active ? h('span', { class: 'power on' }, `${active.icon} ${active.name} қосулы`) : '',
    ...(active ? [] : (s.powers || []).map(type => {
      const info = POWER_INFO[type];
      const blocked = type === 'fifty' && !s.canFifty;
      return h('button', {
        type: 'button', class: 'power', disabled: blocked, title: blocked ? 'Бұл сұраққа келмейді' : info.hint,
        onclick: () => { Sound.sfx('golden'); socket.emit('player:power', type); },
      }, `${info.icon} ${info.name}`);
    })));
  bar.hidden = !bar.children.length;
  // 50/50: hide the removed options
  document.querySelectorAll('#pad .tiles > .tile').forEach((t, i) => {
    const gone = (s.hidden || []).includes(i);
    t.classList.toggle('gone', gone);
    t.disabled = gone;
  });
}

function answerPad(q) {
  if (q.type === 'year') return [yearPad(q)];
  if (q.type === 'order') return orderPad(q);
  if (q.type === 'anagram') return anagramPad(q);
  return [h('div', { class: 'tiles' }, ...q.options.map((o, i) =>
    h('button', { class: `tile t${i}`, 'aria-label': `${SHAPE_NAMES[i]}: ${o}`, onclick: () => answer(i) }, shape(i), h('span', { class: 'label' }, o))))];
}

function yearPad(q) {
  const start = Math.round((q.min + q.max) / 2);
  const out = h('input', { class: 'year-out', type: 'number', inputmode: 'numeric', min: q.min, max: q.max, value: start, 'aria-label': 'Жыл' });
  const range = h('input', { type: 'range', min: q.min, max: q.max, step: 1, value: start, 'aria-label': 'Жылды таңдау' });
  const set = v => { v = Math.max(q.min, Math.min(q.max, Math.round(v))); out.value = v; range.value = v; };
  range.addEventListener('input', () => { out.value = range.value; });
  out.addEventListener('input', () => { if (out.value >= q.min && out.value <= q.max) range.value = out.value; });
  out.addEventListener('change', () => set(Number(out.value) || start));
  const step = d => h('button', { type: 'button', onclick: () => { set(Number(out.value) + d); buzz(10); } }, d > 0 ? `+${d}` : `−${-d}`);
  return h('div', { class: 'yearpad' },
    out, range,
    h('div', { class: 'steps' }, step(-10), step(-1), step(1), step(10)),
    h('button', { class: 'btn btn-block btn-lg', onclick: () => { set(Number(out.value) || start); answer(Number(out.value)); } }, 'Жіберу'));
}

// Tap the events from earliest to latest; tapping a numbered one takes it back out.
function orderPad(q) {
  const seq = [];
  const submit = h('button', { class: 'btn btn-block btn-lg', disabled: true, onclick: () => answer(seq.slice()) }, 'Жіберу');
  const tiles = q.items.map((t, i) => h('button', { class: `tile t${i}`, onclick: () => toggle(i) }, shape(i), h('span', { class: 'label' }, t), h('span', { class: 'seq' })));
  function toggle(i) {
    const k = seq.indexOf(i);
    if (k >= 0) seq.splice(k, 1); else seq.push(i);
    tiles.forEach((b, j) => { b.querySelector('.seq').textContent = seq.includes(j) ? seq.indexOf(j) + 1 : ''; });
    submit.disabled = seq.length !== q.items.length;
    buzz(15);
  }
  return [
    h('p', { class: 'pad-hint muted' }, 'Ең ертесінен бастап ретімен бас. Қателессең, қайта бас.'),
    h('div', { class: 'tiles orderpad' }, tiles),
    h('div', { class: 'pad-actions' }, submit),
  ];
}

// Tap letters to spell the word; tap a placed letter to take it back.
function anagramPad(q) {
  const picked = [];
  const slots = h('div', { class: 'slots', 'aria-live': 'polite' });
  const submit = h('button', { class: 'btn btn-lg', disabled: true, onclick: () => answer(picked.slice()) }, 'Жіберу');
  const keys = q.letters.map((l, i) => h('button', { class: 'letter', type: 'button', 'aria-label': l, onclick: () => { if (!picked.includes(i)) { picked.push(i); paint(); } } }, l));
  function paint() {
    slots.replaceChildren(...picked.map((i, k) => h('button', { class: 'letter', type: 'button', 'aria-label': `${q.letters[i]} алып тастау`, onclick: () => { picked.splice(k, 1); paint(); } }, q.letters[i])));
    keys.forEach((b, i) => b.classList.toggle('used', picked.includes(i)));
    submit.disabled = picked.length !== q.letters.length;
    buzz(12);
  }
  const clear = h('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: () => { picked.length = 0; paint(); } }, 'Тазалау');
  return [slots, h('div', { class: 'letters' }, keys), h('div', { class: 'pad-row' }, clear, submit)];
}

function answer(a) {
  if (!state || state.phase !== 'question' || state.answer !== null) return;
  state.answer = a;
  buzz(40);
  Sound.sfx('tap');
  socket.emit('player:answer', a);
  renderSent(a, state.question);
}

function renderSent(a, q) {
  stopCountdown();
  show('sent');
  let mark;
  if (q.type === 'year') mark = h('div', { class: 'sent-mark' }, a);
  else if (q.type === 'order') mark = h('div', { class: 'big-emoji' }, '📜');
  else if (q.type === 'anagram') mark = h('div', { class: 'sent-mark' }, a.map(i => q.letters[i]).join(''));
  else mark = h('div', { class: `tile t${a}`, style: 'width:96px;height:96px;min-height:0;justify-content:center;padding:0' }, shape(a));
  $('#sent-mark').replaceChildren(mark);
}

function renderResult(s) {
  stopCountdown();
  show('result');
  const q = s.question;
  const none = s.answer === null;
  const tone = s.hit ? 'ok' : s.gained > 0 ? 'mid' : 'bad';
  let title, note;
  if (none) title = 'Уақыт бітті';
  else if (q.type === 'year') title = s.hit ? 'Дәл таптың!' : s.gained > 0 ? 'Жақын!' : 'Алыс кеттің';
  else if (q.type === 'order') title = s.hit ? 'Бәрі дұрыс!' : `${s.right} / ${q.items.length} орнында`;
  else if (q.type === 'anagram') title = s.hit ? 'Сөзді таптың!' : 'Қате';
  else title = s.hit ? 'Дұрыс!' : 'Қате';

  if (q.type === 'year') note = [`Дұрыс жауап: ${s.solution}`, none ? '' : ` · сенікі: ${s.answer} (${s.diff} жыл айырмашылық)`];
  else if (q.type === 'order') note = s.hit ? ['Тарих ретін жақсы білесің'] : [h('ol', { class: 'mini-order' }, ...s.solution.map(t => h('li', {}, t)))];
  else if (q.type === 'anagram') note = [`Дұрыс сөз: ${s.solution}`];
  else note = [s.hit ? (s.streak >= 2 ? `Қатарынан ${s.streak} дұрыс жауап!` : 'Жарайсың, солай жалғастыр') : `Дұрыс жауап: ${q.options[s.solution]}`];

  $('#result-box').className = `result result-${tone}`;
  $('#result-icon').textContent = none ? '⏳' : s.hit ? (s.streak >= 3 ? '🔥' : '🏹') : tone === 'mid' ? '🎯' : '🛡️';
  $('#result-title').textContent = title;
  $('#result-gain').textContent = `+${s.gained}`;
  $('#result-note').replaceChildren(...note);
  $('#result-rank').textContent = `${s.rank}-орын · ${s.score} ұпай`;
  $('#result-fact').replaceChildren(factBox(s.fact, s.source));
  $('#result-extra').replaceChildren(
    s.shielded ? h('span', { class: 'pill' }, '🛡️ Қалқан серияңды сақтап қалды') : '',
    s.newPower ? h('span', { class: 'pill power-new' }, `Жаңа күш: ${POWER_INFO[s.newPower].icon} ${POWER_INFO[s.newPower].name}!`) : '');
  if (s.newPower) setTimeout(() => Sound.sfx('golden'), 600);
  buzz(s.hit ? [60, 40, 60] : 250);
  Sound.sfx(s.hit ? 'correct' : 'wrong');
}

socket.on('player:kicked', () => { store.del(SESSION_KEY); showJoin('Жүргізуші сені ойыннан шығарды'); });
socket.on('room:closed', () => { store.del(SESSION_KEY); showJoin('Ойын жабылды. Жаңа PIN-код енгіз.'); $('#pin-input').value = ''; });

function leave() {
  socket.emit('player:leave');
  store.del(SESSION_KEY);
  $('#pin-input').value = '';
  history.replaceState(null, '', location.pathname);
  showJoin();
}
$('#leave-btn').addEventListener('click', leave);
$('#again-btn').addEventListener('click', leave);
