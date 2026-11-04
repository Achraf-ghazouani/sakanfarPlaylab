# Sakanfar PlayLab

**Say a game, and a minute later you are playing it.** You describe any game in words, out loud, or as a sketch. Meta's Muse models write it as real code, test it, and fix it. You play it in the browser, with your phone as the controller.

- **Live app:** https://sakanfarplaylab.vercel.app
- **Demo video:** a 3-minute walkthrough on YouTube, linked in the hackathon submission
- **Code:** https://github.com/Achraf-ghazouani/sakanfarPlaylab

Built solo for the Meta hackathon (October 30 to November 4, 2026), on the Meta Model API only. Plain HTML and JavaScript, no build step, no npm dependencies.

## For judges

No account needed. Open **https://sakanfarplaylab.vercel.app/login.html?guest=1** and the Studio opens with a guest account: 2,000 credits for two weeks, enough to build and change many games. The landing page and the login page have the same **Try it free** link.

You can also play without the Studio: **Play a demo** on the landing page runs three example games, and **Explore** lists the games people have published.

## Try it in 3 minutes

1. **Say or type a game.** After **Try it free**, tap the mic and say `a space game where a cat collects stars and dodges asteroids`, or type `a car race with 3 laps and 4 AI cars`, then send.
2. **Read the plan.** Muse Spark answers with a short plan: the goal, the controls, the levels. The plan is free, so change anything in words first.
3. **Build it.** Click **Go, build it**. The thinking panel shows Muse Wonder writing the game, the automatic play test, any crash being fixed, and Muse Spark checking a screenshot. The game then runs in the middle of the page.
4. **Change it.** Type `make the rivals faster` or `give the cat a rainbow trail`. Each change is a small patch of the code and a new version. **Undo** and **History** are in the top bar.
5. **Use your phone as the controller.** Click **Play with phone** and scan the QR code. Your phone shows the controls this game needs: a d-pad, a stick, steering with gas and brake, or a tap pad. Up to four phones can join.
6. **Draw it.** Click the pencil, draw a level or a maze, and click **Use drawing**. You can also attach a photo of your own character, or a `.glb` or `.fbx` model for a 3D game.
7. **Share it.** **Publish** gives you a link anyone can play with no account. On a phone, one tap opens it full screen, turned sideways. **Explore** lists published games, and any of them can be remixed.
8. **Keep it.** The download button saves the whole project as a ZIP: the game ready to play from a folder, the code, every version and your pictures.

## What makes it different

- **Any kind of game, written as code.** Racing, match-3, tower defense, runners, flight, soccer, dungeon crawlers, memory cards. Muse Wonder writes each one as a real canvas, Phaser 3 or three.js game, not a template. Nine test prompts pass live (`tests/anygame-results.md`).
- **It checks its own work.** Every build is played in a sandbox: it must draw, react to input and restart cleanly. A crash goes back to Muse Wonder with the error, for up to three free fixes. Then Muse Spark scores a screenshot against the request. Under 80%, Muse Wonder improves the game once, and the new version is kept only if it scores higher.
- **Fast changes.** Changes come back as search and replace patches of the code, usually in seconds, not a full rewrite.
- **Safe to run.** Generated code runs in an isolated iframe with a strict security policy: no network, no storage, no access to the page around it, and scripts only from pinned CDNs. Forbidden APIs are rejected before the code runs.
- **Phones with no app and no account.** Up to four controllers, each with the layout the game asks for, over WebRTC with a Supabase Realtime fallback.
- **Speaks your language.** English, French and Arabic, including right-to-left. Plans follow the language you write or speak in.
- **A real product around it.** Accounts and a waitlist, credits per model with refunds when a model fails, a shared daily budget, publishing with link previews, likes, reports, remixes, and an admin panel.

## Meta models in PlayLab

| Model | Endpoint | What it does here |
| --- | --- | --- |
| **Muse Wonder 1.0** | `POST /v1/chat/completions` (streamed) | Writes the whole game as one HTML file on the PlayLab SDK, and makes changes and fixes as patches |
| **Muse Spark 1.3** | `POST /v1/chat/completions` (structured output, vision) | Writes the plan from words, a sketch or a photo, and scores screenshots of the running game |
| **Muse Voice Transcribe 1.0** | `POST /v1/asr/transcribe` (16 kHz WAV) | Turns what you say into text in the chat box, in English, French, Arabic and more |
| **Muse Image 1.0** | `POST /v1/images/edits` | Redraws the character or object in your picture as a clean game sprite |
| **SAM 3.1** | `POST /v1/responses` | Finds the subject of a picture so the page can cut it out |

API keys never leave the server: the pages call the Vercel functions in `api/`, and only those call Meta. Request shapes and what we learned about the API are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#what-we-learned-about-the-meta-model-api).

## How it works

1. **The plan.** Words, speech, a sketch or a photo go to Muse Spark, which returns a plan: the engine, goal, controls, phone layout, opponents and levels (`/api/agent`, task `plan`).
2. **The game.** Muse Wonder writes one HTML file that uses the PlayLab SDK (`shared/playlab-sdk.js`) for keyboard, touch and phone input, pause and restart, the score display, sounds and your pictures (`/api/build-code`, streamed).
3. **The checks.** The Studio runs the game in the sandbox (`shared/coderun.mjs`), plays it, sends failures back for free fixes, and asks Muse Spark to look at it. Then it saves a version.
4. **The phones.** Phones join by QR code (`pad.html`) and get the layout the game asked for (`shared/padroute.mjs`).
5. **The data.** Projects, versions and chats live in Supabase behind row-level security. Published games run at `/play/<id>` in the same sandbox.

Every endpoint, the SDK, the sandbox, the database and the tests are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it locally

```bash
cp .env.example .env     # MODEL_API_KEY (Meta Model API), SUPABASE_URL, SUPABASE_ANON_KEY, PLAYLAB_SERVER_KEY
npm run dev              # http://localhost:3000/
npm test                 # the unit suites; the browser and database suites are listed in docs/ARCHITECTURE.md
```

Run the `db/*.sql` files once, in order, in the Supabase SQL editor. To deploy, import the repository in Vercel with the same environment variables.

## Rules we followed

- Everything was written during the hackathon, solo. Libraries come from CDNs or services: Phaser 3 and three.js for the generated games, PeerJS, Supabase, and Meta's `@meta-sam/parser`. Nothing is bundled or copied in.
- `.env` is never committed, and the Meta key is only used inside `api/` functions.
- Meta models only, as documented at dev.meta.ai. No other AI provider is used anywhere in the product.

## License

MIT, see [LICENSE](LICENSE). Free to use, change and share, with the copyright notice kept.
