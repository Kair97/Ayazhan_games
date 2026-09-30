# Бәйге · Түрік қағанаты

A live multiplayer history quiz for the classroom, in Kazakh. The host shows the game on a laptop or projector (or runs it from a phone), and players join from their phones by scanning a QR code. The leaderboard is a horse race (бәйге).

**For non-technical users:** see the step-by-step guide `Нұсқаулық.pdf` (in Kazakh).

## Games

There are 120 built-in questions. Every question has a "Білесің бе?" fact that appears after the answer.

| Game | Mode |
|---|---|
| Қағанат негіздері · Қағандар мен батырлар · Дала өмірі | classic, 4 options |
| Рас па, өтірік пе? | true / false |
| Жылнама | guess the year on a slider; the closer the guess, the more points |
| Шежіре тізбегі | put events in chronological order |
| Мен кіммін? | clues open one by one; an earlier guess earns more points |
| Руна шешу | read real Orkhon runes (Old Turkic Unicode) |
| Бітіктас сөйлейді | fill the gap in lines from the Orkhon inscriptions |
| Суреттен тап | real photos of monuments and museum objects (freely licensed, credited) |
| Эмодзи-жұмбақ | emoji rebuses |
| Шашылған әріптер | build the word from scrambled letters |
| Аралас бәйге | 12 random questions from every game |

Other features:
- **Your own quiz:** write one in the browser editor, or have the AI draft one (see below).
- **Team mode:** 🐺 Көк бөрілер vs 🦅 Алтын қырандар. Teams are auto-balanced and scored by average points.
- **Golden question:** the last question is worth double points.
- **Music and sounds:** synthesised in the browser (dombra-style plucks, galloping hooves, a fanfare), with a mute button. No audio files are used.
- **Resilient connections:** players can refresh or lose Wi-Fi and they rejoin with their score. The host can resume too, or control the game from a second device ("Телефон-пульт").
- **Works without internet on a local network:** fonts and images are self-hosted.

## Run

Requires [Node.js](https://nodejs.org) 20.12 or newer.

- **Windows:** double-click `start-game.bat`. On the first run it installs dependencies, then it starts the game and opens the browser.
- **Anywhere:**
  ```
  npm install
  npm start
  ```
  Open `http://localhost:3001`, then **Жаңа ойын құру**.

Players must be on the **same Wi-Fi** as the computer. The QR code already contains the right address. If Windows asks about the firewall on the first run, allow access on private networks.

To play over the internet (players on different networks), deploy to any Node host with WebSocket support (Render, Railway, Fly), or use a tunnel and set `PUBLIC_URL` to its address.

## AI quiz generator (optional)

The host types a topic, for example "Абылай хан". The generator then works like this:

1. It downloads the matching Wikipedia articles (kk, ru, en).
2. The LLM writes questions **only from those articles**. Each question must include a verbatim supporting quote.
3. The server checks that every quote really appears in the article text. A question with an invented quote is dropped.
4. A second, blind LLM pass answers each question from its quote alone. If it disagrees with the answer key, the question is dropped.
5. The host reviews the surviving questions, with a source link for each, and edits them before saving.

To enable it, copy `.env.example` to `.env` and put a free key in `AI_API_KEY` (from [Google AI Studio](https://aistudio.google.com/apikey)). Any OpenAI-compatible provider works via `AI_BASE_URL` and `AI_MODEL` (for example Groq). The endpoint is rate-limited per IP address (12 quizzes per hour) so players on the same Wi-Fi can't drain the quota.

## Test

```
npm test
```

The test validates every built-in question: the answer key, year ranges, runic characters, image files and credits. It then plays full games over real sockets: every mode, reconnects, host takeover protection, teams, the golden question, anagrams with repeated letters, and the AI pipeline against a fake LLM that invents a quote, gives a wrong answer key and duplicates options. All three must be rejected.

## Project layout

| Path | What |
|---|---|
| `server.js` | rooms, timers, scoring, validation, AI endpoint. All game logic is on the server |
| `ai.js` | Wikipedia retrieval, LLM calls, quote verification, blind checker |
| `packs.js` | built-in games; the question types are documented at the top |
| `public/` | `index.html` landing, `host.html/js`, `player.html/js`, `common.js`, `sound.js`, `style.css`, `fonts/`, `img/` |
| `start-game.bat` | one-click launcher for Windows |

Games are kept in memory, so restarting the server ends running games. Custom quizzes are stored in the host's browser (localStorage).

## Credits

Photos (Wikimedia Commons) and fonts (SIL OFL) are listed in [CREDITS.md](CREDITS.md). The historical facts in the built-in questions follow standard histories of the Turkic Khaganate. Please report any mistake as an issue.
