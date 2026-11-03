# Sakanfar PlayLab

Draw a 2D platformer level on paper, or describe it in a chat, and Meta's Muse Spark turns it into a playable browser game.
Free drawings, not strict symbols: a cactus becomes an enemy, a cloud becomes a moving platform.
A playtest agent then checks every jump and repairs impossible parts, so the level is always beatable.

Built solo for the Meta hackathon (Oct 30 - Nov 4, 2026). Plain HTML/JS + Phaser 3 from a CDN, no build step, no dependencies.

## The flow

1. `index.html`: the landing page. **Start creating** opens the Studio (visitors log in first; the login page links the waitlist), **Play a demo** opens a sample level with no account.
2. `studio.html`, the Studio: a chat next to the live game. Describe a game and Muse Spark builds it (`POST /api/agent`). Attach a drawing, sketch one on the pad, or take a picture with the phone camera, and the scanner reads it. On a computer, link your phone camera with the QR code and point it at the paper: live detection, auto-capture, re-scans while you draw. Every change is a saved version with undo.
3. `POST /api/scan`: Muse Spark reads the picture (the browser resizes it to a 1600px JPEG) and returns level JSON. The playtest agent checks reachability and applies an instant fix if needed.
4. "Playtest it" calls `POST /api/fix`: Muse Spark repairs the level with minimal edits (add a step, lower a ledge).
5. `game.html`: plays the level, inside the Studio preview or full screen with touch controls, the phone controller and the big-screen mode (`game.html?screen=1`).
6. **Live edit by redrawing**: change the paper (add a bridge, erase a spike) and scan it again. The scan gets the earlier level as context, `shared/diff.mjs` works out what changed, new things pop into the running level, the player stays where they were, and the chat says "+1 platform, +1 coin".

## Big screen mode (PC + phone, one QR)

Click **Big screen** in the landing page footer or the Studio sidebar (or open `game.html?screen=1`). The PC shows a QR code
and a 4-letter room code. Scanning it opens `pad.html` on the phone, which starts its back camera right away and
streams it to the PC over a one-way PeerJS media call, so the big screen shows what the phone sees. The phone can
switch between **Camera** and **Controller** with one button; phones that join while a level is already loaded become
controllers (players 2-4). Status is shown on both screens, and the stage falls back to the QR when the phone leaves.

Phone cameras only work on HTTPS. The live site is HTTPS; on your LAN run `npm run dev:https` (self-signed certificate
made with the openssl bundled with Git for Windows, accept the warning once on the phone).

**Live build while you draw** (`shared/paper.js`, no OpenCV):
- The phone finds the sheet in every frame (brightest region, corner extraction on a 160x120 downscale), draws a green
  outline into the stream, and when the sheet has been still for about a second it captures, flattens the sheet with a
  4-point homography to 1200x900, boosts the contrast and extracts the dark pen strokes. A manual shutter button exists too.
- Instantly, the ink mask goes to the PC over the data channel and draws itself on notebook paper. The flattened photo
  goes to `/api/scan`; when the level arrives, the objects pop in one by one with sound, the playtest agent's fixes show
  in a toast, and the game starts underneath with the phone camera in a picture-in-picture corner.
- Keep drawing: the phone compares the flattened ink with the last capture (tolerant to small shifts), and when the
  drawing changed and is steady again for 1.5 s it re-scans, sending the previous level as context and asking for the
  Baseten model to save Meta credits. New objects pop into the running level, the player keeps their spot, and a toast
  says "+2 coins". Only one scan runs at a time; a newer capture replaces a waiting one.
- **PLAY!** on the phone switches it to the controller; **Back to camera** keeps editing while the game runs. Other phones
  that scan the same code join as controllers.

Testing without a drawing: `pad.html?room=CODE&fakepaper=1` uses a code-drawn sheet as the camera.

## Play with your phone (phone as controller)

On a computer, `game.html` has a **Play with your phone** button. It shows a QR code and a 4-letter room code.
Scanning the QR opens `pad.html?room=CODE` on the phone: a landscape controller with left / right / jump buttons
(multi-touch, so you can run and jump at once) that vibrates on jump, coin, hit and goal. The keyboard keeps working.

- Transport: WebRTC data channels through PeerJS (`shared/phonelink.js`), signaled by the public PeerServer. Measured press-to-reaction round trip on one network: under 10 ms.
- Fallback: if WebRTC has not connected within 5 s (mobile data, strict Wi-Fi), the phone switches to a relay over **Supabase Realtime Broadcast** (channel `playlab-CODE`, no database, rooms are temporary). The game listens on both. Controls work over the relay (about 150 ms round trip); live video needs the direct connection. Both screens show "(relay)" when it is in use. Configure it with `SUPABASE_URL` and `SUPABASE_ANON_KEY` (the publishable key) in `.env` and on Vercel; `api/config.js` hands them to the pages.
- Status is shown on both screens (connecting / waiting / connected / reconnecting). Phones ping every 3 s; a silent phone is dropped after 8 s, and the phone redials by itself when the game reloads or the network blips.
- The room code is kept for the page session, so reloading the game keeps the same QR.
- Rooms are temporary and need no database.

## Your drawing is the art

When a level comes from a picture (photo, phone camera, sketch pad), the game wears your own pen strokes instead of
colored shapes: the cactus you drew is the enemy that walks (and turns around), your circles are the coins that bob,
your flag waves at the goal, your cloud drifts with the moving platform. `shared/inkart.js` does it in the browser
with no AI call and no credits:

- Each object's box (the level grid covers the whole picture) is cut from the picture at 720 px, grown by 10% because
  the AI boxes are tight, and the paper is keyed out: per-crop paper brightness, dark or colored ink becomes opaque.
- Printed notebook rules are thin and light, so light ink only stays where it survives a small opening; dark strokes
  always stay. Ink inside platform boxes belongs to the platform, so an enemy standing on the ground does not carry
  the ground line along, and an undrawn flag on the ground does not "find" it.
- A crop with almost no ink (something the chat added, or a box that missed the drawing) keeps the usual shape.
- Physics boxes do not change; only the visuals do. **Drawn art** in the top bar (or `G`) switches to simple shapes
  and back, and the choice is remembered.

The Studio and the phone save the picture at 720 px for this (chat thumbnails stay small).

## Two kinds of game: platformer or arena shooter

The chat reads what you ask for and builds that kind of game. "A first-person shooter with zombie waves" is a shooter, "a lava castle with moving platforms" is a platformer. Muse Spark picks with two tool pairs (`create_level` / `edit_level` and `create_arena` / `edit_arena`, `lib/agent.mjs`), and a guard makes sure a shooter request never comes back as a platformer: if the model picks the wrong kind, `generateArena()` builds the arena from the words instead.

**Arena shooter** (`arena.html`, three.js): the player stands in a fenced arena and shoots waves of enemies that walk out of spawner gates. Three cameras, switched in the game (FPS / TPS / Top buttons, keys 1 2 3) or by chat ("switch to top-down", free): first person with mouse look, third person behind the player, top-down aiming at the mouse. WASD to move, click or space to shoot, ammo and medkits on the ground, waves grow (wave n has 3 + 2n enemies), win when the last wave is cleared. Themes from the words (graveyard, alien outpost, robot factory, desert, snow, city, castle). The player picture and an enemy sprite from the Studio appear as billboards.

**Phones.** The pad (`pad.html`) changes its controls with the kind of game it is linked to: arrows and JUMP for a platformer, and for a shooter a move stick, an aim stick and a FIRE hold (`shared/joystick.js`), sent as `{t:"stick", m, a}` and `{t:"fire"}` through the Studio to the arena. First and third person: the aim stick turns the view; top-down: it aims and shoots like a twin-stick game. On a phone opened directly, `arena.html` shows the same sticks on screen.

Format (`shared/arena.mjs`): a top-down 1000 x 1000 map, `genre: "arena"`, `view`, `waves`, objects `start`, `spawner`, `wall`, `prop`, `ammo`, `health`. Its playtest agent (`checkArena` / `autoFixArena`) flood-fills the map from the player and moves any walled-off gate or pickup to open ground; "Playtest it" runs it in the server. Arena games are always 3D (`projects.mode` `3d-world`) and cost the 3D prices. Demo: `levels/zombies.json`, a card on the landing page.

## 2D or 3D

The chat box starts with a **2D | 3D** switch: pick it before you type (words like "a 3D lava castle" or "make it 3D" switch it too). The game type is saved on the game (`projects.mode`: `2d` or `3d-side`), and 3D turns cost the 3D prices (`create_3d` 25, `edit_3d` 5).

The 3D view (`shared/view3d.js`, three.js 0.160 from a CDN, loaded only when needed) draws the same running level in three dimensions: the game underneath does not change, so the physics, the controls, the phone controllers, the playtest agent and every existing level work the same. Phaser keeps running with its canvas hidden, and after every frame the scene is mirrored: platforms become solid blocks with a grass top, spikes metal cones, coins spinning gold, enemies and characters little blocks with eyes, the goal a pole with a waving flag, "tree" and "cloud" decorations real trees and clouds. Pictures (drawn ink, Muse Image sprites, your player picture) stand in the world as paper cut-outs; ink drawn on a platform sits on its front face. A sun follows the player for sharp shadows, and the camera eases after them from slightly above.

Outside the Studio: `game.html?mode=3d`, the **3D** button on the game page, or the **V** key.

## The playtest agent

`shared/reach.mjs` simulates the game's jump physics (max height 252 units, flat jump about 300 across, platforms solid from below) and walks the level graph from the start:
every platform, coin and goal must be reachable. It explains each problem in plain words, for example
`platform "sky ledge" is 470 above "ground" but the player jumps at most 244`.

Repairs happen in two layers (`lib/fix-level.mjs`):
- **AI**: Muse Spark gets the level and the problem list and returns a minimally edited level plus a list of changes. It runs at low reasoning effort (about 25 s) and its answer is re-checked; anything that is not better is discarded.
- **Auto**: a deterministic fallback that adds small stepping platforms until everything is reachable. It never moves drawn objects and runs in milliseconds.

Try it: `levels/impossible.json` has a ledge 470 units up, a coin in the sky and an island too far away.

```bash
node check.mjs levels/impossible.json            # report
node check.mjs levels/impossible.json --fix      # AI repair -> levels/impossible.fixed.json
node check.mjs levels/impossible.json --fix --no-ai
```

In the Studio, **Playtest it** runs the same check and repair on the current game.

## PlayLab Studio (chat builder, `studio.html`)

After login the Studio opens on a clean first screen: the welcome in the middle (sketch it, upload a drawing, use the camera, example ideas, continue your last game) and one chat box floating at the bottom center. Type, attach, paste or drop a drawing. As soon as you send something the layout becomes the workspace: chat and corrections on the left, the game in the center (a loader covers it until the first level arrives). My games is a drawer behind the menu button. The game page runs inside an iframe in embed mode (`game.html?embed=1`) and receives levels and commands by `postMessage`, so the game code is shared with the phone and big-screen flows.

What works today (steps 1-4 of the Studio plan):
- **Phones as controllers, one room for everything.** "Play with phone" and the camera button open the same QR: the phone that scans after the camera button is the camera, every other phone is a controller. Player 1 drives the main character; players 2 to 4 get their own characters in the preview (their phone's color), and only the one who dies goes back to the start. The phone has restart, pause and sound buttons and shows the level, the coins and whether the game is paused (the game broadcasts a state message on every change). Controller input reaches the game iframe by `postMessage`; `game.html` on its own (big screen, `?screen=1`) uses the same code with its own room.
- **Sketch pad in the chat** (pencil button): draw a level like on paper (pen sizes, eraser, undo, "Last picture" to draw over the game's previous picture), "Use drawing" sends it through the scanner. With an existing level the scan is a re-draw: the diff shows what changed.
- **Camera in the chat**: on a phone the camera button takes a picture with the device camera and builds it. On a computer it opens the phone link: a QR code, the phone (`pad.html`) runs the live paper detection and auto-capture from the big-screen flow, the ink layer previews in the modal, and every scan lands in the chat as a version ("from phone camera", then "redrawn on paper"). Closing the modal keeps the link: the live video shrinks to a corner.
- **Build and change the game by chat.** Muse Spark gets the brief (level format, jump physics, design rules), the last chat turns and the current level, and answers with a function tool: `create_level`, `edit_level` (full updated level, unchanged things keep their coordinates) or `playtest_level`. The server validates the objects, runs the instant reachability fix and the page saves the result as a version with the model's own note ("harder: two more spikes"). Per the Meta Model API docs, `tool_choice` is left on `auto` (the only accepted value) and `parallel_tool_calls:false` keeps it to one call per turn. If the Meta API fails, Muse Spark Open on Baseten gets the same brief and answers with a JSON object instead.
- Projects are saved in Supabase (`projects`, `messages`, `versions`). Each browser gets an anonymous owner id (localStorage) sent as the `x-owner` header; row-level security keeps every owner to their own rows. Shared projects (later step) are readable by anyone with the link.
- "My games" drawer, auto-created project on the first message, rename by clicking the title. A reload keeps the game you are on; a new visit starts on the first screen with a Continue button.
- Attach a picture or drawing: it goes through the existing `/api/scan` and lands in the preview as a new version.
- **Pictures become a level, the player or an object.** Every attached picture has a toggle: **Auto**, **Level**, **Player** or **Object**. Words decide too ("use this as my player", "make this the enemy", "these are the coins"). On Auto, Muse Spark looks at the picture first (`api/art` classify, 1 credit): a level drawing goes to the scanner as before; a character or a single object is redrawn by **Muse Image 1.0** as a clean game sprite (`api/art` sprite, `POST /v1/images/edits` with the picture as the reference, 15 credits, refunded on failure). Muse Image has no transparent output, so it draws on flat white and `shared/cutout.js` cuts it out. A character becomes the player (`projects.art.player`); an object becomes the sprite every enemy, coin, goal, spike or decoration wears (`projects.art.sprites`). "As is" skips Muse Image and cuts out the original picture (free), and so does a failed Muse Image call. **Add your character** on the first screen does the player in one click; "use the default player" switches back.
- "Playtest it" runs the playtest agent (`/api/fix`) and shows what it changed.
- Every level change is a version: History lists them, Undo restores the previous one (as a new version, nothing is lost).
- Word-by-word streaming, typing indicator, quick chips, example prompts. On phones the chat is full screen with a Preview tab.

Endpoints (all keyed by the `x-owner` header, keys stay on the server):

| Endpoint | What it does |
| --- | --- |
| `GET/POST/PATCH/DELETE /api/projects` | List, create, update (a `level` in a PATCH also adds a version), delete |
| `GET/POST /api/messages` | Chat history of a project |
| `GET /api/version?project_id=&n=` | One saved version |
| `POST /api/agent` | The game agent: `{ message, level?, history? }` -> `{ reply, level?, kind, note, diff, playtest, actions }` (`lib/agent.mjs`) |

Schema: `db/schema.sql` (run it in the Supabase SQL editor once). Uses the same `SUPABASE_URL` / `SUPABASE_ANON_KEY` as the phone relay.

Still to come: art and UI kits (Muse Image + SAM 3.1), 3D modes, share links and remix.

## Accounts and access (private beta)

PlayLab is invite-only. Visitors can join the waitlist on the landing page and play shared games; creating games needs an approved account.

- **Waitlist** (`api/waitlist.js`): name, email, game idea, optional source. Validated on the server, a hidden honeypot field for bots, 5 sign-ups per IP per hour plus a global hourly cap (in the database, IPs stored only as salted hashes), a repeated email gets its existing position back.
- **Who may have an account**: a trigger on Supabase's `auth.users` refuses to create any account whose email is not approved on the waitlist, not in `ADMIN_EMAILS`, and not created by an admin. Sign-ups are closed by the database itself, so Supabase's "Allow new users to sign up" switch can stay on (approved people need it for their first email-link login).
- **Login** (`login.html`): email link, Google (shown when enabled in Supabase), or username + password for demo accounts (stored as `<username>@demo.playlab.invalid`).
- **Every private or paid API call** goes through `requireUser()` in `lib/auth.mjs`: the token is checked with Supabase Auth, then the profile is read from the database. No login: 401. Suspended, banned, expired demo or no profile: 403 with the reason, and the page signs out and explains.
- **Roles**: `user` / `admin`, stored in `profiles` and only changeable by an admin (checked inside the database). The first admin comes from `ADMIN_EMAILS`.
- **Phones need no account**: in the Studio and on the big screen the phone sends its picture to the logged-in computer, which runs the scan and sends the result back.
- **Server key**: a few server-only database functions (waitlist inserts, rate limits, admin sync, test accounts) require `PLAYLAB_SERVER_KEY`; the database stores only its SHA-256. It never reaches a page.

**Credits** (`lib/credits.mjs`, `db/004_credits.sql`): every AI call costs credits, charged in one database transaction before the call (`public.charge`: price × model multiplier, rounded up; balance; optional daily limit; ledger row) and refunded automatically when the AI call fails.

| Action | Credits | When |
| --- | --- | --- |
| `create_2d` | 10 | a chat turn with no game yet |
| `edit_2d` | 2 | a chat turn on an existing game |
| `scan` | 8 | a photo, sketch or camera picture of a level |
| `classify` | 1 | Muse Spark looks at a picture sent on Auto (level, character or object) |
| `art` | 15 | Muse Image draws a player or object sprite (model `muse-image-1.0`) |
| `playtest` | 3 | only when the level needs the AI repair (free when it is already fine; refunded when the instant fix is used instead) |

Models: Muse Spark 1.3 ×1 (default), 1.2 ×0.8, 1.1 ×0.6, Muse Spark Open on Baseten ×0.5 (live re-scans from the phone use it). Replies that need no AI are free. A short balance answers 402 before any AI call, and the Studio shows the price of each action next to its button. Prices and multipliers are edited in the admin panel; `GET /api/costs` is the public price list.

Database: `db/schema.sql` (games), then `db/002_accounts.sql`, `db/003_server_users.sql`, `db/004_credits.sql`, `db/005_admin.sql` and `db/006_sprites.sql` in the Supabase SQL editor.

## Admin panel (`admin.html`)

Admins open it from the account menu in the Studio (**Admin panel**) or the **Admin** button on the profile page. Everyone else gets "Admins only": `api/admin.js` checks the role, and every database function checks it again.

- **Overview**: people waiting for approval, accounts, credits used today / 7 days / 30 days, credits held by users, a 14-day chart of credits used (hover a day for the numbers), usage by action and by model, top users.
- **Waitlist**: pending / approved / rejected, search, approve with starting credits, reject (also pauses an existing account), mark invited. PlayLab does not send invites: **Copy invite** gives you the text to send.
- **Users**: search, real or demo accounts, give or take credits for several users at once (with a reason, written to their credit history), and per user: status (active / suspended / banned), role, daily credit limit, access end date, set a password, their usage, delete. Admins cannot pause, demote or delete themselves. **New user** creates email or username accounts, including demo accounts for judges.
- **Credits & usage**: every credit movement for everyone, filtered by action or user.
- **Prices & models**: the credit price of each action, each model's multiplier, which models are on, and the default model.
- **Activity**: every change made from the panel, by whom.

## Run it locally

```bash
cp .env.example .env              # put your Meta Model API key in MODEL_API_KEY
npm run dev                       # prints http://localhost:3000/ and http://<your-LAN-ip>:3000/
npm run dev:https                 # same on https://...:3443/ (needed for the phone camera on your LAN)
```

Open the LAN address on your phone (same Wi-Fi). If Windows asks, allow Node on private networks.
The dev server runs `api/*.js` the same way Vercel does. Restart it after editing files in `lib/` or `shared/` (Node caches those modules).

Other commands:

| Command | What it does |
| --- | --- |
| `node scan.mjs photos/level1.jpg` | Scan a photo from the terminal -> `levels/level1.json`, runs the playtest agent, refreshes `levels/index.json` |
| `node scan.mjs photos/level1b.jpg --previous levels/level1.json` | Re-scan an edited drawing and print what changed |
| `node scan.mjs --mock` | Fake scan from `levels/sample.json`, no API call |
| `node check.mjs <level.json> [--fix]` | Playtest report, optional repair |
| `npm test` | Unit checks: level normalizer, image parsing, reachability and auto-fix |
| `npm run playtest` | Headless Chrome drives the game through 36 checks (needs `npm run dev` running) |
| `npm run test:auth` | Waitlist, approval gate, logins, roles, blocked accounts and row-level security against the real Supabase project (needs `npm run dev`) |
| `npm run test:db` | Round trip against the real Supabase tables as two throwaway accounts |
| `node tests/credits.test.mjs` | Prices, multipliers, the atomic charge, refunds, daily limits, parallel charges, admin grants and one real AI call (needs `npm run dev`) |
| `npm run test:arena` | Headless Chrome drives `arena.html`: waves, walking, shooting, the three views, death, restart, a level file (needs `npm run dev`) |
| `npm run test:admin` | The admin API against the real Supabase project with a throwaway admin and user: access, credits, limits, suspend, passwords, accounts, waitlist, prices, models, activity (needs `npm run dev`) |
| `npm run test:studio` | Headless Chrome drives `studio.html`: chat, saved projects, versions, undo, sketch pad, reload, mobile tabs (needs `npm run dev` and Supabase) |
| `node tests/studio-camera.test.mjs` | Two headless Chromes: the Studio camera link and a phone with the synthetic sheet, level lands in the chat (needs the dev server and the PeerServer or the relay) |

Controls: arrows / WASD to move, space / up / W to jump (hold for a higher jump), stomp enemies from above, R restarts, M toggles sound, G switches between your drawn art and simple shapes. Phones get on-screen buttons in landscape.

## Deploy to Vercel

The repo is ready: `vercel.json` gives the scan function 60 s and the fix function 120 s, `.vercelignore` skips dev files.

**From the dashboard (easiest, auto-deploys on every push):**

1. Go to https://vercel.com/new and import `Achraf-ghazouani/sakanfarPlaylab` from GitHub.
2. Framework Preset: **Other**. Leave Build Command and Output Directory empty (the root is served as static files, `api/` becomes functions).
3. Open **Environment Variables** on that same screen and add:
   - `MODEL_API_KEY` = your Meta Model API key (required)
   - `BASETEN_API_KEY` = optional second provider (Muse Spark open weights on Baseten), used as a fallback if Meta fails. `BASETEN_BASE_URL` and `BASETEN_MODEL` default to `https://inference.baseten.co/v1` and `meta-models/muse-spark-open-1026`. That model always reasons; the client strips the reasoning and keeps only the answer.
   - `AI_PROVIDER` = `meta` (default) or `baseten` to make Baseten the primary
4. Click **Deploy**. Open the `https://....vercel.app` URL on your phone.

To change a variable later: Project -> Settings -> Environment Variables, then Deployments -> Redeploy.

**From the terminal (no install needed, npx fetches the CLI):**

```bash
npx vercel login
npx vercel link                                  # pick your account, create project "sakanfar-playlab"
npx vercel env add MODEL_API_KEY production      # paste the key when asked; repeat with "preview" if you want preview deploys to work
npx vercel --prod
```

If a deploy fails with "pattern ... doesn't match any Serverless Functions", check that `api/*.js` was not excluded by `.vercelignore` (patterns there follow gitignore rules, so keep them anchored with a leading `/`).
If it complains that `maxDuration` exceeds your plan, lower the value for `api/fix.js` in `vercel.json` to 60.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Landing page (retro arcade, code-drawn pixel world): Start creating, Play a demo, how it works in three steps, playable levels, the waitlist |
| `game.html` | The game (Phaser 3 arcade physics, colored shapes, touch controls, drawing thumbnail, agent toast); `?embed=1` for the Studio preview, `?screen=1` for the big screen; opened on its own it is a clean full-screen player for the demo levels |
| `studio.html` | PlayLab Studio: centered chat box first, then chat on the left and the game in the center, My games drawer, versions, history, undo (login required) |
| `login.html`, `profile.html` | Login (email link, Google, username), profile with credits, credit history and games |
| `admin.html`, `api/admin.js`, `db/005_admin.sql` | Admin panel: overview, waitlist, users, credits and usage, prices and models, activity |
| `api/waitlist.js`, `api/me.js`, `lib/auth.mjs`, `shared/auth.js` | Waitlist, the logged-in account, server-side access checks, the browser's login helper |
| `db/002_accounts.sql`, `db/003_server_users.sql` | Waitlist, profiles, credit ledger, approval trigger, admin and server functions |
| `api/projects.js`, `api/messages.js`, `api/version.js` | Vercel functions for saved games (Supabase through PostgREST, `lib/db.mjs`) |
| `api/agent.js`, `lib/agent.mjs` | The Studio game agent: Muse Spark function tools, validation, quick fix, Baseten fallback (`node tests/agent.live.mjs` runs it for real) |
| `db/schema.sql` | Supabase tables, row-level security and functions for the Studio |
| `pad.html` | Phone controller page (joins a room by QR / code) |
| `shared/phonelink.js` | PeerJS host (game) and client (pad): rooms, slots, heartbeat, reconnect |
| `api/scan.js` | Vercel function: base64 photo -> validated, quick-fixed level JSON |
| `api/fix.js` | Vercel function: level JSON -> AI-repaired level JSON |
| `shared/reach.mjs` | Reachability checker + algorithmic fixer (pure JS, used by server and pages) |
| `shared/diff.mjs` | What changed between two scans of the same drawing (added / removed / moved) |
| `shared/photo.js` | Browser photo resize helper used by index.html and game.html |
| `shared/cutout.js` | A picture -> a transparent sprite (background removed, trimmed, 256 px WebP) |
| `api/art.js`, `lib/image.mjs` | Pictures: Muse Spark classifies (level / character / object), Muse Image 1.0 draws the sprite |
| `assets/` | The Sakanfar PlayLab logo (`logo.webp`), the mark for top bars (`mark-256.webp`), favicons; `logo-source.webp` is the original |
| `arena.html`, `shared/arena.mjs` | The arena shooter engine (three.js) and its format, reachability check, fix and word-based generator |
| `shared/view3d.js` | The 3D view: mirrors the running Phaser scene into three.js every frame |
| `shared/inkart.js` | Drawn art: cuts every object out of the level's picture and keys out the paper |
| `lib/fix-level.mjs` | Playtest agent orchestration: AI repair, validation, auto fallback |
| `lib/ai.mjs` | OpenAI-compatible chat client for Meta (default) and Baseten |
| `lib/scan-level.mjs` | Scan prompt, JSON extraction, level normalization, image size / EXIF |
| `serve.mjs` | Dev server: static files + `/api` emulation + LAN address |
| `scan.mjs`, `check.mjs` | Terminal tools |
| `levels/`, `photos/` | Demo levels (`sample`, `level1` from a real photo, `impossible` + its AI-fixed version) |
| `tests/` | `npm test` and `npm run playtest` |

## Level JSON

```json
{ "theme": "desert cactus canyon",
  "aspect": 1.333,
  "objects": [ { "type": "platform", "label": "ground line", "x": 0, "y": 900, "w": 1000, "h": 30 } ],
  "checked": true,
  "fixes": ["added a step under 'sky coin' at x470 y350"] }
```

Coordinates are on a 1000 x 1000 grid, y goes down, `x,y` is the top-left corner.
`aspect` is the photo's width / height; the game stretches the grid by it so the level keeps the paper's proportions.
Types: `start`, `goal`, `platform`, `moving_platform`, `coin`, `enemy`, `spike`, `decoration`.
The server guarantees exactly one start, at least one goal, at least one platform, every number inside the grid, and unknown types become `decoration`.
`checked` and `fixes` are added by the playtest agent; `diff` is added when a scan was a re-scan of an edited drawing (`POST /api/scan` with `previous`).

## Rules we follow

- `.env` is git-ignored and never uploaded. The browser only ever talks to `/api/scan` and `/api/fix`.
- Everything here was written during the hackathon.
