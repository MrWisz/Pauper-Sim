// AI sideboarding between games of a best-of-3.
// It only knows the opponent cards it has seen in earlier games (battlefield, graveyard, exile, stack),
// sizes up the matchup from them, and swaps in sideboard cards that answer what it saw.
import type { CardDef } from './types';

export interface MatchupProfile {
  seen: number;
  blue: number;
  red: number;
  artifacts: number;
  enchantments: number;
  hexproof: number;
  graveyard: number;
  creatures: number;
  smallCreatures: number;
  fliers: number;
  sorceries: number;
  instants: number;
  burn: number;
}

export function profile(seen: CardDef[]): MatchupProfile {
  const p: MatchupProfile = {
    seen: seen.length,
    blue: 0,
    red: 0,
    artifacts: 0,
    enchantments: 0,
    hexproof: 0,
    graveyard: 0,
    creatures: 0,
    smallCreatures: 0,
    fliers: 0,
    sorceries: 0,
    instants: 0,
    burn: 0,
  };
  for (const d of seen) {
    if (d.types.includes('Land')) continue;
    if (d.colors.includes('U')) p.blue++;
    if (d.colors.includes('R')) p.red++;
    if (d.types.includes('Artifact')) p.artifacts++;
    if (d.types.includes('Enchantment')) p.enchantments++;
    if (d.keywords.includes('hexproof')) p.hexproof++;
    if (d.flashback || d.madness || d.triggers?.some((t) => t.zone === 'graveyard')) p.graveyard++;
    if (d.types.includes('Creature')) {
      p.creatures++;
      if ((d.toughness ?? 0) <= 2) p.smallCreatures++;
      if (d.keywords.includes('flying')) p.fliers++;
    }
    if (d.types.includes('Sorcery')) p.sorceries++;
    if (d.types.includes('Instant')) p.instants++;
    if (d.ai?.kind === 'burn' || d.ai?.kind === 'drain') p.burn++;
  }
  return p;
}

/** How much we want this sideboard card in against this opponent (0 = not at all). */
export function sideInValue(d: CardDef, p: MatchupProfile): number {
  const n = d.name;
  if (n === 'Pyroblast' || n === 'Red Elemental Blast') return p.blue >= 3 ? 4 + p.blue * 0.3 : 0;
  if (n === 'Hydroblast' || n === 'Blue Elemental Blast') return p.red >= 3 ? 4 + p.red * 0.3 : 0;
  if (n === 'Tithing Blade') return p.hexproof >= 2 ? 5 : p.creatures >= 6 ? 3 : 0;
  if (n === 'Pulse of Murasa' || n === 'Spinewoods Paladin') return p.burn >= 4 ? 3.5 + p.burn * 0.1 : 0;
  if (n === 'Vitu-Ghazi Inspector') return p.fliers >= 4 ? 3.5 : 0;
  if (n === 'Monstrous Emergence') return p.creatures >= 6 && p.hexproof < 2 ? 3.5 : 0;
  if (n === 'Steel Sabotage') return p.artifacts >= 5 ? 4 + p.artifacts * 0.2 : 0;
  if (n === 'Gut Shot') return p.smallCreatures >= 5 ? 3.5 + p.smallCreatures * 0.1 : 0;
  if (n === 'Murmuring Mystic') return p.creatures <= 4 && p.instants + p.sorceries >= 8 ? 3.5 : 0;
  if (n === 'Annul') return p.artifacts + p.enchantments >= 5 ? 4 + p.artifacts * 0.2 : 0;
  if (n === 'Envelop') return p.sorceries >= 4 ? 4 : 0;
  if (n === 'Dispel') return p.instants >= 4 ? 3.5 : 0;
  if (d.ai?.kind === 'artifactRemoval' || n === 'Vandalblast') return p.artifacts >= 5 ? 4 + p.artifacts * 0.2 : 0;
  if (n === 'Thraben Charm') return p.enchantments >= 4 ? 5 : p.graveyard >= 4 ? 3 : 0;
  if (n === 'Extract a Confession') return p.hexproof >= 2 ? 5 : p.creatures >= 6 ? 3 : 0;
  if (['Relic of Progenitus', 'Nihil Spellbomb', 'Faerie Macabre', 'Bojuka Bog'].includes(n)) return p.graveyard >= 3 ? 3.5 + p.graveyard * 0.2 : 0;
  if (['Arms of Hadar', 'End the Festivities', 'Suffocating Fumes', 'Krark-Clan Shaman'].includes(n))
    return p.smallCreatures >= 5 ? 4 + p.smallCreatures * 0.1 : 0;
  if (n === 'Scattershot Archer') return p.fliers >= 4 ? 4 : 0;
  if (n === 'Campfire' || n === 'Spirit Link') return p.burn >= 4 ? 3.5 : 0;
  if (n === 'Searing Blaze' || n === 'Dark Withering' || n === 'Ram Through' || d.ai?.kind === 'removal')
    return p.creatures >= 6 && p.hexproof < 2 ? 3 : 0;
  if (n === "Hunter's Blowgun") return p.fliers >= 4 ? 3 : 0;
  return 0;
}

/** How much a main-deck card is worth in this matchup (lower = cut first). */
export function keepValue(d: CardDef, p: MatchupProfile): number {
  if (d.types.includes('Land')) return 100;
  let v = 3;
  if (d.types.includes('Creature')) v += 1.5;
  // engines the deck is built around
  if (d.ai?.kind === 'draw' || d.madness) v += 1;
  if (['Pestilence', 'Gray Merchant of Asphodel', 'Crypt Rats'].includes(d.name)) v += 3;
  if (d.ai?.kind === 'burn' && (d.ai.amount ?? 2) >= 3) v += 0.5;
  if (d.name === 'Fireblast') v -= 1.5; // situational finisher: first to go
  // removal is great against creature decks (unless they're hexproof)
  if ((d.ai?.kind === 'removal' || d.ai?.kind === 'burn') && p.creatures >= 6 && p.hexproof < 2) v += 1;
  const targetedCreatureRemoval = d.ai?.kind === 'removal' && d.name !== 'Extract a Confession' && d.name !== "Chainer's Edict";
  // targeted removal is bad against hexproof creatures
  if (targetedCreatureRemoval && p.hexproof >= 2) v -= 3.5;
  // counters are weak against cheap aggressive decks with few spells worth countering
  if (d.ai?.kind === 'counter' && p.creatures >= 8 && p.sorceries + p.instants < 4) v -= 1.5;
  // little burn is weaker against big creatures / no creatures
  if (d.ai?.kind === 'burn' && (d.ai.amount ?? 2) <= 1 && p.smallCreatures < 3) v -= 1.5;
  return v;
}

export interface SideboardResult {
  main: CardDef[];
  side: CardDef[];
  swapsIn: string[];
  swapsOut: string[];
}

/** Swap up to `maxSwaps` cards from the 75, starting from the original main deck. */
export function aiSideboard(main: CardDef[], side: CardDef[], seen: CardDef[], maxSwaps = 8): SideboardResult {
  const p = profile(seen);
  const newMain = [...main];
  const newSide = [...side];
  const swapsIn: string[] = [];
  const swapsOut: string[] = [];
  if (p.seen < 3) return { main: newMain, side: newSide, swapsIn, swapsOut };

  const ins = newSide
    .map((d) => ({ d, v: sideInValue(d, p) }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v);
  const brought = new Set<number>();
  for (const { d, v } of ins) {
    if (swapsIn.length >= maxSwaps) break;
    // cut the least useful main-deck card, if it's worth less than what comes in
    let worst = -1;
    for (let i = 0; i < newMain.length; i++) {
      if (brought.has(i)) continue; // never cut what we just brought in
      if (worst < 0 || keepValue(newMain[i], p) < keepValue(newMain[worst], p)) worst = i;
    }
    if (worst < 0 || keepValue(newMain[worst], p) >= v) break;
    const out = newMain.splice(worst, 1, d)[0];
    brought.add(worst);
    newSide.splice(newSide.indexOf(d), 1, out);
    swapsIn.push(d.name);
    swapsOut.push(out.name);
  }
  return { main: newMain, side: newSide, swapsIn, swapsOut };
}
