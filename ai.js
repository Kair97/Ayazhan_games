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
// No key at all -> Pollinations' anonymous tier (GPT-OSS 20B, no signup), so the generator works out of the box.
// sourceChars = article text per language sent to the model; Groq's free tier allows ~8k tokens/minute.
const PROVIDERS = {
  free: { baseUrl: 'https://text.pollinations.ai/openai', model: 'openai-fast', sourceChars: 6000, batch: 3, lowReasoning: null, minGapMs: 16000, retries: 2, name: 'Тегін кілтсіз режим (Pollinations / OVHcloud)' },
  // OVHcloud AI Endpoints: official anonymous tier, 2 requests/minute per IP and model. Backup for keyless mode.
  ovh: { baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', model: 'gpt-oss-120b', sourceChars: 6000, batch: 3, lowReasoning: null, minGapMs: 31000, retries: 1, name: 'OVHcloud' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', sourceChars: 14000, batch: 20, lowReasoning: 'param', retries: 1, name: 'Google Gemini' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', sourceChars: 3500, batch: 6, lowReasoning: 'param', retries: 1, name: 'Groq' },
};
const KEYLESS = [PROVIDERS.free, PROVIDERS.ovh];
const providerOf = key => (!key ? 'free' : key.startsWith('gsk_') ? 'groq' : 'gemini');

function config() {
  const key = process.env.AI_API_KEY || '';
  const preset = PROVIDERS[providerOf(key)];
  const custom = !!process.env.AI_BASE_URL;
  return {
    key,
    provider: custom ? 'custom' : providerOf(key),
    name: custom ? process.env.AI_BASE_URL : preset.name,
    baseUrl: (process.env.AI_BASE_URL || preset.baseUrl).replace(/\/$/, ''),
    model: process.env.AI_MODEL || preset.model,
    sourceChars: Number(process.env.AI_SOURCE_CHARS) || (custom ? 8000 : preset.sourceChars),
    batch: custom ? 8 : preset.batch,
    lowReasoning: custom ? null : preset.lowReasoning,
    minGapMs: custom ? 0 : preset.minGapMs || 0,
    retries: custom ? 1 : preset.retries,
  };
}

// Turns low-level network failures into something a teacher can act on.
function networkError(err) {
  const code = err?.cause?.code || err?.code || '';
  if (err?.name === 'TimeoutError') return new Error('ЖИ сервисі тым ұзақ жауап бермеді. Кейінірек қайталаңыз.');
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR/.test(code) || err instanceof TypeError) {
    return new Error('ЖИ сервисіне қосылу мүмкін болмады. Бұл Wi-Fi желісі оны бұғаттауы мүмкін: басқа желіге (мысалы, телефонның хотспотына) қосылып көріңіз.');
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
// Pacing clocks per endpoint: free tiers count from the end of the previous answer.
const lastCallAt = new Map(); // ponytail: process-wide clocks; fine for one classroom server

// One provider: pace, call, retry temporary refusals, parse the JSON reply.
async function callProvider(p, key, messages, fetchImpl) {
  const gap = (lastCallAt.get(p.baseUrl) || 0) + (p.minGapMs || 0) - Date.now();
  if (gap > 0) await sleep(gap);
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchImpl(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        // Short reasoning where allowed: the task is extraction from given text. Free tiers refuse reasoning control (402).
        body: JSON.stringify({ model: p.model, messages, temperature: 0.2, ...(p.lowReasoning === 'param' ? { reasoning_effort: 'low' } : {}), response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(120000),
      });
    } catch (err) {
      lastCallAt.set(p.baseUrl, Date.now());
      throw networkError(err);
    }
    // 429 = per-minute limit; 402 = anonymous quota (refills within a minute); 5xx = temporary outage.
    const retryable = [429, 402].includes(res.status) || res.status >= 500;
    if (!retryable || attempt >= p.retries) break;
    lastCallAt.set(p.baseUrl, Date.now());
    await sleep(1000 * Math.min(60, Number(res.headers.get('retry-after')) || (res.status === 402 ? 30 : res.status >= 500 ? 10 : 20)));
  }
  const body = await res.text();
  lastCallAt.set(p.baseUrl, Date.now());
  if (!res.ok) {
    const err = new Error(
      res.status === 429 || res.status === 402 ? 'ЖИ сервисінің тегін лимиті уақытша бітті. Бір-екі минуттан кейін қайталаңыз.'
        : res.status === 413 ? 'Мақалалар тым ұзын болды. Тақырыпты нақтырақ жазыңыз.'
          : res.status === 401 || res.status === 403 ? 'ЖИ кілті қабылданбады. ✨ терезесінде кілтті қайта қосыңыз.'
            : `ЖИ сервисінің қатесі (${res.status}). Кейінірек қайталаңыз.`);
    err.status = res.status;
    throw err;
  }
  const content = JSON.parse(body).choices?.[0]?.message?.content || '';
  const json = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
  if (!json) throw new Error('ЖИ жауабы толық келмеді. Қайталап көріңіз.');
  return JSON.parse(json);
}

// With a key: that provider. Without one: the keyless free services in turn, then a clear "add a key" message.
async function chat(messages, fetchImpl = fetch) {
  const c = config();
  if (c.key || c.provider === 'custom') return callProvider(c, c.key, messages, fetchImpl);
  let lastErr;
  for (const p of KEYLESS) {
    try {
      return await callProvider(p, '', messages, fetchImpl);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Тегін кілтсіз ЖИ сервистері қазір жауап бермей тұр (${lastErr?.message || 'қате'}). Сенімді жұмыс үшін ✨ терезесінде тегін кілт қосыңыз.`);
}

const LANG_NAME = { kk: 'Kazakh (Cyrillic script)', ru: 'Russian' };
const LEVEL = {
  easy: 'easy: well-known key facts a school student should know',
  medium: 'medium: important facts that need careful reading',
  hard: 'hard: precise details (names, numbers, places) that are still clearly stated',
};

function writerPrompt({ topic, n, lang, level }, sources, avoid = []) {
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
    {
      role: 'user',
      content: `TOPIC: ${topic}\nWrite ${n} questions.${avoid.length ? `\nDo NOT repeat these already written questions or their facts:\n- ${avoid.join('\n- ')}` : ''}\n\nSOURCES:\n${src}`,
    },
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
- "question_supported": true only if EVERY fact stated in the question text itself (names, relatives, numbers, places, dates) matches the quote exactly. A wrong detail in the question (e.g. "grandfather" when the quote says "father") makes it false.
- "issue": short reason when answer is -1, unambiguous is false or question_supported is false, else "".
Return JSON: {"results":[{"id":0,"answer":0,"unambiguous":true,"question_supported":true,"issue":""}]}`,
    },
    { role: 'user', content: JSON.stringify(items.map((q, id) => ({ id, quote: q.quote, question: q.text, options: q.options }))) },
  ];
}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Verbatim check, tolerant only of FORMATTING: trailing punctuation, and "..." where every fragment is
// word-for-word in the article (>=5 chars each, >=20 in total), in order, with at most 80 skipped characters between them.
function quoteInSource(quote, sourceNorm) {
  const parts = normalize(quote).split(/\s*(?:\.\.\.|…)\s*/).map(p => p.replace(/[.,;:!?]+$/, '').trim()).filter(Boolean);
  if (!parts.length || parts.some(p => p.length < 5) || parts.join('').length < 20) return false;
  let from = 0;
  for (const [i, part] of parts.entries()) {
    const at = sourceNorm.indexOf(part, from);
    if (at < 0 || (i > 0 && at - from > 80)) return false;
    from = at + part.length;
  }
  return true;
}

// Structure + verbatim-quote check. Returns { kept, dropped:[{text, reason}] }.
function verifyQuotes(questions, sources, already = []) {
  const byId = Object.fromEntries(sources.map(s => [s.id, { ...s, norm: normalize(s.text) }]));
  const kept = [], dropped = [], seen = new Set(already.map(t => t.toLowerCase()));
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
      !quoteInSource(q.quote, q.source.norm) ? 'дәлел-сөйлем мақалада жоқ (ойдан шығарылуы мүмкін)' :
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

  // Writer in batches (small reply limits on free tiers); each batch is told what already exists.
  const per = deps.batch || config().batch;
  const need = Math.ceil(count * 1.6);
  const kept = [], dropped = [];
  for (let round = 0; round < 5 && kept.length < need; round++) {
    let draft;
    try {
      draft = await llm(writerPrompt({ topic, n: Math.min(per, need - kept.length), lang, level }, sources, kept.map(q => q.text)));
    } catch (err) {
      if (!kept.length) throw err;
      break; // keep what the earlier batches produced
    }
    const v = verifyQuotes(draft.questions, sources, kept.map(q => q.text));
    kept.push(...v.kept);
    dropped.push(...v.dropped);
    if (!v.kept.length && round > 0) break; // the model has run out of new facts
  }

  // Blind checker, also batched.
  const final = [];
  for (let i = 0; i < kept.length; i += per * 2) {
    const chunk = kept.slice(i, i + per * 2);
    const verdict = await llm(checkerPrompt(chunk));
    const results = new Map((verdict.results || []).map(r => [r.id, r]));
    chunk.forEach((q, id) => {
      const r = results.get(id);
      const ok = r && r.answer === q.correct && r.unambiguous === true && r.question_supported === true;
      const why = !r ? 'тексеруші жауап бермеді'
        : r.answer !== q.correct ? 'дәлел басқа жауапты көрсетеді'
          : r.question_supported !== true ? 'сұрақтың өз мәтінінде дәлелге сәйкес келмейтін дерек бар' : 'сұрақ екіұшты';
      if (ok) final.push(q);
      else dropped.push({ text: q.text, reason: `тексеруші: ${why}${r?.issue ? ` (${r.issue})` : ''}` });
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
    return { ok: false, error: `ЖИ сервисі жауап бермеді (${res.status}). Кейінірек қайталаңыз.` };
  } catch (err) {
    return { ok: false, error: networkError(err).message };
  }
}

module.exports = { quoteInSource, checkKey, generateQuiz, verifyQuotes, normalize, findSources, enabled: () => true, model: () => config().model, provider: () => config().provider, providerName: () => config().name };
