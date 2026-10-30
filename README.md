# Sakanfar PlayLab

Draw a 2D platformer level on paper, take a photo, and Meta's Muse Spark turns it into a playable browser game.
Free drawings, not strict symbols: a cactus becomes an enemy, a cloud becomes a moving platform.

Built solo for the Meta hackathon (Oct 30 - Nov 4, 2026). Plain HTML/JS + Phaser 3, no build step.

## Quick start

```bash
cp .env.example .env          # then put your Meta Model API key in MODEL_API_KEY
node scan.mjs photos/level1.jpg   # -> levels/level1.json
```

Then open `viewer.html`, pick the photo and the JSON to see the AI's boxes on the drawing.

No key or photo yet? `node scan.mjs --mock` writes a level from `levels/sample.json` without calling the API.

## Files

| File | Purpose |
| --- | --- |
| `scan.mjs` | CLI: photo -> level JSON (uses `lib/scan-level.mjs`) |
| `lib/scan-level.mjs` | Prompt, Meta API call, JSON extraction, level normalization. Shared with `/api` later. |
| `viewer.html` | Overlays the AI boxes on the photo + simple grid preview |
| `levels/` | Level JSON files (`sample.json` is hand-made for testing) |
| `photos/` | Your drawing photos |

## Level JSON

```json
{ "theme": "desert cactus canyon",
  "objects": [ { "type": "platform", "label": "ground line", "x": 0, "y": 900, "w": 1000, "h": 30 } ] }
```

Coordinates are on a 1000 x 1000 grid, y goes down, `x,y` is the top-left corner.
Types: `start`, `goal`, `platform`, `moving_platform`, `coin`, `enemy`, `spike`, `decoration`.

## Rules we follow

- `.env` is git-ignored. The API key never reaches frontend code; the browser talks to `/api/*` serverless functions.
- Everything here was written during the hackathon.
