// AI quiz generator, grounded in Wikipedia. Pipeline:
//   1. find source articles (kk/ru/en Wikipedia) for the topic
//   2. LLM writes questions, each with a VERBATIM quote from a source
//   3. code checks every quote really is in the source text (no quote, no question)
//   4. a second, blind LLM pass answers each question from its quote alone; disagreement drops the question
//   5. the host reviews and edits the survivors before anything is played
// Any OpenAI-compatible chat endpoint works (Gemini by default, Groq, OpenRouter...).

const UA = 'BaigeQuiz/1.0 (classroom quiz generator; https://github.com/Kair97/Ayazhan_games)';
const LANGS = ['kk', 'ru', 'en'];

// The provider is recognised from the key, so a host only ever pastes a key.
// sourceChars = article text per language sent to the model; Groq's free tier allows ~8k tokens/minute.
const PROVIDERS = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', sourceChars: 14000 },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', sourceChars: 3500 },
};
const providerOf = key => (key.startsWith('gsk_') ? 'groq' : 'gemini');

function config() {
  const key = process.env.AI_API_KEY || '';
  const preset = PROVIDERS[providerOf(key)];
  const custom = !!process.env.AI_BASE_URL;
  return {
    key,
    provider: custom ? 'custom' : providerOf(key),
    baseUrl: (process.env.AI_BASE_URL || preset.baseUrl).replace(/\/$/, ''),
    model: process.env.AI_MODEL || preset.model,
    sourceChars: Number(process.env.AI_SOURCE_CHARS) || (custom ? 8000 : preset.sourceChars),
  };
}

// Turns low-level network failures into something a teacher can act on.
function networkError(err) {
  const code = err?.cause?.code || err?.code || '';
  if (err?.name === 'TimeoutError') return new Error('ИИ сервисі тым ұзақ жауап бермеді. Кейінірек қайталаңыз.');
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR/.test(code) || err instanceof TypeError) {
    return new Error('ИИ сервисіне қосылу мүмкін болмады. Бұл Wi-Fi желісі оны бұғаттауы мүмкін: басқа желіге (мысалы, телефонның хотспотына) қосылып көріңіз.');
  }
  return err;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- text helpers ----------
// Loose normalisation for quote matching: case, whitespace, quote marks, dashes, soft hyphens, footnote marks.
function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFC')
    .replace(/­/g, '')
    .replace(/\[\d+\]/g, '')
    .replace(/[«»„“”"'‘’`]/g, '')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Wikipedia ----------
async function wikiApi(lang, params, fetchImpl) {
  const url = `https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Wikipedia ${lang}: HTTP ${res.status}`);
  return res.json();
}

async function articleText(lang, title, fetchImpl) {
  const data = await wikiApi(lang, { action: 'query', prop: 'extracts', explaintext: '1', redirects: '1', titles: title }, fetchImpl);
  const page = data.query?.pages?.[0];
  if (!page || page.missing || !page.extract) return null;
  const text = page.extract.replace(/\n{2,}/g, '\n').replace(/\n=+[^=\n]*(Әдебиет|Сілтемелер|Дереккөздер|Литература|Ссылки|Примечания|References|External links|See also|Notes)[^=\n]*=+[\s\S]*$/i, '');
  return { lang, title: page.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`, text: text.slice(0, config().sourceChars) };
}

// Best article per language: search Kazakh first, follow its interlanguage links, fall back to searching each wiki.
async function findSources(topic, fetchImpl = fetch) {
  const titles = {};
  for (const lang of LANGS) {
    if (titles[lang]) continue;
    const found = await wikiApi(lang, { action: 'query', list: 'search', srsearch: topic, srlimit: '1', srnamespace: '0' }, fetchImpl).catch(() => null);
    const title = found?.query?.search?.[0]?.title;
    if (!title) continue;
    titles[lang] = title;
    const links = await wikiApi(lang, { action: 'query', prop: 'langlinks', titles: title, lllimit: '50' }, fetchImpl).catch(() => null);
    for (const l of links?.query?.pages?.[0]?.langlinks || []) if (LANGS.includes(l.lang) && !titles[l.lang]) titles[l.lang] = l.title;
  }
  const articles = await Promise.all(Object.entries(titles).map(([lang, title]) => articleText(lang, title, fetchImpl).catch(() => null)));
  return articles.filter(a => a && a.text.length > 400).map((a, i) => ({ id: `S${i + 1}`, ...a }));
}

// ---------- LLM ----------
async function chat(messages, fetchImpl = fetch) {
  const { key, baseUrl, model } = config();
  if (!key) throw new Error('ИИ қосылмаған: ✨ терезесінде API кілтін қосыңыз');
  let res;
  // A per-minute limit is normal on free tiers: wait for it once instead of failing.
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature: 0.2, response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(120000),
      });
    } catch (err) {
      throw networkError(err);
    }
    if (res.status !== 429 || attempt >= 1) break;
    const wait = Math.min(60, Number(res.headers.get('retry-after')) || 20);
    await sleep(wait * 1000);
  }
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 429) throw new Error('ИИ-дің тегін лимиті уақытша бітті. Бір-екі минуттан кейін қайталаңыз.');
    if (res.status === 413) throw new Error('Мақалалар тым ұзын болды. Тақырыпты нақтырақ жазыңыз.');
    if (res.status === 401 || res.status === 403) throw new Error('ИИ кілті қабылданбады. ✨ терезесінде кілтті қайта қосыңыз.');
    throw new Error(`ИИ сервисінің қатесі (${res.status}). Кейінірек қайталаңыз.`);
  }
  const content = JSON.parse(body).choices?.[0]?.message?.content || '';
  const json = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

const LANG_NAME = { kk: 'Kazakh (Cyrillic script)', ru: 'Russian' };
const LEVEL = {
  easy: 'easy: well-known key facts a school student should know',
  medium: 'medium: important facts that need careful reading',
  hard: 'hard: precise details (names, numbers, places) that are still clearly stated',
};

function writerPrompt({ topic, count, lang, level }, sources) {
  const src = sources.map(s => `### ${s.id} (${s.lang}) ${s.title}\n${s.text}`).join('\n\n');
  return [
    {
      role: 'system',
      content: `You write quiz questions for a school history/culture game. Accuracy is the top priority.
RULES:
- Use ONLY facts explicitly stated in the SOURCES. Never use outside knowledge, never guess, never combine facts into new claims.
- For every question copy one short supporting sentence from the source VERBATIM into "quote" (exact characters, no paraphrase, no ellipsis, 30-300 characters). It must state the answer directly.
- "source" is the source id (S1, S2...).
- Each question has exactly one correct option. Wrong options must be plausible but clearly wrong according to the sources (same category: names vs names, years vs years).
- No "all of the above", no "none of the above", no negative questions ("which is NOT"), no opinions, no questions about the article itself.
- Avoid facts the sources mark as disputed, uncertain or "according to legend", unless the question says so.
- Mix question kinds: mostly 4 options; about a quarter true/false with options exactly ["Рас","Өтірік"] (Kazakh) or ["Верно","Неверно"] (Russian).
- Write "text", "options" and "fact" in ${LANG_NAME[lang]}. "quote" stays in the source language.
- "fact": one interesting sentence (max 200 chars) explaining the answer, based on the sources.
- Difficulty: ${LEVEL[level]}.
- Every question must be about a different fact.
Return JSON: {"questions":[{"text":"","options":["",""],"correct":0,"fact":"","source":"S1","quote":""}]}`,
    },
    { role: 'user', content: `TOPIC: ${topic}\nWrite ${Math.ceil(count * 1.6)} questions.\n\nSOURCES:\n${src}` },
  ];
}

// The checker never sees which option was marked correct: it must reach the same answer from the quote.
function checkerPrompt(items) {
  return [
    {
      role: 'system',
      content: `You are a strict fact-checker for a school quiz. For each item you get a QUOTE from an encyclopedia, a QUESTION and OPTIONS.
Using ONLY the quote (and general knowledge only to judge ambiguity), answer:
- "answer": index of the option the quote proves correct, or -1 if the quote does not prove any option.
- "unambiguous": true only if exactly one option can be correct and the question is clear to a student.
- "issue": short reason when answer is -1 or unambiguous is false, else "".
Return JSON: {"results":[{"id":0,"answer":0,"unambiguous":true,"issue":""}]}`,
    },
    { role: 'user', content: JSON.stringify(items.map((q, id) => ({ id, quote: q.quote, question: q.text, options: q.options }))) },
  ];
}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Structure + verbatim-quote check. Returns { kept, dropped:[{text, reason}] }.
function verifyQuotes(questions, sources) {
  const byId = Object.fromEntries(sources.map(s => [s.id, { ...s, norm: normalize(s.text) }]));
  const kept = [], dropped = [], seen = new Set();
  for (const raw of Array.isArray(questions) ? questions : []) {
    const q = {
      text: clean(raw?.text, 200),
      options: Array.isArray(raw?.options) ? raw.options.map(o => clean(o, 80)) : [],
      correct: raw?.correct,
      fact: clean(raw?.fact, 300),
      quote: clean(raw?.quote, 400),
      source: byId[raw?.source],
    };
    const why =
      !q.text ? 'сұрақ мәтіні жоқ' :
      q.options.length < 2 || q.options.length > 4 || q.options.some(o => !o) ? '2–4 жауап нұсқасы керек' :
      new Set(q.options.map(o => o.toLowerCase())).size !== q.options.length ? 'жауаптар қайталанады' :
      !Number.isInteger(q.correct) || !q.options[q.correct] ? 'дұрыс жауап белгіленбеген' :
      !q.source ? 'дереккөзі белгісіз' :
      normalize(q.quote).length < 20 ? 'дәлел-сөйлем тым қысқа' :
      !q.source.norm.includes(normalize(q.quote)) ? 'дәлел-сөйлем мақалада жоқ (ойдан шығарылуы мүмкін)' :
      seen.has(q.text.toLowerCase()) ? 'сұрақ қайталанады' : '';
    if (why) { dropped.push({ text: q.text, reason: why }); continue; }
    seen.add(q.text.toLowerCase());
    kept.push({ ...q, source: { title: q.source.title, url: q.source.url, lang: q.source.lang } });
  }
  return { kept, dropped };
}

async function generateQuiz({ topic, count = 10, lang = 'kk', level = 'medium' }, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const llm = deps.chat || (m => chat(m, fetchImpl));
  topic = clean(topic, 120);
  count = Math.min(15, Math.max(3, Number(count) || 10));
  if (!LANG_NAME[lang]) lang = 'kk';
  if (!LEVEL[level]) level = 'medium';
  if (topic.length < 3) throw new Error('Тақырыпты жазыңыз');

  const sources = await (deps.findSources || findSources)(topic, fetchImpl);
  if (!sources.length) throw new Error('Бұл тақырып бойынша Уикипедиядан мақала табылмады. Тақырыпты басқаша жазып көріңіз.');

  const draft = await llm(writerPrompt({ topic, count, lang, level }, sources));
  const { kept, dropped } = verifyQuotes(draft.questions, sources);

  let final = kept;
  if (kept.length) {
    const verdict = await llm(checkerPrompt(kept));
    const results = new Map((verdict.results || []).map(r => [r.id, r]));
    final = kept.filter((q, id) => {
      const r = results.get(id);
      const ok = r && r.answer === q.correct && r.unambiguous === true;
      if (!ok) dropped.push({ text: q.text, reason: r ? `тексеруші: ${r.answer === q.correct ? 'сұрақ екіұшты' : 'дәлел басқа жауапты көрсетеді'}${r.issue ? ` (${r.issue})` : ''}` : 'тексеруші жауап бермеді' });
      return ok;
    });
  }
  return {
    topic,
    questions: final.slice(0, count),
    dropped,
    sources: sources.map(({ title, url, lang: l }) => ({ title, url, lang: l })),
  };
}

// Cheap validity check before saving a key: list models on the configured endpoint.
async function checkKey(key, fetchImpl = fetch) {
  try {
    const baseUrl = (process.env.AI_BASE_URL || PROVIDERS[providerOf(key)].baseUrl).replace(/\/$/, '');
    const res = await fetchImpl(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (res.ok) return { ok: true };
    if ([400, 401, 403].includes(res.status)) return { ok: false, error: 'Кілт қабылданбады. Оны толық көшіргеніңізді тексеріңіз.' };
    return { ok: false, error: `ИИ сервисі жауап бермеді (${res.status}). Кейінірек қайталаңыз.` };
  } catch (err) {
    return { ok: false, error: networkError(err).message };
  }
}

module.exports = { checkKey, generateQuiz, verifyQuotes, normalize, findSources, enabled: () => !!config().key, model: () => config().model, provider: () => config().provider };
