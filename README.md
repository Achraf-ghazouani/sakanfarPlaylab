# Sakanfar PlayLab

**Describe any game, or sketch it, and Meta's AI writes it as code you can play a minute later — with your phone as the controller.**

![PlayLab in 20 seconds](docs/demo.gif)
<!-- TODO (before submitting): record a 20-second GIF of: type "a car race with 3 laps and 4 AI cars" -> the plan -> Go -> the game runs -> scan the QR with a phone -> play. Save it as docs/demo.gif. -->

**Live:** https://sakanfarplaylab.vercel.app · **Demo video:** _[2-minute walkthrough — link coming]_ · **Code:** https://github.com/Achraf-ghazouani/sakanfarPlaylab

Built solo for the Meta hackathon (Oct 30 – Nov 4, 2026) on the Meta Model API: **Muse Spark** plans the game and looks at the result, **Muse Wonder** writes the whole game as code and fixes its own bugs, **Muse Image** draws sprites, **SAM 3.1** cuts your pictures out. Plain HTML/JS, no build step, no npm dependencies.

## Judges: a ready account

PlayLab is in a private beta (invite-only), so a demo account is prepared for you:

| | |
| --- | --- |
| Address | https://sakanfarplaylab.vercel.app/login.html → **Username** tab |
| Username | `judge` _(TODO: create it in Admin → Users → New user, demo account, 500 credits)_ |
| Password | _(TODO: paste it in the submission form, not here)_ |

It has 500 credits (about 20 games and many changes); if it runs dry, the admin panel tops it up in one click.

## Try it in 3 minutes

1. **Log in** with the judge account. The Studio opens on an empty page with one chat box.
2. **Type** `a car race with 3 laps and 4 AI cars` and send. Muse Spark answers with a short plan (free): change anything in words, then click **Go, build it**. Watch the thinking panel: Muse Wonder writes the game, the sandbox plays it, a crash is sent back and fixed, Muse Spark looks at a screenshot. The game runs in the middle of the page.
3. **Change it**: `make the rivals faster` · `add a boost pad on every lap`. Each change is a small patch of the code (a few seconds) and a new version; **Undo** and **History** are in the top bar.
4. **Phone**: click the phone button, scan the QR with your phone. It shows the controls this game asked for (steering, GAS and BRAKE for a race, a d-pad for snake, a tap pad for a card game). A second phone joins as player 2.
5. **Sketch it** (2D): click the pencil, draw a maze or a level, **Use drawing**. Muse Spark reads the drawing into the plan, and the game is built around it. Or point your phone camera at a drawing on paper.
6. **Your own art**: attach a photo with `this is my player` (Muse Image redraws it as a sprite, SAM 3.1 cuts it out) or a `.glb` / `.fbx` model in 3D. It goes straight into the game.
7. **Publish**: the **Publish** button makes a link anyone can play with no account, with a cover, phones and a **Remix** button. **Explore** lists published games; the landing page's **Play a demo** runs three games written the same way.

## What makes it different

- **Any kind of game, not templates.** Racing, match-3, tower defense, runners, flight, soccer, dungeon crawlers, memory cards: Muse Wonder writes each one as a real Phaser 3 or three.js game. Nine test prompts all pass live (`tests/anygame-results.md`).
- **It checks its own work.** Every build runs in a sandbox: first frames, no exception, a drawn screen, a reaction to input, a restart. A failure goes back to Muse Wonder with the error line (up to three free fixes); then Muse Spark looks at a screenshot and asks for one improvement if it does not look like what you asked for. The reply never claims a broken game works.
- **Fast edits.** Changes come back as search / replace patches of the code (about 4 s), not a full rewrite; every change is a version.
- **Safe to run.** Generated code runs in an iframe with no origin of its own and a strict Content Security Policy (scripts only from pinned CDNs, no network, no storage, no parent page), after a scan for forbidden APIs.
- **Phones with no app and no account**: up to four controllers with the layout each game asks for, and a camera that reads drawings — WebRTC with a Supabase Realtime fallback.
- **Speaks your language.** English, French and Arabic (right-to-left); the plans follow the language you write in.
- **A real product around it**: accounts and a waitlist, credits per model, a shared daily budget, publishing with link previews, likes, reports, remixes, and an admin panel.

## Meta models in PlayLab

| Model | Endpoint | What it does here |
| --- | --- | --- |
| **Muse Wonder 1.0** | `POST /v1/chat/completions` (streamed) | Writes the whole game as one HTML file on top of the PlayLab SDK; changes and fixes as search / replace patches |
| **Muse Spark 1.3** | `POST /v1/chat/completions` (structured output, vision) | The plan (from words, a sketch or a photo), the vision check of a running game's screenshot, telling a character from an object or a UI piece in a picture |
| **Muse Image 1.0** | `POST /v1/images/edits` | Redraws the character or object in your picture as a clean game sprite |
| **SAM 3.1** | `POST /v1/responses` (`sam-3.1`) | Finds the subject of a picture and returns the pixel mask the page cuts it out with (decoded with Meta's `@meta-sam/parser`) |

Keys never leave the server (Vercel functions in `api/`); every build is charged in credits first and refunded if the model fails. Request shapes and what we learned about the API are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#what-we-learned-about-the-meta-model-api).

## How it works, briefly

1. **Words, a sketch or a photo go in.** Muse Spark turns them into a plan: engine (canvas, Phaser 3 or three.js), goal, controls, the phone layout, opponents, levels (`/api/agent`, task `plan`).
2. **Muse Wonder writes the game** (`/api/build-code`, streamed): one HTML file using the PlayLab SDK (`shared/playlab-sdk.js`) for input from keyboard, touch and phones, pause and restart, HUD, sounds and the person's own pictures.
3. **The Studio runs it in the sandbox** (`shared/coderun.mjs`), smoke-tests it, sends failures back for free fixes, and asks Muse Spark to look at it. Then it is saved as a version.
4. **Phones** join by QR over PeerJS (`pad.html`) and get the layout the game asked for (`shared/padroute.mjs`); the phone camera (`shared/paper.js`) finds a sheet of paper and sends the drawing.
5. **Everything is saved** in Supabase (projects, versions, chat), behind row-level security; published games run at `/play/<id>` in the same sandbox.

The long version — every endpoint, the SDK, the sandbox, the database, the tests — is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Run it locally

```bash
cp .env.example .env     # MODEL_API_KEY (Meta Model API), SUPABASE_URL, SUPABASE_ANON_KEY, PLAYLAB_SERVER_KEY
npm run dev              # http://localhost:3000/  (npm run dev:https for the phone camera on your LAN)
npm test                 # the unit suites; the browser and database suites are listed in docs/ARCHITECTURE.md
```

Run the `db/*.sql` files once in the Supabase SQL editor, in order. Deploying is a Vercel import with the same environment variables (details in the architecture doc).

## Rules we followed

- All of it was written during the hackathon, solo. Libraries come from CDNs or services (Phaser 3 and three.js for the generated games, PeerJS, Supabase, Meta's `@meta-sam/parser`); nothing is bundled or copied in.
- `.env` is git-ignored; the Meta key is only ever used inside `api/` functions. Pages talk to the models through those functions, never directly.
- Meta models only, as documented at dev.meta.ai: no other AI provider in the product.
