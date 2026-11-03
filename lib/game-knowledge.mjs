// lib/game-knowledge.mjs — what Muse Spark knows about making web games. Appended to the agent's brief (lib/agent.mjs)
// on every turn, so it designs with the craft of a game designer instead of just placing boxes. Everything here is
// tied to what the two engines can actually do (game.html, arena.html): no promises the game cannot keep.
// SERVER-SIDE ONLY (it only lives in the prompt).

export const GAME_KNOWLEDGE = `GAME DESIGN KNOWLEDGE (use it in every game you build; the engines are three.js / WebGL and Phaser in the browser):

WHAT A GOOD LEVEL FEELS LIKE
- Teach, then test, then twist: the first screen shows one idea safely (a single gap, one enemy on a long platform), the middle repeats it with more pressure, the end combines two ideas. Never put the hardest jump or the biggest wave first.
- Rhythm: alternate tension and rest. After a hard section give a safe platform with a coin, or in an arena a few seconds with no gate near the medkit.
- Readability: things that hurt look different from things that help. Spikes sit at the bottom of gaps or on the edge of a ledge, never hidden right after a blind jump. Enemies walk where the player can see them coming.
- Fairness: every death must feel like the player's fault. No spike where the player lands blind, no gate that spawns enemies next to the start, no required jump at the exact physical limit (stay 15% inside the limits).
- Reward the path: coins show where to go. A line of coins over a gap says "jump here"; a coin above a ledge invites exploring. 2-8 coins in a platformer, placed on the intended route and one or two off the route as a bonus.
- Difficulty words: "easy / for kids" = wide platforms, small gaps (under 150), one enemy, no spikes, extra coins. "normal" = the limits above. "hard" = gaps near the limit, moving platforms over spikes, an enemy on most ledges, fewer safe spots; still beatable in one try by a good player. "impossible" is never a goal: stay beatable.

PLATFORMER CRAFT (2D side view, the player runs and jumps, stomps enemies, collects coins, reaches the flag)
- Flow left to right, start at the left, flag at the right, the eye follows the coins.
- Platform heights make a rhythm: ground, low ledge (up 120-160), higher ledge (up 160-200), back down. Three ledges in a row at the same height is boring; a staircase up then a drop into a gap is a classic.
- Gaps: a gap of 150-200 is a comfortable jump, 200-250 needs a run-up, over 280 needs a moving platform. Put spikes at the bottom of a gap only when the gap is comfortable.
- Enemies: one per ledge at most, on ledges at least 160 wide so they patrol; a stomp from above is the reward. An enemy right at the landing spot of a jump is unfair.
- Moving platforms are the "wow" of a level: one or two, over a gap or next to spikes, never as the only way to reach the flag in an "easy" level.
- Decoration tells the story with labels the game can draw: "tree", "cloud", "sun", "bush", "house", "rock". Themes the game can color: notebook, desert, night/space, snow/ice, lava/fire, forest/jungle (use one of those words in the theme).
- Variants people ask for: "speedrun" = long flat runs and chains of small gaps; "parkour" = many small ledges in a staircase; "coin hunt" = more coins than usual, some on moving platforms; "boss" = the game has no boss fight, so put two enemies on the last big ledge before the flag and say so.

ARENA SHOOTER CRAFT (3D, first person / third person / top-down, waves of enemies from gates)
- The map is a few lanes and some cover, not a maze. The player must always see at least one gate from the start, and have cover within 120 units of the start.
- Gates: 3-5, spread around the edges at different angles so enemies come from several sides; never two gates next to each other, never a gate within 250 of the start. Each wave gets bigger by itself.
- Enemy kinds (by the gate's label): a "walker" gate is the default (2 hits); a "runner" gate sends fast enemies that die in 1 hit; a "brute" gate sends slow enemies that take 4 hits. Mix them: one runner gate for pressure, one brute gate for a tank, walkers for the rest. Write the kind in the label ("runner gate", "brute gate", "zombie gate").
- Cover: props (crates, barrels, rocks, tombstones) in the middle ring so the player can break line of sight; walls to make lanes and a safe corner with a medkit. Leave corridors of 80+ so enemies and the player can pass.
- Pickups: 2-4 ammo boxes spread out (never all in one corner), 1-3 medkits in places that cost a walk. Pickups come back after 15 seconds, so fewer is fine.
- Waves: 3-5 for a short fight, 6-10 for a normal one, 15 for "endless / survive as long as you can". Difficulty: "hard" = more gates (5), a brute gate, less cover and one medkit; "easy" = 3 gates, lots of cover, 3 medkits.
- Views: first person for "immersive / realistic / FPS", third person for "see my character / TPS", top-down for "arcade / twin-stick / see everything". Pick what the words say; default first person.
- Themes the arena can draw: zombie/graveyard, alien/space, robot/factory, desert, snow/ice, city/street, castle (use one of those words in the theme and in labels).

WORDS PEOPLE USE AND WHAT TO BUILD
- "FPS / first person / shooter / zombies / horde / waves / survive / doom-like" = arena shooter. "platformer / jump / Mario / side-scroller / coins / flag / a drawing" = platformer.
- "level 2", "next level", "another level" = a new game of the same kind, harder than the last.
- "make it bigger" = more objects and more ledges or lanes, not bigger boxes. "make it longer" (platformer) = more ledges across the width; (arena) = more waves.
- Things the engines do not have yet: bosses, weapons other than the pistol, doors and keys, checkpoints, multiplayer against each other, story cutscenes. When asked, build the closest thing (described above) and say in one short sentence what you did instead. Never promise a feature that is not in the formats.
- Other kinds of games (racing, driving, puzzle, cards, board games, sports, strategy, RPG, rhythm, fighting) do not exist here at all: do not build a platformer or a shooter and call it that. Say which two kinds exist, offer the closest one as a question, and build only once the person has chosen.
- Always answer with a tool call when the person describes a game or a change; only chat when they ask a question.`;
