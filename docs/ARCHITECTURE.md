# Sakanfar PlayLab: how it is built

The deep end of the README: how every part works, the API, the database, the phone links, the AI calls and what we learned about the Meta Model API. Start with the [README](../README.md) for the pitch and the tour.

## The shape of it

```
browser pages (plain HTML/JS, no build step)                 Vercel serverless functions (api/*.js, 10 of them)
  index.html   landing, waitlist                                agent     plan / code (streamed build) / fix / look  (Muse Spark, Muse Wonder)
  demo.html    the three example games, in the sandbox          art       classify / sprite / cutout (Muse Spark, Muse Image, SAM 3.1)
  studio.html  the chat builder (login)                         play      /play/<id> pages, explore, likes, reports, remix
  pad.html     the phone: controller, camera                    projects, messages   saved games, versions, chat
  explore.html published games                                  me, costs, config    the account, prices, public config
  admin.html   the admin panel                                  waitlist, admin      the private beta and the panel
  login.html, profile.html
        |  every game runs in a sandboxed iframe (no origin, strict CSP) with shared/playlab-sdk.js inside
        |
  PeerJS (WebRTC) or Supabase Realtime              Meta Model API (api.meta.ai/v1)          Supabase (Postgres + Auth)
  phone <-> computer, no server in between          Muse Wonder, Muse Spark, Muse Image, SAM  row-level security everywhere
```

Rules: keys stay in `.env` / Vercel and never reach a page; every paid or private API call goes through `requireUser()`; Vercel's Hobby plan allows 12 functions, so endpoints share files (`/api/build-code` is a rewrite to `api/agent.js`, versions are `GET /api/projects?id=&version=n`).

PlayLab started with two classic engines (a Phaser platformer built from drawings and a three.js arena shooter). They are retired: every game is now written as code. Older saved games made with them open on a card that offers to rebuild them with AI code.

## Any game from a prompt

**The plan** (`lib/code.mjs planGame`, Muse Spark 1.3, structured output, 10-17 s, free). Title, genre, engine (`canvas` | `phaser` | `three`), goal, controls, the phone controller layout, win and lose, entities, AI opponents, levels, players (1-4), what stays simple, and `picture` when a picture was sent (what it shows, precisely enough to rebuild it: for a drawn map or track the shape and where walls, paths, start and goal are). The Studio's **2D | 3D** switch decides the engine: 3D asks for three.js, 2D for Phaser or canvas. The plan shows as a card with **Go, build it** and **Make it simpler** chips; any other message changes the plan (free) and "go" builds it.

**The build** (`POST /api/build-code`, a rewrite to `api/agent.js task:"code"`; Muse Wonder 1.0, streamed, 40-130 s). Charged first (`code_create_2d` 20, `code_create_3d` 30, refunded when the model fails), then the answer streams back as Server-Sent Events (`start`, `progress` with the characters and lines so far, `done` with the file, or `error`) into the thinking panel. The system prompt (`lib/code.mjs systemPrompt`) carries the runtime rules, the exact library addresses (Phaser 3.80.1 on cdnjs, three.js 0.160.0 on jsdelivr with its import map, cannon-es), the PlayLab SDK reference (with how to load a picture, a GLB or an FBX), the rules of a PlayLab game and three complete example games (`shared/code-examples.mjs`: a canvas snake, a Phaser star catcher, a three.js ring flight) that the SDK test runs through the sandbox and `demo.html` shows on the landing page. The model answers with one HTML file whose second line is a `<!-- playlab {note, built, missing} -->` comment: the notes become the version name and the reply.

**The level** (`projects.level` with `genre: "code"`): `engine`, `title`, `theme`, `note`, `prompt`, `plan`, `html`, `notes` and an empty `objects` list, validated by `lib/code.mjs validateCodeLevel` (size, a clean scan). The projects API saves nothing else.

**The sandbox** (`shared/coderun.mjs`, the host; `shared/codescan.mjs`, the rules). The game runs in the preview iframe with `sandbox="allow-scripts"` and no `allow-same-origin`: an opaque origin, so no cookies, storage, login token or parent page. The host wraps the file with a strict Content Security Policy (scripts and connections only from cdnjs, jsdelivr and unpkg; images from data and blob URLs; no frames, forms, objects or navigation) and the SDK script, after a scan that names forbidden APIs (cookies, storage, parent, eval, network calls, outside addresses) before anything runs; the server runs the same scan before saving. The SDK talks to the host only through `postMessage` with the fixed `playlab:*` messages.

**The PlayLab SDK** (`shared/playlab-sdk.js`, `window.PlayLab` inside every game). One input API for the keyboard, mouse, touch and up to four phones (`input.axis`, `button`, `pressed`, `aim`, `pointer`, `players()`); the host's pause / resume / restart / mute (`onPause`, `onResume`, `onRestart`, `onMute`, `paused`); `start()` and `gameOver({ win, score })`; `controller({ type })` so the phones show the right pad; `event()` for vibration and a short synthesised sound; `assets.get(role)` for the person's own pictures and models (written into the page before the SDK); a small HUD (`hud.set`); `screenshot()`; `playlab:tap` presses the page where asked. It reports `ready` after the first frames, `state` every half second, exceptions, failed loads, policy blocks and a blank canvas (seen twice, late canvases and DOM games allowed) to the host.

**The self-healing loop** (the Studio's `buildCode`, `smokeTest`; `api/agent.js task:"fix"`; `lib/code.mjs repairGame`). Every build, change and fix goes through the same gate before it is saved: the scan, then the sandbox with a **smoke test**: first frames within 12 s, no exception and no blank canvas for 6 s, the screen changes after a second of test input (right on the d-pad and the stick, the A button, a tap in the middle), and a restart from the menu brings the game back to playing. A failure (the error with its line and stack, the blank reason, the scan's refusal) goes back to Muse Wonder for a fix, up to three times; a game that runs but did not react to the test input gets one such try and is then accepted and said so. Fixes are free: the paid build hands the page a token signed with the server key (`makeFixToken`, 20 minutes, the attempt count inside, a new token with each fix), so a fix can only follow a paid build and never more than three times.

**The vision check** (`task:"look"`, `lib/code.mjs lookAtGame`, Muse Spark 1.3 with the screenshot). After a passing smoke test, a 640 px screenshot goes to Muse Spark with the request and the plan: a match from 0 to 1, what the screen shows, problems and one suggestion (rate limited per account, token-bound). Under 0.5 the Studio runs **one improvement round** through the fix channel and keeps it only if it passes the smoke test.

**Edits as patches** (`lib/code.mjs changeGame`, `parsePatches`, `applyPatches`). Words on a game ("make the apples blue") send the current file and the change to Muse Wonder, which answers with search / replace blocks and a `NOTES` line instead of the whole file: about 4 s and a few hundred tokens instead of a minute, and nothing else in the game moves (`code_edit`, 6 credits). Each SEARCH must match the current file exactly once, exactly or line by line ignoring indentation. When a block does not fit, the patched file fails the scan or nothing changed, the whole file is asked for instead under the same charge, and the panel says so. Fixes go the same way. Every change is a version ("Patched 2 places (+3 -1 lines)"); History and Undo restore any version (a restore is a new version). A change that still fails after three fixes is **not saved**: the version that worked is mounted again and the reply says so, with a chip to try again.

**Honesty.** The reply states what was built, what is missing, that it failed at first and was fixed (or only tried), that it did not react to the test input, and what the look saw. A first build that still fails after three fixes is saved marked "(not running)" so the person can read it, with chips to write it again or plan a simpler version. A game is never called working when the smoke test did not pass. The nine test prompts of the brief (racing with laps and AI cars, match-3, tower defense, endless runner, flight through rings, 2-player soccer, snake, a dungeon crawler with keys and doors, memory cards) all pass live through the Studio: `tests/anygame-results.md`.

## Pictures and models

Every attached picture has a toggle (**Auto**, **Level**, **Player**, **Object**, **UI**, **Asset**) and the words win ("use this as my player", "make this the enemy", "this is my pause button"). On Auto, `shared/assetcheck.js` reads the pixels first (transparency, size and aspect, a grid of cells, a frame border, paper with pen strokes, a wide scene); a sure guess costs nothing, anything else goes to Muse Spark (`api/art.js task:"classify"`) with those facts as hints, and when the model is not sure either the chat asks with chips. The roles (`ASSET_ROLES` in `lib/image.mjs`): `level`, `player`, `enemy`, `collectible`, `hazard`, `goal`, `texture`, `tileset`, `spritesheet`, `background`, `decoration`, and the UI ones (`ui_button`, `ui_panel`, `ui_hud`, `ui_icon`, `ui_logo`, `ui_cursor`, `ui_font`, `ui_mockup`).

- **A drawing, a photo or a camera shot** (role `level`, or any picture on a new game) goes to the plan: Muse Spark reads it and the code is built around it. On a game already written, Muse Spark describes it against the game's plan and Muse Wonder improves the game with it (a patch). A rough drawing is an idea to improve on, not a blueprint.
- **A character or an object** is redrawn by Muse Image 1.0 as a clean sprite (`task:"sprite"`), cut out of its flat white background for free (`shared/cutout.js`), or, with "as is", cut out of your own picture by SAM 3.1 (`task:"cutout"`, `lib/segment.mjs`, the mask decoded with Meta's `@meta-sam/parser`). It is saved as `projects.art.player` or `art.sprites[role]`.
- **Backgrounds, textures, tilesets, sprite sheets and UI pieces** are saved as `projects.art.assets[]` with their role, hint, size and grid.
- **A `.glb`, `.gltf` or `.fbx`** (up to 1.8 MB) is saved as `projects.art.model` (the player, or an enemy when the words say so) and makes the game 3D.

Everything saved reaches the game through `PlayLab.assets.get(role)`; on a game already written, Muse Wonder puts it in right away (a patch that loads it, with the drawn shape as the fallback; models with three's GLTFLoader or FBXLoader). Several files at once (a drop, a paste or a ZIP read by `shared/zip.js`) open the review grid: each file with its guessed role, **Apply all**, one "Detected" card.

## Phones

**Phone as controller.** The Studio and the play page show a QR code and a 4-letter room code; scanning opens `pad.html?room=CODE`. Transport: WebRTC data channels through PeerJS (`shared/phonelink.js`: rooms, slots, a heartbeat, the phone redials by itself); if WebRTC has not connected within 5 s, a relay over **Supabase Realtime Broadcast** takes over. A game asks for its controls with `PlayLab.controller({ type })`; its state carries the layout to every phone, and the pad switches to it: `dpad+jump` (a 4-way d-pad and JUMP), `dpad+2buttons`, `stick+2buttons`, `stick+fire` (move and aim sticks, FIRE), `steering+gas+brake`, `tap` (a pad that sends where it was tapped). The phone sends the same few messages whatever the layout (input with up and down, jump for A, fire for B, stick, tap, menu) and one route (`shared/padroute.mjs`) turns them into the SDK's `playlab:*` messages; a phone that leaves releases everything it held. The pad shows the game's title, score, lives, lap, timer and state, has Restart / Pause / Sound, and vibrates on game events. Up to four phones, each a player the game reads with `PlayLab.players()`.

**Phone as camera** (`shared/paper.js`, no OpenCV). The phone finds a sheet of paper in every frame, captures it when still, flattens it with a 4-point homography and sends the picture to the computer, which reads it into AI code like any picture (a plan, or an improvement of the open game). Phone cameras need HTTPS: the live site has it; on a LAN, `npm run dev:https`.

## The Studio

`studio.html` opens on a clean first screen (sketch it, upload a drawing, use the camera, add your character, continue your last game) with one chat box at the bottom center; the first message turns it into the workspace, chat left and the game in the center, My games in a drawer. The chat box has the **2D | 3D** switch (locked to the engine of a game already written), the **AI code** label (always on: every game is code), the clip, the **sketch pad** (2D games only: in 3D it says to switch to 2D) and the camera. Over a running game, a **Restart / Pause / Sound** bar drives the SDK menu. The thinking panel lists every step of a call as it happens, each with the Meta model doing it. Projects, messages and versions live in Supabase and belong to the login.

## Languages

`shared/i18n.js` carries the Studio's chrome, the phone pad and the landing page in English, French and Arabic. Static text wears `data-i18n="key"` (and `data-i18n-placeholder` / `-title` / `-data-prompt`); pages call `I18N.t(key, vars)` for the rest. The language comes from `localStorage` (`playlab.lang`), else the browser; Arabic sets `html[dir=rtl]`. The plans and replies follow the language the person writes in; the code stays English. Not translated: the admin panel, the play page and the thinking panel's step names.

## Accounts, credits, the cap

PlayLab is invite-only. The waitlist (`api/waitlist.js`) validates on the server, has a honeypot field and rate limits (IPs stored only as salted hashes). A trigger on Supabase's `auth.users` refuses any account whose email is not approved, not in `ADMIN_EMAILS` and not created by an admin. Logins (`login.html`): email link, Google when enabled, or username + password for demo accounts. `requireUser()` (`lib/auth.mjs`) checks the token and the profile: no login 401; suspended, banned or expired 403 with the reason. A few server-only functions (`srv_*`) need `PLAYLAB_SERVER_KEY`; the database stores only its SHA-256.

**Credits** (`lib/credits.mjs`, `db/004_credits.sql`): a paid call is charged in one database transaction before it runs (`public.charge`: price x model multiplier, balance, optional daily limit, ledger row) and refunded automatically when the call fails. A short balance answers 402 before any AI call. Prices are edited in Admin → Prices & models; `GET /api/costs` is the public list.

| Action | Credits | When |
| --- | --- | --- |
| `code_create_2d` / `code_create_3d` | 20 / 30 | Muse Wonder writes a 2D / 3D game |
| `code_edit` | 6 | a change to a game (a patch), and a remix |
| `classify` | 1 | Muse Spark looks at a picture sent on Auto |
| `art` | 15 | Muse Image draws a player or object sprite |
| `cutout` | 1 | SAM 3.1 finds the subject of a picture kept "as is" |
| plans, fixes, looks | free | the plan before a build; the fixes and the look that follow a paid build |

The older rows (`create_2d`, `edit_2d`, `scan`, `playtest`...) belong to the retired engines and are no longer charged.

**Shared daily cap** (`db/010_cap.sql`): in Admin → Overview the admin sets how many credits everyone together may use per UTC day (0 = no cap). When it is reached, a regular user's paid action is refused with `global_cap` and nothing is charged; the Studio shows a note until midnight UTC; admins are never blocked.

## Publish, share, remix

**Publish** (Studio top bar): title, description, a cover (a screenshot from the SDK, or a picture), public or unlisted. The game gets an 8-character id and lives at `/play/<id>` (`vercel.json` rewrites it to `api/play.js`, which renders the page with Open Graph tags; `shared/play.js` runs it): the code runs in the same sandbox with the person's pictures, Restart and Pause on the page, phones through the same route, plays counted, likes, reports, a Share sheet (copy, Web Share, QR) and **Remix in Studio** (a copy with the code and the art, charged as one change). Published games are kind `code` (`db/012_code_kind.sql`). `explore.html` lists public games (trending, newest, featured, search). Plays, likes and the featured flag can only be changed by the game's own database functions. Admins feature, unpublish, make public, delete, and close reports.

## The admin panel

`admin.html` + `api/admin.js`; the role is checked in the API and again inside every database function. Overview (waitlist, accounts, credits used, the shared daily budget, a 14-day chart, usage by action and model, top users), Waitlist, Users (credits, status, role, limits, passwords, **New user** for demo and judge accounts), Credits & usage, Prices & models, Games, Reports, Activity.

## API

All functions set `Cache-Control: no-store`. "Login" means a Supabase access token in `Authorization: Bearer`.

| Function | Routes |
| --- | --- |
| `api/agent.js` | `POST { task: "plan", message, plan?, history?, image?, mode? }` -> `{ plan }` (free); `{ task: "code", plan, prompt, change?, previous_html?, assets? }` (also `POST /api/build-code`) -> a Server-Sent Events stream ending in `done { html, notes, scan, engine, patch, credits, fix }` or `error`; `{ task: "fix", token, plan, prompt, html, report }` -> the same stream (free); `{ task: "look", token, plan, prompt, snapshot }` -> `{ match, looksLike, problems, suggestion }` (free). Login. |
| `api/art.js` | `POST { task: "classify" \| "sprite" \| "cutout", image, ... }` (login) |
| `api/projects.js` | `GET` list, `GET ?id=` (project, messages, versions), `GET ?id=&version=n`, `POST` create or `{ claim }`, `PATCH` update / `{ publish }` / `{ unpublish }`, `DELETE` (login; levels must be games written as code) |
| `api/messages.js` | `GET ?project_id=`, `POST` (login) |
| `api/play.js` | `GET ?id=` (HTML), `&format=json`, `&cover=1`, `&liked=`; `?action=explore&sort&kind&q`; `POST` `played` / `like` / `report` (no login), `remix` (login) |
| `api/me.js` | `GET` (profile, cap; `?ledger=1` adds the credit history), `PATCH` (username, display name, avatar) |
| `api/costs.js` | `GET` prices and enabled models (public) |
| `api/config.js` | `GET` the public Supabase URL and key for the relay and the login (public) |
| `api/waitlist.js` | `POST` a sign-up (public, rate limited) |
| `api/admin.js` | `GET ?action=overview \| waitlist \| users \| ledger \| pricing \| activity \| games \| reports \| settings`, `POST { action: ... }` (admins) |

## Database

Postgres on Supabase, row-level security on every table, `security definer` functions for anything that crosses an account's rows. Run the files in the SQL editor in this order: `db/schema.sql` (projects, messages, versions), `002_accounts.sql` (waitlist, profiles, the approval trigger, admin and server functions, rate limits), `003_server_users.sql` (test and demo accounts), `004_credits.sql` (costs, models, the atomic charge, refunds, grants), `005_admin.sql`, `006_sprites.sql` (classify price, Muse Image model), `007_claim.sql`, `008_publish.sql` (visibility, likes, reports, the public game functions, the counter guard), `009_cutout.sql` (SAM 3.1), `010_cap.sql` (the shared daily cap), `011_code.sql` (the code prices, the Muse Wonder model), `012_code_kind.sql` (the `code` kind for published games).

## What we learned about the Meta Model API

- **Muse Wonder** (`muse-wonder-1.0`, `POST /v1/chat/completions`): the strongest coding model on the Model API, same endpoint and parameters as Muse Spark. `stream: true` sends Server-Sent Events whose chunks carry `choices[0].delta.content`, the last one `finish_reason` and `usage`. A whole game (6-17 KB of HTML) takes 40-130 s at `reasoning_effort: "medium"`; a patch answer about 4 s and a few hundred tokens. ("Muse Code" is a terminal product, not an API model.)
- **Muse Spark** (`muse-spark-1.3`): `tool_choice` accepts only `"auto"`; a `json_schema` response format needs `additionalProperties: false` and every property in `required`; images go as `image_url` parts with data URLs; `reasoning_effort` matters a lot for latency (plans run at `low`, 10-17 s; looks at `low`).
- **Muse Image 1.0** (`POST /v1/images/edits`): a JSON body with `images: [{ image_url }]` (a data URL works), `output_format: "png"`, `response_format: "b64_json"`; responses are always opaque, hence the flat white background and the client-side cutout.
- **SAM 3.1** (`POST /v1/responses`, `sam-3.1`): an `input_text` prompt (a short noun phrase, or SAM's point grammar `<0f>1<|point;x=..;y=..;w=W;h=H|>`) and an `input_image` (data URLs work). The answer is special-token text, one record per object: `<0f>0<|box;...|><|mask;x=0;y=0;data=H,W,!payload|>`; `metadata.mask_encoding: "one_bit"` keeps payloads small, decoded with `@meta-sam/parser`. A box over the whole picture returns the whole picture, so the fallback prompt is a point in the middle. About 1-2 s.
- Transport failures to `api.meta.ai` happen now and then ("fetch failed"): `lib/ai.mjs` retries once and names the cause.

## Run it locally

```bash
cp .env.example .env              # put your Meta Model API key in MODEL_API_KEY
npm run dev                       # http://localhost:3000/ and http://<your-LAN-ip>:3000/
npm run dev:https                 # same on https://...:3443/ (needed for the phone camera on your LAN)
```

`.env` also takes `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the publishable key), `PLAYLAB_SERVER_KEY`, `ADMIN_EMAILS`, optional `PLAYLAB_CODE_MODEL` (default `muse-wonder-1.0`). The dev server (`serve.mjs`) runs `api/*.js` the same way Vercel does, serves `/play/<id>` and `/api/build-code`; restart it after editing `lib/` or `shared/` (Node caches those modules).

### Tests

| Command | What it checks |
| --- | --- |
| `npm test` | Unit: translations, the AI client, the paper detector, pictures (with one live SAM 3.1 call), the code builder (plan, parser, validator, prompt, tokens, patches, the look; a live plan; `PLAYLAB_LIVE_CODE=1` adds a live Muse Wonder build) |
| `npm run test:sdk` | Headless Chrome runs games through the sandbox: the scan and the policy, the three example games with the SDK's ready / state / input / menu / screenshots / taps, and samples that must fail (an exception, a blank canvas, a theft, a run-time reach-out) or pass (a DOM game) |
| `npm run test:studio` | Headless Chrome drives `studio.html` with mocked models: the plan, the build with a crash fixed and a look, the code bar, patches, undo, history, the 2D sketch, pictures and characters into the game, the review grid, a broken change not saved, publish, reload, 3D and a GLB, an older classic game rebuilt, mobile tabs |
| `node tests/studio-camera.test.mjs` | Two headless Chromes over the real phone link: the camera reads a drawing into a plan, then phones play a game written as code (layout, input, menu, two players) |
| `npm run test:pad` | The phone route, then `pad.html` with each layout: the controls shown, what pressing sends, the tap pad, the status line |
| `npm run test:publish-code` / `npm run test:publish` | Publish, `/play/<id>` in the sandbox with the player picture, Restart and Pause, the phone route, Open Graph tags, plays, likes, reports, explore, remix and its charge, admin moderation |
| `npm run test:anygame` | Live: the nine test prompts through the Studio with the real models, results in `tests/anygame-results.md` |
| `npm run run:html -- file.html [--model x.glb]` | One generated game file through the sandbox: ready, layout, state, errors, blank, responds to input |
| `npm run test:assets` | The local picture checks on every sample in `tests/samples/` |
| `npm run test:auth` / `npm run test:db` / `npm run test:admin` / `node tests/credits.test.mjs` | Accounts and row-level security, the tables, the admin API, prices, charges, refunds, limits, the shared cap, one real plan and build |

Every suite that touches Supabase creates its own throwaway accounts and deletes them at the end. Headless Chrome is found at `C:/Program Files/Google/Chrome/Application/chrome.exe` or `CHROME`.

## Deploy to Vercel

`vercel.json` sets the function timeouts (agent 300 s for the streamed builds, art 60 s) and the `/play/:id` and `/api/build-code` rewrites; `.vercelignore` skips dev files and tests. Import the repo at https://vercel.com/new with Framework Preset **Other**, no build command and no output directory, add the environment variables from `.env.example` (at least `MODEL_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PLAYLAB_SERVER_KEY`), deploy. Every push to `main` deploys again. In Supabase, set the Site URL to the live address and add it (plus `http://localhost:3000/**`) to the redirect URLs.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `demo.html` | Landing page (Start creating, Play a demo, Explore, the waitlist) and the three demo games in the sandbox |
| `studio.html` | PlayLab Studio (login): chat, plans, builds, pictures, versions, publish, My games, phones |
| `shared/playlab-sdk.js`, `shared/coderun.mjs`, `shared/codescan.mjs`, `shared/code-examples.mjs` | The SDK inside every game, the sandbox host, the policy and scan, the three example games |
| `lib/code.mjs`, `lib/ai.mjs` | The plan, build, patch, fix and look prompts and calls; the Meta Model API client (streaming, retries) |
| `pad.html`, `shared/padroute.mjs`, `shared/phonelink.js`, `shared/joystick.js`, `shared/paper.js` | The phone: controller layouts, the route to the game, PeerJS host / client with the relay fallback, sticks, the paper camera |
| `explore.html`, `shared/play.js`, `shared/play.css`, `api/play.js` | Published games: the gallery and the play page |
| `login.html`, `profile.html`, `admin.html` | Login, profile (credits, history, games), the admin panel |
| `lib/image.mjs`, `lib/segment.mjs`, `shared/assetcheck.js`, `shared/cutout.js`, `shared/zip.js`, `shared/photo.js` | Pictures: classify and sprite prompts, SAM 3.1, the local checks, cutouts, ZIP packs, photo resize |
| `shared/auth.js`, `lib/auth.mjs`, `lib/db.mjs`, `lib/credits.mjs`, `shared/i18n.js` | The browser's login helper, server-side access checks, PostgREST client, the charge wrapper, the translations |
| `api/` | The 10 Vercel functions (see API) |
| `db/` | The schema and migrations, in order (see Database) |
| `serve.mjs` | The dev server |
| `assets/` | The logo, the top-bar mark, favicons |
| `tests/` | Every suite above, the sandbox harness and the sample files |
