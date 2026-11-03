# Sakanfar PlayLab

**Draw a game on paper, or just describe it, and play it ten seconds later — with your phone as the controller.**

![PlayLab in 20 seconds](docs/demo.gif)
<!-- TODO (before submitting): record a 20-second GIF of: type "a lava castle" -> the game appears -> scan the QR with a phone -> play. Save it as docs/demo.gif. -->

**Live:** https://sakanfarplaylab.vercel.app · **Demo video:** _[2-minute walkthrough — link coming]_ · **Code:** https://github.com/Achraf-ghazouani/sakanfarPlaylab

Built solo for the Meta hackathon (Oct 30 – Nov 4, 2026) on the Meta Model API: **Muse Spark** builds and repairs the games, **Muse Image** draws the sprites, **SAM 3.1** cuts your pictures out. Plain HTML/JS, no build step, no npm dependencies.

## Judges: a ready account

PlayLab is in a private beta (invite-only), so a demo account is prepared for you:

| | |
| --- | --- |
| Address | https://sakanfarplaylab.vercel.app/login.html → **Username** tab |
| Username | `judge` _(TODO: create it in Admin → Users → New user, demo account, 500 credits)_ |
| Password | _(TODO: paste it in the submission form, not here)_ |

It has 500 credits (about 40 games); if it runs dry, the admin panel tops it up in one click.

## Try it in 60 seconds

1. **Log in** with the judge account. The Studio opens on an empty page with one chat box.
2. **Type** `a lava castle with two moving platforms and a boss at the end` and send. Muse Spark builds the level, the playtest agent checks every jump, and the game runs in the middle of the page. Play it with the arrow keys.
3. **Change it**: `make it harder` · `switch to 3D` · `a zombie shooter instead` (an arena, first person, waves). Every change is a version; **Undo** is in the top bar.
4. **Phone**: click **Play with phone**, scan the QR with your phone — it becomes the controller (arrows and jump; sticks and FIRE for a shooter). A second phone joins as player 2.
5. **Draw**: on a computer, click the camera button, scan the QR with your phone and point it at a sheet of paper. Draw a ground line, a few platforms, a cactus, some circles and a flag: the level builds itself while you draw, and your pen strokes are the game's art. (Or attach a photo of a drawing, or sketch on the pad in the chat.)
6. **Your face in the game**: attach a photo and type `use this as my player as is` — SAM 3.1 cuts you out and you are the character. Without "as is", Muse Image redraws you as a sprite.
7. **Publish**: the **Publish** button makes a link anyone can play with no account, with a cover and a link preview. Try **Explore** for games others made, and **Remix** one.

## What makes it different

- **Free drawings, not symbols.** A cactus is an enemy, a cloud a moving platform, a circle a coin: Muse Spark reads the drawing, and the game wears your own ink.
- **Always beatable.** A playtest agent simulates the jump physics, explains what is impossible in plain words (`platform "sky ledge" is 470 above "ground" but the player jumps at most 244`) and repairs it — Muse Spark first, a deterministic fix as the safety net.
- **Live edit by redrawing.** Add a bridge on the paper, erase a spike: the phone notices, re-scans, and the new things pop into the running game while the player keeps their spot.
- **Two engines from one chat.** Platformers (Phaser 3, with a one-click 3D view) and arena shooters (three.js, first / third person / top-down) — the chat builds the kind of game you asked for, never a platformer when you said "shooter".
- **Phones with no app and no account**: controllers (up to four players), camera, live scanner — WebRTC with a Supabase Realtime fallback.
- **Speaks your language.** The interface in English, French and Arabic (right-to-left), switchable from the account menu, and the chat answers in whatever language you write.
- **A real product around it**: accounts and a waitlist, credits with prices per model, a shared daily budget, publishing with link previews, likes, reports, remixes, and an admin panel.

## Meta models in PlayLab

| Model | Endpoint | What it does here |
| --- | --- | --- |
| **Muse Spark 1.3** | `POST /v1/chat/completions` (tool calling, vision) | The game agent (`create_level`, `edit_level`, `create_arena`, `edit_arena`, `playtest_level` tools), reads drawings into level JSON, repairs impossible levels with minimal edits, tells a character from an object from a level in a picture |
| **Muse Spark Open** | Baseten, OpenAI-compatible | The fallback when the Meta API fails, and the live re-scans from the phone (cheaper) |
| **Muse Image 1.0** | `POST /v1/images/edits` | Redraws the character or object in your picture as a clean game sprite (player, enemy, coin, flag, spikes, scenery) |
| **SAM 3.1** | `POST /v1/responses` (`sam-3.1`) | Finds the subject of a picture (concept prompt from the classifier, or a point in the middle) and returns the pixel mask the page cuts it out with — decoded with Meta's `@meta-sam/parser` |

Keys never leave the server (Vercel functions in `api/`); every call is charged in credits first and refunded if the model fails. The details of each call, the request shapes and what we learned about the API are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#what-we-learned-about-the-meta-model-api).

## How it works, briefly

1. **A picture or a sentence goes in.** Photos are resized in the browser and read by Muse Spark into a 1000 x 1000 level JSON (`/api/scan`); sentences go to the game agent, which answers with a function tool (`/api/agent`).
2. **The playtest agent** (`shared/reach.mjs`, `/api/fix`) walks the level from the start and makes sure every platform, coin and goal is reachable.
3. **The engines play it**: `game.html` (Phaser 3, plus a three.js mirror for the 3D view) or `arena.html` (three.js shooter), inside the Studio or on their own.
4. **Phones** join by QR over PeerJS (`pad.html`), as controllers or as the paper camera (`shared/paper.js` finds the sheet, flattens it, extracts the ink).
5. **Everything is saved** in Supabase (projects, versions, chat), behind row-level security, with credits charged in one transaction per AI call.

The long version — every endpoint, the database, the phone protocol, the Studio's messages, the tests — is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Run it locally

```bash
cp .env.example .env     # MODEL_API_KEY (Meta Model API), SUPABASE_URL, SUPABASE_ANON_KEY, PLAYLAB_SERVER_KEY
npm run dev              # http://localhost:3000/  (npm run dev:https for the phone camera on your LAN)
npm test                 # the unit suites; the browser and database suites are listed in docs/ARCHITECTURE.md
```

Run the `db/*.sql` files once in the Supabase SQL editor, in order. Deploying is a Vercel import with the same environment variables (details in the architecture doc).

## Rules we followed

- All of it was written during the hackathon, solo. Libraries come from CDNs or services (Phaser 3, three.js, PeerJS, Supabase, Meta's `@meta-sam/parser`); nothing is bundled or copied in.
- `.env` is git-ignored; the Meta key is only ever used inside `api/` functions. Pages talk to the models through those functions, never directly.
- Meta models only, as documented at dev.meta.ai: no other AI provider in the product (Baseten only serves Meta's own Muse Spark open weights).
