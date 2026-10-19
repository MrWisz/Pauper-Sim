import { fetchMissing, getDef } from './cards/registry';
import type { CardDef } from './types';

export interface DeckEntry {
  count: number;
  name: string;
}

export interface ParsedDeck {
  main: DeckEntry[];
  side: DeckEntry[];
}

/** Accepts MTGO/MTGGoldfish/Arena/Moxfield style text lists. */
export function parseDeckList(text: string): ParsedDeck {
  const main: DeckEntry[] = [];
  const side: DeckEntry[] = [];
  let inSide = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (main.length) inSide = true;
      continue;
    }
    if (/^(deck|main ?deck|maindeck)$/i.test(line)) continue;
    if (/^(sideboard|side ?board:?)$/i.test(line) || /^sb:?$/i.test(line)) {
      inSide = true;
      continue;
    }
    if (/^(commander|companion|about|name )/i.test(line)) continue;
    let l = line.replace(/^SB:\s*/i, () => {
      inSide = true;
      return '';
    });
    const m = l.match(/^(\d+)\s*x?\s+(.+)$/i);
    let count = 1;
    let name = l;
    if (m) {
      count = parseInt(m[1], 10);
      name = m[2];
    }
    // strip set code / collector number e.g. "Lightning Bolt (M10) 146" or "*F*"
    name = name.replace(/\s+\([A-Z0-9]{2,6}\)(\s+[\w-]+)?\s*$/i, '').replace(/\s+\*[A-Z]+\*$/, '').trim();
    (inSide ? side : main).push({ count, name });
  }
  return { main, side };
}

export interface BuiltDeck {
  cards: CardDef[];
  /** sideboard (used between games of a best-of-3) */
  side: CardDef[];
  unimplemented: string[];
  notFound: string[];
}

export async function buildDeck(text: string): Promise<BuiltDeck> {
  const parsed = parseDeckList(text);
  const names = [...parsed.main, ...parsed.side].map((e) => e.name);
  let notFound: string[] = [];
  if (names.some((n) => !getDef(n))) notFound = await fetchMissing(names);
  const unimplemented = new Set<string>();
  const resolve = (entries: DeckEntry[]) => {
    const out: CardDef[] = [];
    for (const e of entries) {
      const def = getDef(e.name);
      if (!def) {
        if (!notFound.includes(e.name)) notFound.push(e.name);
        continue;
      }
      if (!def.implemented) unimplemented.add(def.name);
      for (let i = 0; i < e.count; i++) out.push(def);
    }
    return out;
  };
  const cards = resolve(parsed.main);
  const side = resolve(parsed.side);
  return { cards, side, unimplemented: [...unimplemented], notFound };
}

export const PRESETS: Record<string, string> = {
  'Selesnya Bogles': `4 Abundant Growth
4 Ancestral Mask
1 Angelic Gift
3 Armadillo Cloak
1 Ash Barrens
1 Benevolent Blessing
2 Bushwhack
1 Cartouche of Solidarity
4 Ethereal Armor
9 Forest
4 Gladecover Scout
1 Heliod's Pilgrim
3 Malevolent Rumble
3 Plains
3 Rancor
3 Sheltering Landscape
3 Silhana Ledgewalker
4 Slippery Bogle
2 Spirit Link
4 Utopia Sprawl

1 Benevolent Blessing
2 Call Damage Control
2 Flaring Pain
2 Ram Through
2 Scattershot Archer
1 Sentinel's Eyes
2 Spirit Link
3 Thraben Charm`,
  'Rakdos Madness': `4 Alms of the Vein
4 Faithless Looting
4 Fiery Temper
4 Grab the Prize
4 Highway Robbery
4 Jagged Barrens
4 Kitchen Imp
4 Lightning Bolt
9 Mountain
2 Razortrap Gorge
4 Sneaky Snacker
5 Swamp
4 Vampire's Kiss
4 Voldaren Epicure

4 Cast into the Fire
4 Dark Withering
2 Extract a Confession
1 Faerie Macabre
2 Nihil Spellbomb
2 Red Elemental Blast`,
  'Mono Red Madness': `4 Voldaren Epicure
4 Kessig Flamebreather
4 Sneaky Snacker
3 Guttersnipe
3 Faithless Looting
4 Grab the Prize
4 Highway Robbery
4 Lava Dart
4 Lightning Bolt
4 Fiery Temper
3 Fireblast
19 Mountain

2 End the Festivities
4 Pyroblast
2 Red Elemental Blast
3 Relic of Progenitus
2 Searing Blaze
2 Smash to Smithereens`,
  'Grixis Affinity': `2 Baleful Strix
1 Black Mage's Rod
2 Blood Fountain
1 Cryogen Relic
1 Cut Down
4 Drossforge Bridge
1 Fanatical Offering
4 Galvanic Blast
2 Giant's Boulder
1 Great Furnace
2 Ichor Wellspring
2 Krark-Clan Shaman
1 Makeshift Munitions
3 Mistvault Bridge
4 Myr Enforcer
2 Nihil Spellbomb
4 Reckoner's Bargain
4 Refurbished Familiar
3 Seat of the Synod
4 Silverbluff Bridge
1 Swamp
4 Thoughtcast
4 Utrom Monitor
3 Vault of Whispers

1 Blue Elemental Blast
2 Envelop
1 Hunter's Blowgun
3 Hydroblast
1 Krark-Clan Shaman
1 Nihil Spellbomb
4 Pyroblast
2 Vandalblast`,
  'Dimir Faeries': `1 Agony Warp
2 Augur of Bolas
4 Baleful Strix
1 Bojuka Bog
4 Brainstorm
2 Cast Down
4 Counterspell
2 Dispel
1 Extract a Confession
3 Faerie Seer
4 Ice Tunnel
10 Island
4 Lorien Revealed
1 Moon-Circuit Hacker
1 Mukotai Ambusher
2 Ninja of the Deep Hours
2 Seething Landscape
4 Snuff Out
4 Spellstutter Sprite
1 Suffocating Fumes
1 Swamp
2 Thorn of the Black Rose

4 Annul
2 Arms of Hadar
2 Blue Elemental Blast
1 Campfire
4 Hydroblast
2 Relic of Progenitus`,
};
