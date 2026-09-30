// Content check + full-game smoke test over real sockets: node test.js
const assert = require('assert');
const { io: connect } = require('socket.io-client');
const { server, rooms, speedPoints } = require('./server');
const PACKS = require('./packs');
const fs = require('fs');
const path = require('path');
const { generateQuiz, verifyQuotes } = require('./ai');

const call = (s, ev, data) => new Promise(r => s.emit(ev, data, r));
const next = (s, ev, pred = () => true) => new Promise(r => {
  const h = v => { if (pred(v)) { s.off(ev, h); r(v); } };
  s.on(ev, h);
});

// Every built-in question must be well-formed, so a typo in packs.js fails here, not in class.
function checkPacks() {
  const ids = new Set();
  for (const p of PACKS) {
    assert.ok(!ids.has(p.id), `duplicate pack id ${p.id}`); ids.add(p.id);
    assert.ok(p.title && p.mode && p.badge && p.description, `${p.id}: missing card fields`);
    if (p.mix) continue;
    assert.ok(p.questions.length >= 5, `${p.id}: too few questions`);
    p.questions.forEach((q, i) => {
      const where = `${p.id}[${i}]`;
      assert.ok(q.text && q.fact, `${where}: text and fact required`);
      const type = q.type || 'choice';
      if (type === 'year') {
        assert.ok(q.min < q.answer && q.answer < q.max && q.tolerance > 0, `${where}: bad year range`);
      } else if (type === 'order') {
        assert.ok(q.items.length >= 3 && new Set(q.items).size === q.items.length, `${where}: bad order items`);
      } else if (type === 'anagram') {
        assert.match(q.answer, /^[А-ЯӘҒҚҢӨҰҮҺІЁ]{3,10}$/u, `${where}: anagram answer must be 3-10 capital Cyrillic letters`);
      } else {
        assert.ok(q.options.length >= 2 && q.options.length <= 4, `${where}: 2-4 options`);
        assert.strictEqual(new Set(q.options).size, q.options.length, `${where}: duplicate options`);
        assert.ok(Number.isInteger(q.correct) && q.options[q.correct], `${where}: bad correct index`);
        if (type === 'clues') assert.ok(q.clues.length >= 3, `${where}: clues`);
      }
      if (q.rune) assert.match(q.rune, /^[\u{10C00}-\u{10C48} ⁚]+$/u, `${where}: rune text has non-runic characters`);
      if (q.quote) assert.ok(q.quote.includes('___'), `${where}: quote needs a ___ gap`);
      if (q.image) {
        assert.ok(fs.existsSync(path.join(__dirname, 'public', q.image.src)), `${where}: missing image ${q.image.src}`);
        assert.ok(q.image.credit && /^https:\/\/commons\.wikimedia\.org\//.test(q.image.url), `${where}: image needs credit + Commons link`);
      }
    });
  }
}

server.listen(0, async () => {
  const url = `http://localhost:${server.address().port}`;
  const sockets = [];
  const client = () => { const s = connect(url, { forceNew: true }); sockets.push(s); return s; };
  const answerAndReveal = async (host, players, answers) => {
    const revealed = next(host, 'host:state', v => v.phase === 'reveal');
    players.forEach((p, i) => p.emit('player:answer', answers[i]));
    return revealed;
  };
  const advanceTo = async (host, phase) => {
    const st = next(host, 'host:state', v => v.phase === phase);
    host.emit('host:next');
    return st;
  };
  try {
    checkPacks();
    assert.strictEqual(speedPoints(0, 20000), 1000);
    assert.strictEqual(speedPoints(20000, 20000), 500);

    // ---------- classic game ----------
    const host = client();
    assert.match((await call(host, 'host:create', { custom: { questions: [{ text: 'x', options: ['a'], correct: 0 }] } })).error, /2–4/);
    const { pin, key } = await call(host, 'host:create', { packId: 'ras-otirik', timeLimit: 10 });
    assert.match(pin, /^\d{6}$/);

    const a = client(), b = client();
    const ja = await call(a, 'player:join', { pin, name: 'Айбек' });
    assert.ok(ja.id);
    assert.match((await call(b, 'player:join', { pin, name: 'айбек' })).error, /есім/);
    assert.match((await call(b, 'player:join', { pin: '000000', name: 'Дана' })).error, /PIN/);
    await call(b, 'player:join', { pin, name: '<img src=x>' }); // stored as text; clients render with textContent

    const thief = client();
    assert.ok((await call(thief, 'host:resume', { pin, key: 'nope' })).error);
    thief.emit('host:start');

    const q1 = next(a, 'player:state', v => v.phase === 'question');
    host.emit('host:start');
    const s1 = await q1;
    assert.strictEqual(s1.question.solution, undefined, 'answer must not leak while open');
    const correct = rooms.get(pin).questions[0].correct;
    const r = await answerAndReveal(host, [a, b], [correct, 1 - correct]); // all answered -> early reveal
    assert.strictEqual(r.counts[correct], 1);
    assert.ok(r.fact);
    const pa = r.players.find(p => p.name === 'Айбек');
    assert.ok(pa.score > 900 && pa.score <= 1000, `fast answer score ${pa.score}`);

    // player refresh: reconnect with saved id keeps the score
    a.disconnect();
    const a2 = client();
    const back = next(a2, 'player:state');
    assert.strictEqual((await call(a2, 'player:join', { pin, id: ja.id })).name, 'Айбек');
    assert.strictEqual((await back).score, pa.score);
    assert.strictEqual((await back).rank, 1);

    const host2 = client();
    assert.ok((await call(host2, 'host:resume', { pin, key })).ok);
    let st = r;
    for (let guard = 0; st.phase !== 'final' && guard < 60; guard++) {
      const nxt = next(host2, 'host:state', v => v.phase !== st.phase || v.q !== st.q);
      host2.emit('host:next');
      st = await nxt;
    }
    assert.strictEqual(st.phase, 'final');
    const reset = next(host, 'host:state', v => v.phase === 'lobby');
    host.emit('host:restart');
    assert.ok((await reset).players.every(p => p.score === 0));
    const closed = next(a2, 'room:closed');
    host.emit('host:close');
    await closed;
    assert.ok(!rooms.has(pin));

    // ---------- year, order and clue games ----------
    const h = client(), x = client(), y = client();
    const g = await call(h, 'host:create', { packId: 'jylnama', timeLimit: 10 });
    await call(x, 'player:join', { pin: g.pin, name: 'X' });
    await call(y, 'player:join', { pin: g.pin, name: 'Y' });
    const yq = next(x, 'player:state', v => v.phase === 'question');
    h.emit('host:start');
    const ys = await yq;
    assert.strictEqual(ys.question.type, 'year');
    assert.strictEqual(ys.timeLimit, 25, 'year questions get at least 25s');
    const ans = rooms.get(g.pin).questions[0].answer;
    x.emit('player:answer', 99999); // out of range: ignored
    const yr = await answerAndReveal(h, [x, y], [ans, ans + 20]);
    assert.strictEqual(yr.solution, ans);
    assert.strictEqual(yr.guesses.length, 2);
    const [px, py] = ['X', 'Y'].map(n => yr.players.find(p => p.name === n));
    assert.strictEqual(px.gained, 1000);
    assert.strictEqual(py.gained, 500); // 20 years off with tolerance 40
    h.emit('host:close');

    const o = await call(h, 'host:create', { packId: 'shezhire', timeLimit: 10 });
    await call(x, 'player:join', { pin: o.pin, name: 'X' });
    await call(y, 'player:join', { pin: o.pin, name: 'Y' });
    const oq = next(x, 'player:state', v => v.phase === 'question');
    h.emit('host:start');
    const os = await oq;
    assert.strictEqual(os.question.type, 'order');
    const room = rooms.get(o.pin);
    assert.ok(room.display.some((v, i) => v !== i), 'order items must be shuffled');
    const perfect = room.display.map((_, pos) => room.display.indexOf(pos)); // shown index for each correct position
    const or = await answerAndReveal(h, [x, y], [perfect, perfect.slice().reverse()]);
    assert.deepStrictEqual(or.solution, current(room).items);
    assert.strictEqual(or.hits, 1);
    assert.ok(or.players.find(p => p.name === 'X').gained >= 500);
    h.emit('host:close');

    const c = await call(h, 'host:create', { packId: 'men-kimmin', timeLimit: 10 });
    await call(x, 'player:join', { pin: c.pin, name: 'X' });
    const cq = next(x, 'player:state', v => v.phase === 'question');
    h.emit('host:start');
    const cs = await cq;
    assert.strictEqual(cs.question.clues.length, 1, 'only the first clue is shown at the start');
    assert.strictEqual(cs.timeLimit, 40);
    h.emit('host:close');

    // anagram with repeated letters: any tile with the right letter is accepted
    const an = await call(h, 'host:create', { packId: 'anagram', timeLimit: 10, golden: false });
    await call(x, 'player:join', { pin: an.pin, name: 'X' });
    await call(y, 'player:join', { pin: an.pin, name: 'Y' });
    const anRoom = rooms.get(an.pin);
    anRoom.questions = [PACKS.find(p => p.id === 'anagram').questions.find(q => q.answer === 'БАЛБАЛ')];
    const aq = next(x, 'player:state', v => v.phase === 'question');
    h.emit('host:start');
    const as = await aq;
    assert.strictEqual(as.question.letters.length, 6);
    assert.notStrictEqual(as.question.letters.join(''), 'БАЛБАЛ', 'letters must be scrambled');
    // spell it picking the LAST unused matching tile each time: a different tile order than the original
    const used = new Set();
    const spell = [...'БАЛБАЛ'].map(ch => { const i = as.question.letters.findLastIndex((l, k) => l === ch && !used.has(k)); used.add(i); return i; });
    const ar = await answerAndReveal(h, [x, y], [spell, [0, 1, 2, 3, 4, 5]]);
    assert.strictEqual(ar.solution, 'БАЛБАЛ');
    assert.ok(ar.players.find(p => p.name === 'X').gained >= 500, 'correct spelling with swapped duplicate letters scores');
    assert.strictEqual(ar.players.find(p => p.name === 'Y').gained, 0, 'scrambled order as-is is wrong');
    h.emit('host:close');

    // golden last question doubles points; teams are balanced and scored by average
    const gd = await call(h, 'host:create', { packId: 'ras-otirik', timeLimit: 10, golden: true, teams: true });
    const t1 = client(), t2 = client(), t3 = client();
    for (const [c2, n] of [[t1, 'T1'], [t2, 'T2'], [t3, 'T3']]) await call(c2, 'player:join', { pin: gd.pin, name: n });
    const gRoom = rooms.get(gd.pin);
    const sizes = [0, 1].map(t => [...gRoom.players.values()].filter(p => p.team === t).length).sort();
    assert.deepStrictEqual(sizes, [1, 2], 'teams must be balanced');
    gRoom.questions = gRoom.questions.slice(0, 2);
    const gq = next(t1, 'player:state', v => v.phase === 'question');
    h.emit('host:start');
    assert.ok(!(await gq).question.golden, 'first question is not golden');
    const c0 = gRoom.questions[0].correct;
    await answerAndReveal(h, [t1, t2, t3], [c0, 1 - c0, 1 - c0]);
    await advanceTo(h, 'leaderboard');
    const g2 = next(t1, 'player:state', v => v.phase === 'question' && v.q === 1);
    h.emit('host:next');
    assert.ok((await g2).question.golden, 'last question is golden');
    const c1 = gRoom.questions[1].correct;
    const gr = await answerAndReveal(h, [t1, t2, t3], [1 - c1, c1, 1 - c1]);
    const gT2 = gr.players.find(p => p.name === 'T2');
    assert.ok(gT2.gained >= 1000 && gT2.score === gT2.gained, `golden doubles points (got ${gT2.gained})`);
    assert.strictEqual(gr.teams.length, 2);
    for (const [i, team] of gr.teams.entries()) {
      const members = gr.players.filter(p => p.team === i);
      assert.strictEqual(team.score, Math.round(members.reduce((n, p) => n + p.score, 0) / members.length), 'team score = average');
    }
    h.emit('host:close');

    // custom quiz sources must be Wikipedia https links
    const bad = { title: 't', questions: [{ text: 'q', options: ['a', 'b'], correct: 0, source: { title: 'x', url: 'javascript:alert(1)' } }] };
    assert.match((await call(h, 'host:create', { custom: bad })).error, /дереккөзі/);
    const good = { title: 't', questions: [{ text: 'q', options: ['a', 'b'], correct: 0, fact: 'f', source: { title: 'x', url: 'https://kk.wikipedia.org/wiki/X' } }] };
    const okRoom = await call(h, 'host:create', { custom: good });
    assert.strictEqual(rooms.get(okRoom.pin).questions[0].source.url, 'https://kk.wikipedia.org/wiki/X');
    h.emit('host:close');

    // ---------- 3 teams, avatars, power-ups, report, awards ----------
    const tg = await call(h, 'host:create', { packId: 'negizder', timeLimit: 10, teams: 3, golden: false });
    const five = [client(), client(), client(), client(), client()];
    for (const [i, c2] of five.entries()) await call(c2, 'player:join', { pin: tg.pin, name: `P${i}`, avatar: i === 0 ? '🦉' : 'not-an-avatar' });
    const tRoom = rooms.get(tg.pin);
    const tSizes = [0, 1, 2].map(t => [...tRoom.players.values()].filter(p => p.team === t).length).sort();
    assert.deepStrictEqual(tSizes, [1, 2, 2], '5 players over 3 teams');
    const avatars = [...tRoom.players.values()].map(p => p.avatar);
    assert.strictEqual(avatars[0], '🦉');
    assert.ok(avatars.every(a => ['🐺', '🦅', '🐎', '🐆', '🦌', '🐫', '🦉', '🐻'].includes(a)), 'unknown avatar replaced by a valid one');
    h.emit('host:close');

    const pg = await call(h, 'host:create', { packId: 'negizder', timeLimit: 10, golden: false });
    const pA = client(), pB = client();
    const ja2 = await call(pA, 'player:join', { pin: pg.pin, name: 'A' });
    await call(pB, 'player:join', { pin: pg.pin, name: 'B' });
    const pRoom = rooms.get(pg.pin);
    const me = pRoom.players.get(ja2.id);
    const cur = () => pRoom.questions[pRoom.q].correct;
    const nextQ = async () => { await advanceTo(h, 'leaderboard'); const st = next(pA, 'player:state', v => v.phase === 'question'); h.emit('host:next'); return st; };

    let qa = next(pA, 'player:state', v => v.phase === 'question');
    h.emit('host:start'); await qa;
    await answerAndReveal(h, [pA, pB], [cur(), (cur() + 1) % 4]);
    assert.strictEqual(me.powers.length, 0, 'no power after 1 correct');
    await nextQ();
    const earned = next(pA, 'player:state', v => v.phase === 'reveal');
    await answerAndReveal(h, [pA, pB], [cur(), (cur() + 1) % 4]);
    const er = await earned;
    assert.strictEqual(me.streak, 2);
    assert.ok(['shield', 'fifty', 'double'].includes(er.newPower) && er.powers.length === 1, 'a power-up is earned at a streak of 2');

    // 50/50 hides two WRONG options, one power per question
    me.powers = ['fifty', 'double'];
    await nextQ();
    const hid = next(pA, 'player:state', v => v.phase === 'question' && v.active === 'fifty');
    pA.emit('player:power', 'fifty');
    const hs = await hid;
    assert.strictEqual(hs.hidden.length, 2);
    assert.ok(!hs.hidden.includes(cur()), '50/50 never hides the correct answer');
    pA.emit('player:power', 'double');
    await new Promise(r => setTimeout(r, 150));
    assert.deepStrictEqual(me.powers, ['double'], 'only one power per question');
    await answerAndReveal(h, [pA, pB], [cur(), (cur() + 1) % 4]);

    // double points
    await nextQ();
    pA.emit('player:power', 'double');
    const dr = await answerAndReveal(h, [pA, pB], [cur(), (cur() + 1) % 4]);
    assert.ok(dr.players.find(p => p.name === 'A').gained >= 2000, 'double points');
    assert.strictEqual(dr.players.find(p => p.name === 'A').power, 'double', 'host sees the power used');

    // shield keeps the streak on a wrong answer
    me.powers = ['shield'];
    const before = me.streak;
    await nextQ();
    pA.emit('player:power', 'shield');
    const sh = next(pA, 'player:state', v => v.phase === 'reveal');
    await answerAndReveal(h, [pA, pB], [(cur() + 1) % 4, cur()]);
    assert.strictEqual(me.streak, before, 'shield kept the streak');
    assert.strictEqual((await sh).shielded, true);

    // play to the end: report + awards
    let fin;
    for (let guard = 0; guard < 40; guard++) {
      const nx = next(h, 'host:state', v => v.phase !== 'question');
      h.emit('host:next');
      const st2 = await nx;
      if (st2.phase === 'final') { fin = st2; break; }
    }
    assert.ok(fin?.report, 'final state carries the report');
    const rq = fin.report.questions;
    assert.strictEqual(rq.length, pRoom.questions.length);
    assert.ok(rq.every((x, i) => i === 0 || rq[i - 1].pct <= x.pct), 'hardest questions first');
    assert.ok(rq.some(x => x.quiz && x.quiz.options.length === 4), 'plain questions can be re-used as a quiz');
    const rowA = fin.report.results.find(r => r.name === 'A');
    assert.strictEqual(rowA.answers.length, pRoom.questions.length);
    assert.strictEqual(rowA.correct, rowA.answers.filter(x => x === 1).length);
    assert.ok(fin.report.awards.some(a => a.icon === '🔥' && a.name === 'A'), 'longest streak award');
    h.emit('host:close');

    // ---------- AI pipeline with a fake LLM that lies ----------
    const SRC = [{ id: 'S1', lang: 'kk', title: 'Абылай хан', url: 'https://kk.wikipedia.org/wiki/Абылай_хан', text: 'Абылай хан 1711 жылы туған. Ол 1771 жылы Түркістанда хан болып сайланды. Абылай хан 1781 жылы қайтыс болды.' }];
    const draft = { questions: [
      { text: 'Абылай хан қай жылы туған?', options: ['1711', '1725', '1693', '1740'], correct: 0, fact: 'f', source: 'S1', quote: 'Абылай хан 1711 жылы туған.' },
      { text: 'Абылай хан қай жылы хан болды?', options: ['1771', '1760'], correct: 0, fact: 'f', source: 'S1', quote: 'Ол 1771 жылы Түркістанда хан болып сайланды.' },
      { text: 'Абылай хан атасы қайтқан соң қай жылы хан болды?', options: ['1771', '1765'], correct: 0, fact: 'f', source: 'S1', quote: 'Ол 1771 жылы Түркістанда хан болып сайланды.' }, // right answer, wrong detail in the question
      { text: 'Абылай ханның лақабы?', options: ['Сұлтан', 'Батыр'], correct: 0, fact: 'f', source: 'S1', quote: 'Абылай хан Сұлтан деп аталған.' }, // invented quote
      { text: 'Абылай хан қай жылы қайтыс болды?', options: ['1781', '1790'], correct: 1, fact: 'f', source: 'S1', quote: 'Абылай хан 1781 жылы қайтыс болды.' }, // wrong answer key
      { text: 'Бос', options: ['a', 'a'], correct: 0, source: 'S1', quote: 'Абылай хан 1711 жылы туған.' }, // duplicate options
    ] };
    let writerCalls = 0;
    const fakeChat = async messages => {
      if (!messages[0].content.includes('fact-checker')) return writerCalls++ === 0 ? draft : { questions: [] };
      const items = JSON.parse(messages[1].content);
      assert.ok(items.every(it => !('correct' in it)), 'checker must not see the marked answer');
      // honest checker; it also flags a question whose own wording contradicts the quote
      return { results: items.map(it => ({ id: it.id, answer: it.options.findIndex(o => it.quote.includes(o)), unambiguous: true, question_supported: !it.question.includes('атасы'), issue: '' })) };
    };
    const out = await generateQuiz({ topic: 'Абылай хан', count: 5 }, { chat: fakeChat, findSources: async () => SRC });
    assert.deepStrictEqual(out.questions.map(q => q.text), ['Абылай хан қай жылы туған?', 'Абылай хан қай жылы хан болды?']);
    assert.ok(out.dropped.some(d => /мақалада жоқ/.test(d.reason)), 'invented quote is dropped');
    assert.ok(out.dropped.some(d => /басқа жауап/.test(d.reason)), 'wrong answer key is dropped by the checker');
    assert.ok(out.dropped.some(d => /қайталанады/.test(d.reason)), 'duplicate options are dropped');
    assert.ok(out.dropped.some(d => /сұрақтың өз мәтінінде/.test(d.reason)), 'a wrong detail in the question text is dropped');
    assert.strictEqual(out.questions[0].source.url, SRC[0].url);
    // quote matching tolerates formatting only: trailing punctuation and "..." over a short skipped span
    const { quoteInSource, normalize } = require('./ai');
    const art = normalize('Kul Tigin (Old Turkic: kül tigin; 684 – 731) was a general and a prince of the Second Turkic Khaganate, and a son of Ilterish.');
    assert.ok(quoteInSource('Kul Tigin ... was a general and a prince of the Second Turkic Khaganate.', art), 'ellipsis over a short parenthetical');
    assert.ok(quoteInSource('was a general and a prince of the Second Turkic Khaganate.', art), 'trailing full stop where the sentence continues');
    assert.ok(!quoteInSource('Kul Tigin ... was a famous poet of the Second Turkic Khaganate.', art), 'invented fragment rejected');
    assert.ok(!quoteInSource('Kul Tigin ... a son of Ilterish.', normalize('Kul Tigin' + ' x'.repeat(100) + ' a son of Ilterish.')), 'long skipped span rejected');
    assert.ok(!quoteInSource('a son ... Ilterish', art), 'tiny fragments rejected');
    // quote matching tolerates case, spacing and quote-mark differences
    assert.strictEqual(verifyQuotes([{ text: 't', options: ['a', 'b'], correct: 0, source: 'S1', quote: '  абылай ХАН «1711»   жылы туған. ' }], SRC).kept.length, 1);

    // mix game draws from several packs
    const m = await call(h, 'host:create', { packId: 'aralas', timeLimit: 20 });
    const types = new Set(rooms.get(m.pin).questions.map(q => q.type || 'choice'));
    assert.strictEqual(rooms.get(m.pin).questions.length, 12);
    assert.ok(types.size >= 2, 'mix should contain several game types');
    h.emit('host:close');

    console.log(`✓ all checks passed (${PACKS.reduce((n, p) => n + (p.questions?.length || 0), 0)} questions in ${PACKS.length} games)`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    sockets.forEach(s => s.disconnect());
    server.close();
    setTimeout(() => process.exit(), 100);
  }
});

const current = room => room.questions[room.q];
