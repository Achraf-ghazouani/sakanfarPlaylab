# Sakanfar PlayLab: how it is built

The deep end of the README: how every part works, the API, the database, the phone links, the AI calls and what we learned about the Meta Model API. Start with the [README](../README.md) for the pitch and the 60-second tour.

## The shape of it

```
browser pages (plain HTML/JS, no build step)                 Vercel serverless functions (api/*.js, 12 of them)
  index.html  landing, demo levels, waitlist                   agent     the Studio's game agent (Muse Spark tools)
  studio.html the chat builder (login)                         scan      a picture -> level JSON (Muse Spark vision)
  game.html   2D engine (Phaser 3) + 3D view (three.js)        fix       the playtest agent's AI repair
  arena.html  arena shooter engine (three.js)                  art       classify / sprite / cutout (Muse Spark, Muse Image, SAM 3.1)
  pad.html    the phone: controller, camera, paper scanner     play      /play/<id> pages, explore, likes, reports, remix
  explore.html published games                                 projects, messages   saved games, versions, chat
  admin.html  the admin panel                                  me, costs, config    the account, prices, public config
  login.html, profile.html                                     waitlist, admin      the private beta and the panel
                                                       |
            PeerJS (WebRTC) or Supabase Realtime       |      Meta Model API (api.meta.ai/v1)     Supabase (Postgres + Auth)
            phone <-> computer, no server in between   |      Baseten (Muse Spark Open) fallback   row-level security everywhere
```

Rules: keys stay in `.env` / Vercel and never reach a page; every paid or private API call goes through `requireUser()`; Vercel's Hobby plan allows 12 functions, so a new endpoint has to share an existing file (`api/version.js` was folded into `GET /api/projects?id=&version=n` for that reason).

## From a drawing to a game

1. **The picture.** The browser resizes a photo to a 1600 px JPEG (`shared/photo.js`) and `POST /api/scan` sends it to Muse Spark (vision, `lib/scan-level.mjs`): the prompt describes the 1000 x 1000 level grid and the object types, the answer is JSON. Free drawings, not strict symbols: a cactus becomes an enemy, a cloud a moving platform. The server normalizes the level (exactly one start, at least one goal and one platform, every number inside the grid, unknown types become `decoration`), then runs the instant reachability fix.
2. **Live edit by redrawing.** A re-scan gets the previous level as context; `shared/diff.mjs` works out what was added, removed or moved; new things pop into the running game, the player keeps their spot, and the chat says "+1 platform, +1 coin".
3. **The chat** (`POST /api/agent`, `lib/agent.mjs`). Muse Spark gets the brief (level and arena formats, jump physics, design rules from `lib/game-knowledge.mjs`), the last chat turns and the current game, and answers with a function tool: `create_level`, `edit_level` (the full updated level, unchanged things keep their coordinates), `create_arena`, `edit_arena` or `playtest_level`. A guard makes sure a shooter request never comes back as a platformer: if the model picks the wrong kind, `generateArena()` builds the arena from the words. View switches ("switch to top-down") and small talk are answered without the model and cost nothing. If the Meta API fails, Muse Spark Open on Baseten gets the same brief and answers with a JSON object instead of a tool call.
4. **The playtest agent.** `shared/reach.mjs` simulates the jump physics (max height 252 units, a flat jump about 300 across, platforms solid from below) and walks the level graph from the start: every platform, coin and goal must be reachable, and each problem is explained in words (`platform "sky ledge" is 470 above "ground" but the player jumps at most 244`). Repairs come in two layers (`lib/fix-level.mjs`): the **AI** repair (`POST /api/fix`) asks Muse Spark for a minimally edited level and re-checks it, keeping it only when it is better; the **auto** fix adds small stepping platforms until everything is reachable, never moves drawn objects and runs in milliseconds. Arena games have their own check (`checkArena` / `autoFixArena` in `shared/arena.mjs`): a flood fill from the player moves any walled-off gate or pickup to open ground.
5. **The thinking panel.** While a call runs, a card in the chat lists its steps as they happen, each named after the Meta model doing it: designing or changing the game (Muse Spark 1.3, or Muse Spark Open when it answered), reading the drawing, objects found, checking every jump (the playtest agent), problems found, fixes applied (Muse Spark's minimal edits or the instant fix), ready; a picture shows looking (Muse Spark), drawing the sprite (Muse Image 1.0), finding the subject (SAM 3.1) or the free fill. The steps before the answer run with a timer, the ones after roll out from the answer, a failure turns red, and the card stays in the chat and in the saved history. The big screen shows the same steps in a corner card while a phone's drawing is read, and the Redraw overlay lists them.
6. **Versions.** Every level change is a saved version with the model's own note ("harder: two more spikes"); History lists them and Undo restores the previous one as a new version, so nothing is lost.

Terminal tools do the same without the pages: `node scan.mjs photos/level1.jpg` (scan, playtest, refresh `levels/index.json`; `--previous` for a re-scan, `--mock` for no API call), `node check.mjs levels/impossible.json [--fix] [--no-ai]` (`levels/impossible.json` has a ledge 470 units up, a coin in the sky and an island too far away).

## The engines

**2D platformer** (`game.html`, Phaser 3 arcade physics). Arrows / WASD to move, space / up / W to jump (hold for a higher jump), stomp enemies from above, R restarts, M toggles sound, G switches between drawn art and simple shapes, V switches to the 3D view. On phones, on-screen buttons in landscape. Modes: `?embed=1` inside the Studio (levels and commands arrive by `postMessage`), `?screen=1` big screen, on its own a clean full-screen player for the demo levels.

**Your drawing is the art** (`shared/inkart.js`, no AI, no credits). When a level comes from a picture, the game wears the pen strokes: each object's box is cut from the picture at 720 px, grown by 10% because the AI boxes are tight, and the paper is keyed out (per-crop paper brightness; dark or colored ink becomes opaque). Printed notebook rules are thin and light, so light ink only stays where it survives a small morphological opening, while dark strokes always stay. Ink inside platform boxes belongs to the platform, so an enemy standing on the ground does not carry the ground line along. A crop with almost no ink keeps the usual shape. Physics boxes never change.

**3D view** (`shared/view3d.js`, three.js 0.160 from a CDN, loaded only when needed). The same running level drawn in three dimensions: Phaser keeps running with its canvas hidden and after every frame the scene is mirrored (platforms become blocks with a grass top, spikes cones, coins spinning gold, enemies and characters little blocks with eyes, the goal a pole with a waving flag, "tree" and "cloud" decorations real trees and clouds; pictures stand in the world as paper cut-outs). Physics, controls, phones and the playtest agent are untouched. The chat box's **2D | 3D** switch picks it before typing (words like "a 3D lava castle" switch it too); the choice is saved on the game (`projects.mode`: `2d`, `3d-side`, `3d-world`) and 3D turns cost the 3D prices.

**Arena shooter** (`arena.html`, three.js). The player stands in a fenced arena and shoots waves of enemies that walk out of spawner gates: three cameras switched in the game (FPS / TPS / Top, keys 1 2 3) or by chat, WASD to move, click or space to shoot, ammo and medkits on the ground, waves grow (wave n has 3 + 2n enemies), enemy kinds walker / runner / brute from their labels, themes from the words (graveyard, alien outpost, robot factory, desert, snow, city, castle). The player picture and an enemy sprite from the Studio appear as billboards. Format (`shared/arena.mjs`): a top-down 1000 x 1000 map, `genre: "arena"`, `view` (`fps` | `tps` | `top`), `waves`, objects `start`, `spawner`, `wall`, `prop`, `ammo`, `health`; `generateArena()` builds one from words. Arena games are always 3D (`3d-world`). Demo: `levels/zombies.json`.

**Level JSON** (2D):

```json
{ "theme": "desert cactus canyon",
  "aspect": 1.333,
  "objects": [ { "type": "platform", "label": "ground line", "x": 0, "y": 900, "w": 1000, "h": 30 } ],
  "checked": true,
  "fixes": ["added a step under 'sky coin' at x470 y350"] }
```

Coordinates are on a 1000 x 1000 grid, y goes down, `x,y` is the top-left corner. `aspect` is the photo's width / height; the game stretches the grid by it so the level keeps the paper's proportions. Types: `start`, `goal`, `platform`, `moving_platform`, `coin`, `enemy`, `spike`, `decoration`. `checked` and `fixes` come from the playtest agent; `diff` is added when a scan was a re-scan of an edited drawing.

## Pictures: the player, the objects, the cutouts

Every attached picture has a toggle (**Auto**, **Level**, **Player**, **Object**, **UI**, **Asset**) and the words always win ("use this as my player", "make this the enemy", "this is my pause button", "these are UI icons"). On Auto, `shared/assetcheck.js` reads the pixels first (transparency, size and aspect, a grid of cells, a straight frame border, paper with pen strokes, a wide scene) and guesses the role; a sure guess (sprite sheet, tileset, font sheet, button, panel, level drawing) costs nothing, anything else goes to Muse Spark with those facts as hints, and when the model is not sure either the chat asks with chips. The roles (`ASSET_ROLES` in `lib/image.mjs`): `level`, `player`, `enemy`, `collectible`, `hazard`, `goal`, `texture`, `tileset`, `spritesheet`, `background`, `decoration`, and the UI ones `ui_button` (hint start / pause / restart / menu / gameover), `ui_panel`, `ui_hud` (health / coins / timer / score), `ui_icon` (heart / coin / star / timer), `ui_logo`, `ui_cursor`, `ui_font`, `ui_mockup`. Characters and objects become sprites; everything else is saved on the game as an asset (`projects.art.assets[]`: id, role, name, hint, the original PNG so transparency survives, size) for the engines and the UI kit. Every upload ends with a "Detected: 1 pause UI button. Game is 2D." card.

**Many files at once.** A drop, a paste, the clip button or a ZIP (`shared/zip.js` reads the central directory and inflates entries with the browser's `DecompressionStream`; folders, `__MACOSX` junk, dotfiles and other file types are skipped) with two or more pictures opens the **review grid**: every file with its thumbnail, the role the local checks guessed (a select to change it, a second one for the hint of buttons, icons and HUD pieces), why, and the engine the files imply (3D as soon as a `.glb` / `.gltf` / `.fbx` is among them). Words typed with the files apply to all of them ("these are UI icons"). **Apply all** adds everything in order (level drawings first, then the player, objects, then assets and UI pieces), never asks with chips in a batch, and ends with one card: "Detected: 1 player character, 3 UI buttons (pause, restart, menu), 1 background. Game is 2D." `tests/samples/pack.zip` is a ready-made pack to drop.

**What each role does in the game.** The Studio sends `projects.art.assets` to the engines with every level (`playlab:level`) and on every change (`playlab:assets`). In `game.html`: a **background** is a parallax layer behind the level (fitted to the view's height, scrolling at a third of the camera); a **texture** (or the first tile of a **tileset**) is tiled over every platform; a **sprite sheet** animates the main character: frames are the grid the local checks found, rows are idle, run and jump (one row: run only; two: idle and run), and the animation follows the body (in the air, moving, still); the **UI kit** dresses the page's own chrome: the restart button wears the uploaded button, the message panel (pause, you win, you fell) is the uploaded panel 9-sliced with CSS `border-image`, the coin counter shows the coin icon and digits cut from the font sheet (the first ten cells), the logo tops the message panel. In `arena.html`: the background is a sky dome around the arena (out of the fog) and the texture repeats over the floor. The game's state (`playlab:state`, broadcast to the phones) carries `kit: { button, color }` (a 160 px copy of the button and its average colour) and `pad.html` wears it on every pad button and as its accent colour. Characters and objects keep going through the sprite path (Muse Image, SAM 3.1 cutouts). Not done: cursors, HUD frames, pause/menu/game-over screens as separate buttons (the HUD has one restart button), and reading a full UI mockup apart (the `ui_mockup` role is stored as one picture).

**3D models decide the engine.** A `.glb`, `.gltf` or `.fbx` (up to 1.8 MB, alone or in a batch) is saved on the game (`projects.art.model`: the data URL, the name, `role` player or enemy from the words) and switches the game to 3D: a platformer gets the 3D view, a shooter is an arena anyway; the chat says "You uploaded a 3D model, so I switched the game to 3D" and 3D prices apply from there. `shared/model3d.js` loads the file with three's own `GLTFLoader` / `FBXLoader` (the pages carry an import map so the loaders and the engines share one `three.module.js`), stands it on its feet at a given height; the 3D view wears it on the main character (turned by facing, squashed with the body, its first animation clip playing), the arena uses it as the player's body (hidden in first person like the block). **Undo, stay 2D** switches back and `Model3D.bake()` renders a side view at four slightly different angles into a one-row sprite sheet that the 2D player wears. A picture dropped into a 3D game stays 3D (cut-outs, textures, UI) with a **Switch to 2D instead** chip. `tests/samples/cube.glb` is a generated minimal model (one box). `api/art.js` does three things, each charged first and refunded when the AI call fails:

- **classify** (Muse Spark vision, `lib/image.mjs`): the role of the picture, a name, a confidence and a hint. Muse Image only outputs images, so understanding a picture is Muse Spark's job.
- **sprite** (Muse Image 1.0, `POST /v1/images/edits` with the picture as the reference, `output_format: "png"`): redraws the character or object as one clean game sprite on flat white. Muse Image has no transparent output, so the page cuts the white out for free (`shared/cutout.js`, the border fill).
- **cutout** (SAM 3.1, `lib/segment.mjs`): for a picture kept "as is" (or after a failed Muse Image call). The classifier's name is the concept prompt ("elf alchemist mascot"); with no name or no match, a point in the middle of the picture is the prompt instead. The server reads SAM's token grammar and picks the subject (the biggest box, nudged to the middle); the page decodes the mask with Meta's `@meta-sam/parser` (from a CDN, loaded on first use) and uses it as the picture's alpha. `Cutout.prepare()` makes the ≤ 1024 px copy that is sent, so the mask lands on the same pixel grid. If SAM cannot help (no credits, an error), the free fill does its best.

A character becomes the player (`projects.art.player`); an object becomes the sprite every enemy, coin, goal, spike or decoration wears (`projects.art.sprites`). Sprites are trimmed, 256 px tall WebP data URLs.

## Phones

**Phone as controller.** `game.html`, the Studio and the play page show a QR code and a 4-letter room code; scanning opens `pad.html?room=CODE`. Transport: WebRTC data channels through PeerJS (`shared/phonelink.js`: host on the computer, client on the phone; rooms, slots, a 3 s heartbeat, a silent phone dropped after 8 s, the phone redials by itself). Measured press-to-reaction round trip on one network: under 10 ms. If WebRTC has not connected within 5 s (mobile data, strict Wi-Fi), the phone switches to a relay over **Supabase Realtime Broadcast** (channel `playlab-CODE`, no database, about 150 ms); both screens say "(relay)". Player 1 drives the main character; players 2 to 4 get their own characters (their phone's color), and only the one who dies goes back to the start. The pad shows the level, the coins and whether the game is paused (the game broadcasts a state message on every change), and vibrates on jump, coin, hit and goal. The pad's layout follows the kind of game: arrows and JUMP for a platformer; a move stick, an aim stick and a FIRE hold for a shooter (`shared/joystick.js`, messages `{t:"stick", m, a}` and `{t:"fire"}`); in first and third person the aim stick turns the view, top-down it aims and shoots like a twin-stick game.

**Phone as camera, live build while you draw** (`shared/paper.js`, no OpenCV). The phone finds the sheet in every frame (brightest region, corner extraction on a 160 x 120 downscale), draws a green outline into the stream, and when the sheet has been still for about a second it captures, flattens it with a 4-point homography to 1200 x 900, boosts the contrast and extracts the dark strokes. The ink mask goes to the computer over the data channel and draws itself on notebook paper at once; the flattened photo goes to `/api/scan`; the objects pop in one by one with sound. Keep drawing: when the ink changed and is steady again for 1.5 s the phone re-scans with the previous level as context, asking for the Baseten model to save Meta credits. `pad.html?room=CODE&fakepaper=1` uses a code-drawn sheet as the camera for tests. Phone cameras need HTTPS: the live site has it; on a LAN, `npm run dev:https` (self-signed certificate made with the openssl bundled with Git for Windows).

**Big screen** (`game.html?screen=1`): the computer shows the QR, the phone streams its camera over a one-way PeerJS media call, **PLAY!** switches it to the controller, other phones join as controllers.

## The Studio

`studio.html` opens on a clean first screen (sketch it, upload a drawing, use the camera, add your character, continue your last game) with one chat box at the bottom center; the first message turns it into the workspace, chat left and the game in the center, My games in a drawer. The game runs inside an iframe (`game.html?embed=1` or `arena.html?embed=1`, chosen by the game's kind) and talks to the page by `postMessage`:

- page -> game: `playlab:level` (level, name, thumb, player, sprites, mode, keepPlayer), `playlab:restart`, `playlab:mute`, `playlab:art`, `playlab:mode`, `playlab:view`, `playlab:player`, `playlab:sprites`, `playlab:menu`, `playlab:input` / `jump` / `stick` / `fire` (forwarded from the phones), `playlab:players`, `playlab:snapshot` (a screenshot for the publish cover);
- game -> page: `playlab:ready`, `playlab:state` (level, coins, paused, layout for the pads), `playlab:event` (coin, hit, goal...), `playlab:snapshot`.

The Studio hosts one phone room for everything (key `playlab.studio.room`): the phone that scans after the camera button is the camera, every other phone is a controller. The sketch pad (pen sizes, eraser, undo, "Last picture" to draw over the game's previous picture) sends drawings through the scanner. Projects, messages and versions live in Supabase and belong to the login; games made before accounts existed (keyed by a browser id) move to the account on the first login (`db/007_claim.sql`), and a deleted account takes its games with it.

## Accounts, credits, the cap

PlayLab is invite-only. The waitlist (`api/waitlist.js`) validates on the server, has a honeypot field, 5 sign-ups per IP per hour plus a global hourly cap (IPs stored only as salted hashes). A trigger on Supabase's `auth.users` refuses any account whose email is not approved, not in `ADMIN_EMAILS` and not created by an admin, so sign-ups are closed by the database itself. Logins (`login.html`): email link, Google when enabled, or username + password for demo accounts (`<username>@demo.playlab.invalid`). `requireUser()` (`lib/auth.mjs`) checks the token with Supabase Auth and reads the profile: no login 401; suspended, banned, expired demo or no profile 403 with the reason. Roles `user` / `admin` live in `profiles` and only an admin can change them (checked inside the database). A few server-only functions (`srv_*`) need `PLAYLAB_SERVER_KEY`; the database stores only its SHA-256.

**Credits** (`lib/credits.mjs`, `db/004_credits.sql`): every AI call is charged in one database transaction before the call (`public.charge`: price x model multiplier rounded up, balance, optional per-user daily limit, ledger row) and refunded automatically when the call fails. A short balance answers 402 before any AI call. Prices and multipliers are edited in the admin panel; `GET /api/costs` is the public price list.

| Action | Credits | When |
| --- | --- | --- |
| `create_2d` / `create_3d` | 10 / 25 | a chat turn with no game yet |
| `edit_2d` / `edit_3d` | 2 / 5 | a chat turn on an existing game (a remix costs one edit) |
| `scan` | 8 | a photo, sketch or camera picture of a level |
| `classify` | 1 | Muse Spark looks at a picture sent on Auto |
| `art` | 15 | Muse Image draws a player or object sprite (model `muse-image-1.0`) |
| `cutout` | 1 | SAM 3.1 finds the subject of a picture kept "as is" (model `sam-3.1`) |
| `playtest` | 3 | only when the level needs the AI repair (free when it is already fine; refunded when the instant fix is used instead) |

Models: Muse Spark 1.3 x1 (default), 1.2 x0.8, 1.1 x0.6, Muse Spark Open on Baseten x0.5 (live re-scans from the phone use it), Muse Image 1.0 x1, SAM 3.1 x1. Replies that need no AI are free.

**Shared daily cap** (`db/010_cap.sql`): in Admin -> Overview the admin sets how many credits everyone together may use per UTC day (0 = no cap). When it is reached, a regular user's paid action is refused with `global_cap` and nothing is charged; the Studio shows a note above the chat box until midnight UTC and the credits dialog explains; free actions keep working; admins are never blocked. `GET /api/me` carries the state as `cap`.

## Publish, share, remix

**Publish** (Studio top bar): title, description, a cover (a screenshot of the running game, the drawing or the player picture), public or unlisted. The game gets an 8-character id and lives at `/play/<id>` (`vercel.json` rewrites it to `api/play.js`, which renders the HTML with Open Graph tags; `shared/play.js` runs the page). It plays with no account in the right engine, counts plays, takes likes (one per browser token or login) and reports (to the admin queue), has a Share sheet (copy, Web Share, QR), Play with your phones (the page hosts the phone room) and Remix in Studio (a copy with the level, the art and a "remixed from" card, charged as one edit). `/api/play?id=<id>&cover=1` serves the 1200 x 630 link-preview card drawn in the Studio at publish time. `explore.html` lists public games (trending by plays and likes with newer games first, newest, featured; 2D / 3D / arena; search). Plays, likes and the featured flag can only be changed by the game's own database functions, never by the owner (a trigger guards them). Admins feature, unpublish, make public, delete, and close reports.

## The admin panel

`admin.html` + `api/admin.js`; the role is checked in the API and again inside every database function. Overview (waitlist, accounts, credits used today / 7 / 30 days, the shared daily budget, a 14-day chart, usage by action and model, top users), Waitlist (approve with starting credits, reject, mark invited, copy the invite text), Users (search, demo or real, give or take credits with a reason, status, role, daily limit, access end date, passwords, usage, delete; **New user** creates email or username accounts, including demo accounts for judges), Credits & usage (everyone's ledger), Prices & models, Games, Reports, Activity (every change made from the panel, by whom).

## API

All functions set `Cache-Control: no-store`. "Login" means a Supabase access token in `Authorization: Bearer`.

| Function | Routes |
| --- | --- |
| `api/agent.js` | `POST` `{ message, level?, history?, mode? }` -> `{ reply, level?, kind, note, diff, playtest, actions, credits }` (login) |
| `api/scan.js` | `POST` `{ image, previous?, provider? }` -> `{ level, original, meta }` (login; the phone sends through the computer) |
| `api/fix.js` | `POST` `{ level }` -> `{ level, report }` (login; charged only when the AI repair runs) |
| `api/art.js` | `POST` `{ task: "classify" \| "sprite" \| "cutout", image, ... }` (login) |
| `api/projects.js` | `GET` list, `GET ?id=` (project, messages, versions), `GET ?id=&version=n`, `POST` create or `{ claim }`, `PATCH` update / `{ publish }` / `{ unpublish }`, `DELETE` (login) |
| `api/messages.js` | `GET ?project_id=`, `POST` (login) |
| `api/play.js` | `GET ?id=` (HTML), `&format=json`, `&cover=1`, `&liked=`; `?action=explore&sort&kind&q`; `POST` `played` / `like` / `report` (no login), `remix` (login) |
| `api/me.js` | `GET` (profile, cap; `?ledger=1` adds the credit history), `PATCH` (username, display name, avatar) |
| `api/costs.js` | `GET` prices and enabled models (public) |
| `api/config.js` | `GET` the public Supabase URL and key for the relay and the login (public) |
| `api/waitlist.js` | `POST` a sign-up (public, rate limited) |
| `api/admin.js` | `GET ?action=overview \| waitlist \| users \| ledger \| pricing \| activity \| games \| reports \| settings`, `POST { action: ... }` (admins) |

## Database

Postgres on Supabase, row-level security on every table, `security definer` functions for anything that crosses an account's rows. Run the files in the SQL editor in this order: `db/schema.sql` (projects, messages, versions), `db/002_accounts.sql` (waitlist, profiles, the approval trigger, admin and server functions, rate limits), `db/003_server_users.sql` (test and demo accounts), `db/004_credits.sql` (costs, models, the atomic charge, refunds, grants), `db/005_admin.sql` (the panel's functions), `db/006_sprites.sql` (classify price, Muse Image model), `db/007_claim.sql` (pre-account games move to the login), `db/008_publish.sql` (visibility, likes, reports, the public game functions, the counter guard), `db/009_cutout.sql` (cutout price, SAM 3.1 model), `db/010_cap.sql` (the shared daily cap).

## What we learned about the Meta Model API

- **Muse Spark** (`POST /v1/chat/completions`, `muse-spark-1.3`): `tool_choice` accepts only `"auto"`, so the brief makes the model call a tool and `parallel_tool_calls: false` keeps it to one call per turn; a `json_schema` response format needs `additionalProperties: false`; `reasoning_effort` (`minimal` ... `max`) matters a lot for latency: the Studio agent runs at `low` (6-10 s per turn), the AI repair at `low` (about 25 s, 45-60 s at the default), the picture classifier at `minimal`. A scan of a photo takes 6-10 s and about 6k tokens.
- **Muse Spark Open** (Baseten, `meta-models/muse-spark-open-1026`) always reasons; `lib/ai.mjs` strips the reasoning and keeps the answer, and the brief asks for a JSON object because open weights have no tool calling.
- **Muse Image 1.0** (`POST /v1/images/edits`): a JSON body with `images: [{ image_url }]` (a data URL works), `output_format: "png"`, `response_format: "b64_json"`, `reasoning_strength: "low"`; responses are always opaque (no transparency), hence the flat white background and the client-side cutout.
- **SAM 3.1** (`POST /v1/responses`, `sam-3.1`): one user message with an `input_text` prompt and an `input_image` (`image_url` accepts data URLs: PNG, JPEG, WebP). A concept prompt is a short noun phrase (every match comes back); box and point prompts use SAM's own token grammar (`<0f>1<|point;x=..;y=..;w=W;h=H|>`). The answer is special-token text, one line, one record per object: `<0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=W;h=H|><|mask;x=0;y=0;data=H,W,!payload|>`; the box is in source pixels (x2/y2 inclusive), the mask raster covers the box (scaled down past 1024 px), `metadata.mask_encoding: "one_bit"` gives payloads of a few hundred characters. The payload is Meta's packed encoding, decoded with `@meta-sam/parser`. A box over the whole picture returns the whole picture, so the fallback prompt is a point in the middle. Zero matches is an empty answer, not an error. Calls take about 1-2 s.

## Run it locally

```bash
cp .env.example .env              # put your Meta Model API key in MODEL_API_KEY
npm run dev                       # http://localhost:3000/ and http://<your-LAN-ip>:3000/
npm run dev:https                 # same on https://...:3443/ (needed for the phone camera on your LAN)
```

`.env` also takes `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the publishable key), `PLAYLAB_SERVER_KEY`, `ADMIN_EMAILS`, optional `BASETEN_API_KEY` (`BASETEN_BASE_URL`, `BASETEN_MODEL`), `AI_PROVIDER` (`meta` or `baseten`), `PLAYLAB_AGENT_EFFORT`. The dev server (`serve.mjs`) runs `api/*.js` the same way Vercel does and serves `/play/<id>`; restart it after editing `lib/` or `shared/` (Node caches those modules). Open the LAN address on your phone (same Wi-Fi); if Windows asks, allow Node on private networks.

### Tests

| Command | What it checks |
| --- | --- |
| `npm test` | Unit: level normalizer, reachability and auto-fix, diff, the AI client, the paper detector, the agent (with one live Muse Spark call), pictures (with one live SAM 3.1 call), the arena format |
| `npm run test:assets` | Headless Chrome runs the local picture checks on every sample in `tests/samples/` (one per role, drawn by `npm run samples`): sure guesses are right, unsure ones say so |
| `npm run test:kit` | Headless Chrome gives `game.html`, `arena.html` and `pad.html` the sample assets: parallax background, textured platforms, the player animated from the sheet, the UI kit on the HUD, panel, score and pad, the arena's sky dome and floor |
| `npm run playtest` | Headless Chrome drives `game.html` through its checks (needs `npm run dev`) |
| `npm run test:arena` | Headless Chrome drives `arena.html`: waves, walking, shooting, the three views, the phone sticks, death, restart |
| `npm run test:studio` | Headless Chrome drives `studio.html`: chat, pictures as player and sprites, 2D / 3D, the arena switch, versions, undo, sketch pad, publish button, reload, mobile tabs (needs Supabase) |
| `node tests/studio-camera.test.mjs` | Two headless Chromes: the Studio camera link and a phone with the synthetic sheet |
| `npm run test:auth` | Waitlist, approval gate, logins, roles, blocked accounts, row-level security, against the real Supabase project with throwaway accounts |
| `npm run test:db` | A round trip through the tables and the publish functions as throwaway accounts |
| `node tests/credits.test.mjs` | Prices, multipliers, the atomic charge, refunds, daily limits, the shared daily cap, parallel charges, admin grants, one real AI call |
| `npm run test:publish` | Publish, the play page and its Open Graph tags, plays, likes, reports, explore, unlisted, remix with its charge, admin feature / unpublish / delete |
| `npm run test:admin` | The admin API: access, credits, limits, suspend, passwords, accounts, waitlist, prices, models, settings, activity |

Every suite that touches Supabase creates its own throwaway accounts and deletes them at the end. Headless Chrome is found at `C:/Program Files/Google/Chrome/Application/chrome.exe` or `CHROME`.

## Deploy to Vercel

The repo is ready: `vercel.json` sets the function timeouts (scan 60 s, fix 120 s, agent 60 s, art 60 s) and the `/play/:id` rewrite, `.vercelignore` skips dev files. Import `Achraf-ghazouani/sakanfarPlaylab` at https://vercel.com/new with Framework Preset **Other**, no build command and no output directory (the root is served as static files, `api/` becomes functions), add the environment variables from `.env.example` (at least `MODEL_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PLAYLAB_SERVER_KEY`), deploy. Every push to `main` deploys again. In Supabase, set the Site URL to the live address and add it (plus `http://localhost:3000/**`) to the redirect URLs, or login links point at localhost. If a deploy fails with "pattern ... doesn't match any Serverless Functions", check that `api/*.js` was not excluded by `.vercelignore` (patterns follow gitignore rules; keep them anchored with a leading `/`). If it complains that `maxDuration` exceeds your plan, lower `api/fix.js` to 60.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Landing page: Start creating, Play a demo, Explore, how it works, demo levels, the waitlist |
| `studio.html` | PlayLab Studio (login): chat, pictures, versions, publish, My games, phones |
| `game.html`, `shared/view3d.js` | The 2D engine (Phaser 3) and its 3D view (three.js) |
| `arena.html`, `shared/arena.mjs` | The arena shooter engine (three.js) and its format, check, fix and word-based generator |
| `pad.html`, `shared/phonelink.js`, `shared/joystick.js`, `shared/paper.js` | The phone: controller layouts, PeerJS host / client with the relay fallback, the live paper scanner |
| `explore.html`, `shared/play.js`, `shared/play.css`, `api/play.js` | Published games: the gallery and the play page |
| `login.html`, `profile.html`, `admin.html` | Login, profile (credits, history, games), the admin panel |
| `shared/inkart.js`, `shared/cutout.js`, `shared/photo.js`, `shared/diff.mjs`, `shared/reach.mjs` | Drawn art, cutouts, photo resize, scan diff, the reachability checker (shared by pages and server) |
| `shared/auth.js`, `lib/auth.mjs`, `lib/db.mjs`, `lib/credits.mjs` | The browser's login helper, server-side access checks, PostgREST client, the charge wrapper |
| `lib/ai.mjs`, `lib/agent.mjs`, `lib/game-knowledge.mjs`, `lib/scan-level.mjs`, `lib/fix-level.mjs`, `lib/image.mjs`, `lib/segment.mjs` | The AI: chat client (Meta, Baseten), the game agent and its brief, the scan prompt, the playtest repair, pictures (classify, sprite), SAM 3.1 |
| `api/` | The 12 Vercel functions (see API) |
| `db/` | The schema and migrations, in order (see Database) |
| `serve.mjs`, `scan.mjs`, `check.mjs` | Dev server, terminal scan, terminal playtest |
| `levels/`, `photos/` | Demo levels (`sample`, `level1` from a real photo, `impossible` + its AI-fixed version, `zombies` arena) and the photos |
| `assets/` | The logo, the top-bar mark, favicons |
| `tests/` | Every suite above |
