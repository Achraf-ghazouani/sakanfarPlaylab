# Sakanfar PlayLab

Draw a 2D platformer level on paper, take a photo with your phone, and Meta's Muse Spark turns it into a playable browser game.
Free drawings, not strict symbols: a cactus becomes an enemy, a cloud becomes a moving platform.

Built solo for the Meta hackathon (Oct 30 - Nov 4, 2026). Plain HTML/JS + Phaser 3 from a CDN, no build step, no dependencies.

## The flow

1. `index.html` (phone): take a photo of the drawing. The browser resizes it to 1600px JPEG.
2. `POST /api/scan` (Vercel function): sends the photo to Muse Spark, validates the answer, returns level JSON.
3. `game.html`: plays the level with touch controls, and shows the original drawing in a corner.

## Run it locally

```bash
cp .env.example .env              # put your Meta Model API key in MODEL_API_KEY
npm run dev                       # prints http://localhost:3000/ and http://<your-LAN-ip>:3000/
```

Open the LAN address on your phone (same Wi-Fi). If Windows asks, allow Node on private networks.
The dev server runs `api/*.mjs` the same way Vercel does, so the whole phone flow works offline from the cloud.

Other commands:

| Command | What it does |
| --- | --- |
| `node scan.mjs photos/level1.jpg` | Scan a photo from the terminal -> `levels/level1.json` (and refresh `levels/index.json`) |
| `node scan.mjs --mock` | Fake scan from `levels/sample.json`, no API call |
| `npm test` | Unit checks for the level normalizer and image parsing |
| `npm run playtest` | Headless Chrome drives the game through 36 checks (needs `npm run dev` running) |

Controls: arrows / WASD to move, space / up / W to jump (hold for a higher jump), stomp enemies from above, R restarts, M toggles sound. Phones get on-screen buttons in landscape.

## Deploy to Vercel

The repo is ready: `vercel.json` gives the scan function 60 s, `.vercelignore` skips dev files.

**From the dashboard (easiest, auto-deploys on every push):**

1. Go to https://vercel.com/new and import `Achraf-ghazouani/sakanfarPlaylab` from GitHub.
2. Framework Preset: **Other**. Leave Build Command and Output Directory empty (the root is served as static files, `api/` becomes functions).
3. Open **Environment Variables** on that same screen and add:
   - `MODEL_API_KEY` = your Meta Model API key (required)
   - `BASETEN_API_KEY`, `BASETEN_BASE_URL`, `BASETEN_MODEL` = optional second provider, used as a fallback if Meta fails
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

If a deploy fails with "pattern ... doesn't match any Serverless Functions", check that `api/scan.js` was not excluded by `.vercelignore` (patterns there follow gitignore rules, so keep them anchored with a leading `/`).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Mobile home page: camera/gallery input, resize, scanning animation, opens the game |
| `game.html` | The game (Phaser 3 arcade physics, colored shapes, touch controls, drawing thumbnail) |
| `viewer.html` | Debug: AI boxes drawn over the photo + grid preview |
| `api/scan.js` | Vercel function: base64 photo -> validated level JSON. Keys stay on the server. |
| `lib/ai.mjs` | OpenAI-compatible chat client for Meta (default) and Baseten |
| `lib/scan-level.mjs` | Prompt, JSON extraction, level normalization, image size / EXIF |
| `serve.mjs` | Dev server: static files + `/api` emulation + LAN address |
| `scan.mjs` | Terminal scanner, keeps `levels/index.json` for the dropdown |
| `levels/`, `photos/` | Demo levels and their photos |
| `tests/` | `npm test` and `npm run playtest` |

## Level JSON

```json
{ "theme": "desert cactus canyon",
  "aspect": 1.333,
  "objects": [ { "type": "platform", "label": "ground line", "x": 0, "y": 900, "w": 1000, "h": 30 } ] }
```

Coordinates are on a 1000 x 1000 grid, y goes down, `x,y` is the top-left corner.
`aspect` is the photo's width / height; the game stretches the grid by it so the level keeps the paper's proportions.
Types: `start`, `goal`, `platform`, `moving_platform`, `coin`, `enemy`, `spike`, `decoration`.
The server guarantees exactly one start, at least one goal, at least one platform, every number inside the grid, and unknown types become `decoration`.

## Rules we follow

- `.env` is git-ignored and never uploaded. The browser only ever talks to `/api/scan`.
- Everything here was written during the hackathon.
