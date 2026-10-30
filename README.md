# Sakanfar PlayLab

Draw a 2D platformer level on paper, take a photo, and Meta's Muse Spark turns it into a playable browser game.
Free drawings, not strict symbols: a cactus becomes an enemy, a cloud becomes a moving platform.

Built solo for the Meta hackathon (Oct 30 - Nov 4, 2026). Plain HTML/JS + Phaser 3 from a CDN, no build step.

## Quick start

```bash
cp .env.example .env              # put your Meta Model API key in MODEL_API_KEY
node scan.mjs photos/level1.jpg   # photo -> levels/level1.json (also refreshes levels/index.json)
npm run dev                       # http://localhost:3000/game.html  (same as node serve.mjs)
```

- `game.html` plays any level: pick one from the dropdown or load a JSON file.
- `viewer.html` overlays the AI boxes on the photo so you can check what it understood.
- No key or photo yet? `node scan.mjs --mock` writes a level from `levels/sample.json` without calling the API.

Controls: arrows / WASD to move, space / up / W to jump (hold for a higher jump), stomp enemies from above, R restarts, M toggles sound.

Game feel: coyote time (120 ms), jump buffering (130 ms), variable jump height, squash and stretch, a smooth camera that looks ahead, and sound effects synthesized with the Web Audio API (no audio files).

## Files

| File | Purpose |
| --- | --- |
| `scan.mjs` | CLI: photo -> level JSON, then rebuilds `levels/index.json` (`--index` rebuilds only) |
| `lib/scan-level.mjs` | Prompt, Meta API call, JSON extraction, level normalization, image size. Shared with `/api` later. |
| `game.html` | The game (Phaser 3 arcade physics, colored shapes, no assets) |
| `viewer.html` | AI boxes on the photo + grid preview, with a Play button |
| `serve.mjs` | Tiny static dev server (browsers block `fetch` on `file://`) |
| `levels/` | Level JSON files. `sample.json` is hand-made for testing; `index.json` feeds the dropdown |
| `photos/` | Drawing photos |
| `tests/` | `npm test` (normalizer unit checks) and `npm run playtest` (headless Chrome drives the game) |

## Level JSON

```json
{ "theme": "desert cactus canyon",
  "aspect": 1.333,
  "objects": [ { "type": "platform", "label": "ground line", "x": 0, "y": 900, "w": 1000, "h": 30 } ] }
```

Coordinates are on a 1000 x 1000 grid, y goes down, `x,y` is the top-left corner.
`aspect` (optional) is the photo's width / height; the game stretches the grid by it so the level keeps the paper's proportions.
Types: `start`, `goal`, `platform`, `moving_platform`, `coin`, `enemy`, `spike`, `decoration`.

## Rules we follow

- `.env` is git-ignored. The API key never reaches frontend code; the browser talks to `/api/*` serverless functions.
- Everything here was written during the hackathon.
