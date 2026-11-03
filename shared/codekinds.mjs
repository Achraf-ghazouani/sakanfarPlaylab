// shared/codekinds.mjs — the router between the built-in engines and the code builder. A 2D platformer or a 3D arena
// shooter goes to the engines (lib/agent.mjs); every other kind of game named here goes to "any game from a prompt"
// (lib/code.mjs: a plan, then Muse Wonder writes the game as code). Shared by the server and the Studio (window.CodeKinds).
import { ARENA_WORDS } from "./arena.mjs";

/** [what to call it, the words that ask for it]; the first match wins. */
export const CODE_KINDS = [
  ["a racing game", /\b(racing|race ?cars?|car race|karts?|karting|formula ?(1|one)|f1|grand prix|rally|driving game|drive a (car|bike|truck)|cars? game|motorbikes?|motorcycles?|laps?\b[^.]{0,40}\b(cars?|track|race|rivals?|drivers?)|\b(cars?|track|rivals?|drivers?)\b[^.]{0,40}\blaps?)\b/i],
  ["a puzzle game", /\b(puzzle|match.?3|match three|tetris|sudoku|crossword|sokoban|jigsaw|2048|minesweeper)\b/i],
  ["a card game", /\b(card game|cards? game|poker|blackjack|solitaire|deck.?building|memory cards?|matching pairs|pairs game|concentration game)\b/i],
  ["a board game", /\b(chess|checkers|board game|monopoly|backgammon|tic.?tac.?toe|connect ?(4|four))\b/i],
  ["a sports game", /\b(football|soccer|basketball|tennis|golf|baseball|hockey|cricket|volleyball|bowling|ping.?pong|table tennis)\b/i],
  ["a tower defense game", /\b(tower defen[cs]e|td game)\b/i],
  ["a strategy game", /\b(strategy game|rts|city builder|civilization|turn.?based)\b/i],
  ["a role-playing game", /\b(rpg|role.?playing|jrpg|quests?)\b/i],
  ["a rhythm game", /\b(rhythm game|guitar hero|dance game|beat game)\b/i],
  ["a fighting game", /\b(fighting game|beat.?'?em.?up|street fighter|mortal kombat|brawler)\b/i],
  ["a snake game", /\b(snake)\b/i],
  ["an endless runner", /\b(endless|infinite|auto|temple|subway)[ -]?(runner|run)\b|\brunner game\b|\bendless (run|runner)\b|\brunner\b/i],
  ["a flight game", /\b(flight|flying|fly (a|the|through)|plane|airplane|aircraft|jet|spaceship|space ?ship|through (the )?rings|rings)\b/i],
  ["a dungeon crawler", /\b(dungeon|roguelike|rogue-like|crawler)\b/i],
  ["a memory game", /\b(memory game|memory match|matching game)\b/i],
  ["a classic arcade game", /\b(pong|breakout|brick breaker|arkanoid|asteroids|space invaders|galaga|pac.?man|frogger|flappy|whack.?a.?mole|simon says|doodle jump|bubble shooter)\b/i],
  ["a clicker game", /\b(clicker|idle game|incremental game|tycoon)\b/i],
  ["a quiz game", /\b(quiz|trivia|typing game|word game|hangman|wordle|spelling)\b/i],
  ["a maze game", /\b(maze|labyrinth)\b/i],
  ["a simulation", /\b(simulat(or|ion)|farming game|cooking game|pet game|tamagotchi)\b/i],
];
const ENGINE_WORDS = /\b(platformer|platform game|jump and run|side.?scroller)\b/i;

/** "a racing game" when the words ask for a kind the engines do not have (so the code builder makes it), else null. */
export function codeKind(text) {
  const t = String(text || "");
  if (ARENA_WORDS.test(t) || ENGINE_WORDS.test(t)) return null;   // a shooter or a platformer, even with race or car words
  for (const [kind, re] of CODE_KINDS) if (re.test(t)) return kind;
  return null;
}

if (typeof window !== "undefined") window.CodeKinds = { CODE_KINDS, codeKind };
