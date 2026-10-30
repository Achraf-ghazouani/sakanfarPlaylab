# Sakanfar PlayLab

Draw a 2D platformer level on paper, take a photo with your phone, and Meta's Muse Spark turns it into a playable browser game.
Free drawings, not strict symbols: a cactus becomes an enemy, a cloud becomes a moving platform.
A playtest agent then checks every jump and repairs impossible parts, so the level is always beatable.

Built solo for the Meta hackathon (Oct 30 - Nov 4, 2026). Plain HTML/JS + Phaser 3 from a CDN, no build step, no dependencies.

## The flow

1. `index.html` (phone): take a photo of the drawing. The browser resizes it to 1600px JPEG.
2. `POST /api/scan`: Muse Spark reads the photo and returns level JSON. The playtest agent checks reachability and applies an instant fix if needed.
3. If something was impossible, the page calls `POST /api/fix`: Muse Spark repairs the drawn level with minimal edits (add a step, lower a ledge). A "play now" button lets you skip the wait.
4. `game.html`: plays the level with touch controls, shows the original drawing in a corner, and a toast lists what the agent changed.
5. **Live edit by redrawing**: change the paper (add a bridge, erase a spike), tap **Redraw** in the game and snap it again. The scan gets the earlier level as context, `shared/diff.mjs` works out what changed, new things pop into the running level, the player stays where they were, and a toast says "added 1 platform, 1 coin".

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

## Run it locally

```bash
cp .env.example .env              # put your Meta Model API key in MODEL_API_KEY
npm run dev                       # prints http://localhost:3000/ and http://<your-LAN-ip>:3000/
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
| `index.html` | Mobile home page: camera/gallery input, resize, scanning animation, AI-fix phase, opens the game |
| `game.html` | The game (Phaser 3 arcade physics, colored shapes, touch controls, drawing thumbnail, agent toast) |
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
