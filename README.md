# Pauper Sim

A browser-based Magic: The Gathering simulator for testing Pauper decks against a computer opponent, with Arena-style controls.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Playing

- **Deck import:** paste any MTGO / MTGGoldfish / Arena / Moxfield text list (`4 Lightning Bolt`) for you and for the computer, or load one of the bundled meta decks. Lines after the first blank line (or a `Sideboard` header) are treated as sideboard and ignored.
- **Casting:** glowing cards are playable. Click a card in hand to cast it. Cards with several options (alt costs, plot, cycling, ninjutsu, overload) open a menu.
- **Abilities:** click a permanent to use its activated abilities (Blood tokens, Krark-Clan Shaman, equip…).
- **Mana:** paid automatically when you cast, like Arena. You can also click lands to tap them for mana first; floating mana is spent first.
- **Automated:** triggers, the stack, priority passing, combat damage, state-based actions, madness, monarch, flashback and turn structure.
- **Combat:** click creatures to attack, then **Attack**. To block, click your creature, then the attacker.
- **End Turn** (orange button, always available on your turn) skips the rest of your turn; you are still asked about blocks and discards. On the opponent’s turn, **Pass Turn** passes until the turn ends but stops if they cast something. **Full control** stops at every priority.
- **Animations:** turn banners, a spotlight for every spell cast, floating damage / life numbers, trigger flashes, attackers stepping forward and dying cards fading out. **Game speed** on the setup screen controls how long the game pauses so you can follow along.
- Click a graveyard or exile pile to look inside and to cast flashback or plotted cards.
- **Best of 3:** pick it on the setup screen. Between games you get a sideboarding screen (click a card to move a copy between main deck and sideboard; main deck must stay at 40+). The loser of each game chooses play or draw. The computer sideboards too, based on the cards it has seen from you (blasts against blue/red, artifact hate against Affinity, edicts against hexproof, and so on).

## Card support

Every card's behaviour has to be scripted. Fully supported right now:

- **Selesnya Bogles**, **Rakdos Madness**, **Mono Red Madness**, **Grixis Affinity**, **Dimir Faeries**, all main decks and sideboards (lists from MTGGoldfish, October 2026).

The engine supports Auras (attached on resolution, stacked behind their host, put into the graveyard when the host leaves), hexproof, protection from a color, hybrid mana and land Auras like Utopia Sprawl / Abundant Growth.

Any other card is fetched from Scryfall when you import it. It works as a "vanilla" card: its type, P/T, keywords (flying, deathtouch, haste…), mana abilities, madness, flashback, affinity, cycling and ninjutsu all work, but the rest of its rules text does not. These cards get a red **!** badge, and the import screen lists them.

To script a new card, add an entry to `src/engine/cards/scripts.ts`, put its name in `data/names.txt`, and run `npm run gen-cards` to bundle its Oracle text and image.

## Testing the engine

```bash
npx tsx scripts/sim.ts 40      # 40 headless AI-vs-AI games across the presets
npx tsx scripts/one.ts "Dimir Faeries" "Mono Red Madness" 3   # print one full game log
npx tsx scripts/combat-test.ts  # AI combat scenarios (chump to survive, lethal checks, crack-back)
npx tsx scripts/sideboard-check.ts  # what the AI sideboards in sample matchups
```

## Layout

- `src/engine/game.ts`: rules engine (zones, turns, priority, stack, combat, costs, triggers, SBA)
- `src/engine/mana.ts`: cost parsing and auto-payment solver
- `src/engine/cards/`: card data (`cardData.json`), scripts, registry and Scryfall fallback
- `src/engine/ai.ts`: heuristic computer opponent
- `src/ui/`: React UI (board, modals, human controller with Arena-style auto-pass)
