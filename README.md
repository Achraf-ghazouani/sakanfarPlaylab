# Sakanfar PlayLab

Draw a 2D platformer level on paper, or describe it in a chat, and Meta's Muse Spark turns it into a playable browser game.
Free drawings, not strict symbols: a cactus becomes an enemy, a cloud becomes a moving platform.
A playtest agent then checks every jump and repairs impossible parts, so the level is always beatable.

Built solo for the Meta hackathon (Oct 30 - Nov 4, 2026). Plain HTML/JS + Phaser 3 from a CDN, no build step, no dependencies.

## The flow

1. `index.html`: the landing page. **PRESS START** opens the Studio.
2. `studio.html`, the Studio: a chat next to the live game. Describe a game and Muse Spark builds it (`POST /api/agent`). Attach a drawing, sketch one on the pad, or take a picture with the phone camera, and the scanner reads it. On a computer, link your phone camera with the QR code and point it at the paper: live detection, auto-capture, re-scans while you draw. Every change is a saved version with undo.
3. `POST /api/scan`: Muse Spark reads the picture (the browser resizes it to a 1600px JPEG) and returns level JSON. The playtest agent checks reachability and applies an instant fix if needed.
4. "Playtest it" calls `POST /api/fix`: Muse Spark repairs the level with minimal edits (add a step, lower a ledge).
5. `game.html`: plays the level, inside the Studio preview or full screen with touch controls, the phone controller and the big-screen mode (`game.html?screen=1`).
6. **Live edit by redrawing**: change the paper (add a bridge, erase a spike) and scan it again. The scan gets the earlier level as context, `shared/diff.mjs` works out what changed, new things pop into the running level, the player stays where they were, and the chat says "+1 platform, +1 coin".

## Big screen mode (PC + phone, one QR)

Click **Get started on the big screen** on the landing page (or open `game.html?screen=1`). The PC shows a QR code
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

In `viewer.html`, pick a level: unreachable things get a red dashed outline, and the "Playtest + fix with AI" button repairs them live.

## PlayLab Studio (chat builder, `studio.html`)

Chat on the left, the live game on the right. The game page runs inside an iframe in embed mode (`game.html?embed=1`) and receives levels and commands by `postMessage`, so the game code is shared with the phone and big-screen flows.

What works today (steps 1-4 of the Studio plan):
- **Phones as controllers, one room for everything.** "Play with phone" and the camera button open the same QR: the phone that scans after the camera button is the camera, every other phone is a controller. Player 1 drives the main character; players 2 to 4 get their own characters in the preview (their phone's color), and only the one who dies goes back to the start. The phone has restart, pause and sound buttons and shows the level, the coins and whether the game is paused (the game broadcasts a state message on every change). Controller input reaches the game iframe by `postMessage`; `game.html` on its own (big screen, `?screen=1`) uses the same code with its own room.
- **Sketch pad in the chat** (pencil button): draw a level like on paper (pen sizes, eraser, undo, "Last picture" to draw over the game's previous picture), "Use drawing" sends it through the scanner. With an existing level the scan is a re-draw: the diff shows what changed.
- **Camera in the chat**: on a phone the camera button takes a picture with the device camera and builds it. On a computer it opens the phone link: a QR code, the phone (`pad.html`) runs the live paper detection and auto-capture from the big-screen flow, the ink layer previews in the modal, and every scan lands in the chat as a version ("from phone camera", then "redrawn on paper"). Closing the modal keeps the link: the live video shrinks to a corner.
- **Build and change the game by chat.** Muse Spark gets the brief (level format, jump physics, design rules), the last chat turns and the current level, and answers with a function tool: `create_level`, `edit_level` (full updated level, unchanged things keep their coordinates) or `playtest_level`. The server validates the objects, runs the instant reachability fix and the page saves the result as a version with the model's own note ("harder: two more spikes"). Per the Meta Model API docs, `tool_choice` is left on `auto` (the only accepted value) and `parallel_tool_calls:false` keeps it to one call per turn. If the Meta API fails, Muse Spark Open on Baseten gets the same brief and answers with a JSON object instead.
- Projects are saved in Supabase (`projects`, `messages`, `versions`). Each browser gets an anonymous owner id (localStorage) sent as the `x-owner` header; row-level security keeps every owner to their own rows. Shared projects (later step) are readable by anyone with the link.
- "My games" sidebar, auto-created project on the first message, rename by clicking the title, reload reopens the last game.
- Attach a picture or drawing: it goes through the existing `/api/scan` and lands in the preview as a new version.
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

Database: `db/schema.sql` (games), then `db/002_accounts.sql` and `db/003_server_users.sql` in the Supabase SQL editor.

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
| `npm run test:studio` | Headless Chrome drives `studio.html`: chat, saved projects, versions, undo, sketch pad, reload, mobile tabs (needs `npm run dev` and Supabase) |
| `node tests/studio-camera.test.mjs` | Two headless Chromes: the Studio camera link and a phone with the synthetic sheet, level lands in the chat (needs the dev server and the PeerServer or the relay) |

Controls: arrows / WASD to move, space / up / W to jump (hold for a higher jump), stomp enemies from above, R restarts, M toggles sound. Phones get on-screen buttons in landscape.

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
| `index.html` | Landing page (retro arcade, code-drawn pixel world): PRESS START opens the Studio, Discover shows the demo levels |
| `game.html` | The game (Phaser 3 arcade physics, colored shapes, touch controls, drawing thumbnail, agent toast); `?embed=1` for the Studio preview |
| `studio.html` | PlayLab Studio: chat + live preview, My games, versions, history, undo (login required) |
| `login.html`, `profile.html`, `credits.html` | Login (email link, Google, username), profile with credit history, credits placeholder |
| `api/waitlist.js`, `api/me.js`, `lib/auth.mjs`, `shared/auth.js` | Waitlist, the logged-in account, server-side access checks, the browser's login helper |
| `db/002_accounts.sql`, `db/003_server_users.sql` | Waitlist, profiles, credit ledger, approval trigger, admin and server functions |
| `api/projects.js`, `api/messages.js`, `api/version.js` | Vercel functions for saved games (Supabase through PostgREST, `lib/db.mjs`) |
| `api/agent.js`, `lib/agent.mjs` | The Studio game agent: Muse Spark function tools, validation, quick fix, Baseten fallback (`node tests/agent.live.mjs` runs it for real) |
| `db/schema.sql` | Supabase tables, row-level security and functions for the Studio |
| `pad.html` | Phone controller page (joins a room by QR / code) |
| `shared/phonelink.js` | PeerJS host (game) and client (pad): rooms, slots, heartbeat, reconnect |
| `viewer.html` | Debug: AI boxes over the photo, reachability report, fix button |
| `api/scan.js` | Vercel function: base64 photo -> validated, quick-fixed level JSON |
| `api/fix.js` | Vercel function: level JSON -> AI-repaired level JSON |
| `shared/reach.mjs` | Reachability checker + algorithmic fixer (pure JS, used by server and pages) |
| `shared/diff.mjs` | What changed between two scans of the same drawing (added / removed / moved) |
| `shared/photo.js` | Browser photo resize helper used by index.html and game.html |
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
