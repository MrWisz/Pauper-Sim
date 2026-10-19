import rawData from './cardData.json';
import { scripts, tokenScripts } from './scripts';
import { cycling, mana, ninjutsu } from './helpers';
import { registerTokens } from '../game';
import type { ActivatedDef, CardDef, Color, Keyword, ManaColor } from '../types';

export interface RawCard {
  name: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  oracle: string;
  colors: string[];
  power?: string;
  toughness?: string;
  keywords: string[];
  image?: string;
  art?: string;
}

registerTokens(tokenScripts);

const KEYWORDS: Keyword[] = [
  'flying',
  'deathtouch',
  'haste',
  'flash',
  'lifelink',
  'indestructible',
  'reach',
  'trample',
  'vigilance',
  'first strike',
  'double strike',
  'defender',
  'menace',
  'hexproof',
  'ward',
];

const SUPERTYPES = ['Basic', 'Legendary', 'Snow', 'World', 'Token'];
const BASIC_MANA: Record<string, ManaColor> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

export const normalizeName = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .trim();

const rawByName = new Map<string, RawCard>();
for (const r of Object.values(rawData as Record<string, RawCard>)) rawByName.set(normalizeName(r.name), r);

/** Cards fetched from Scryfall at import time (not in the bundled data). */
const extraRaw = new Map<string, RawCard>();

function parseTypeLine(tl: string) {
  const [left, right] = tl.split('—').map((s) => s.trim());
  const words = left.split(/\s+/).filter(Boolean);
  return {
    supertypes: words.filter((w) => SUPERTYPES.includes(w)),
    types: words.filter((w) => !SUPERTYPES.includes(w)),
    subtypes: right ? right.split(/\s+/).filter(Boolean) : [],
  };
}

function stripReminder(text: string) {
  return text.replace(/\([^)]*\)/g, '').trim();
}

/** Parse "{T}: Add {B} or {R}." / "{T}: Add {B}{R}." style abilities */
function parseManaAbilities(oracle: string): ManaColor[][] | null {
  const m = oracle.match(/\{T\}: Add ((?:\{[WUBRGC]\}(?:,? or |, )?)+)/);
  if (!m) return null;
  const part = m[1];
  if (/ or |, /.test(part)) {
    return [...part.matchAll(/\{([WUBRGC])\}/g)].map((x) => [x[1] as ManaColor]);
  }
  return [[...part.matchAll(/\{([WUBRGC])\}/g)].map((x) => x[1] as ManaColor)];
}

/** Lines we can fully support without a script */
function isGenericallySupported(oracle: string, keywords: Keyword[]) {
  const lines = oracle
    .split('\n')
    .map((l) => stripReminder(l))
    .filter(Boolean);
  return lines.every((l) => {
    if (/^\{T\}: Add [{}WUBRGC ,or]+\.?$/.test(l)) return true;
    if (/^This (land|creature|artifact) enters tapped\.$/.test(l)) return true;
    if (/^(Madness|Flashback|Cycling|Ninjutsu) \{[^ ]+$/.test(l)) return true;
    if (/^Affinity for artifacts$/.test(l)) return true;
    if (/^Ward (\{[^}]+\})+$/.test(l) || /^Ward\s*—\s*Pay \d+ life\.?$/.test(l)) return true;
    const parts = l
      .toLowerCase()
      .split(/,\s*/)
      .map((s) => s.trim());
    return parts.every((p) => KEYWORDS.includes(p as Keyword));
  });
}

export function buildDef(raw: RawCard): CardDef {
  const tl = parseTypeLine(raw.typeLine);
  const keywords = raw.keywords.map((k) => k.toLowerCase()).filter((k) => KEYWORDS.includes(k as Keyword)) as Keyword[];
  const script = scripts[raw.name] ?? {};
  const hasScript = raw.name in scripts;
  const oracle = raw.oracle;

  const def: CardDef = {
    name: raw.name,
    manaCost: raw.manaCost,
    cmc: raw.cmc,
    typeLine: raw.typeLine,
    types: tl.types,
    subtypes: tl.subtypes,
    supertypes: tl.supertypes,
    colors: raw.colors as Color[],
    power: raw.power !== undefined ? parseInt(raw.power, 10) || 0 : undefined,
    toughness: raw.toughness !== undefined ? parseInt(raw.toughness, 10) || 0 : undefined,
    oracle,
    image: raw.image,
    art: raw.art,
    keywords,
    implemented: hasScript || isGenericallySupported(oracle, keywords),
  };

  // generic text features
  const madness = oracle.match(/Madness (\{[^ ]+\})/);
  if (madness) def.madness = madness[1];
  const fb = oracle.match(/Flashback (\{[^ —]+\})/);
  if (fb) def.flashback = { mana: fb[1] };
  if (/Affinity for artifacts/.test(oracle)) def.affinity = true;
  const ward = oracle.match(/^Ward ((?:\{[^}]+\})+)/m);
  if (ward) def.wardCost = ward[1];
  const wardLife = oracle.match(/^Ward\s*—\s*Pay (\d+) life/m);
  if (wardLife) def.wardLife = +wardLife[1];
  if (/enters tapped\./.test(oracle) && !/unless/.test(oracle)) def.entersTapped = true;

  const activated: ActivatedDef[] = [];
  const scriptAct = script.activated ?? [];
  const scriptHasMana = scriptAct.some((a) => a.produces && !a.cost.mana);
  if (tl.types.includes('Land') && !scriptHasMana) {
    const basics = tl.subtypes.filter((s) => s in BASIC_MANA).map((s) => [BASIC_MANA[s]]);
    const parsed = parseManaAbilities(oracle);
    if (parsed) activated.push(mana(...parsed));
    else if (basics.length) activated.push(mana(...basics));
  }
  const cyc = oracle.match(/^Cycling (\{[^ ]+)/m);
  if (cyc && !scriptAct.some((a) => a.label?.startsWith('Cycling'))) activated.push(cycling(cyc[1]));
  const nin = oracle.match(/^Ninjutsu (\{[^ ]+)/m);
  if (nin && !scriptAct.some((a) => a.label?.startsWith('Ninjutsu'))) activated.push(ninjutsu(nin[1]));
  activated.push(...scriptAct);

  Object.assign(def, script);
  def.activated = activated;
  def.keywords = keywords;

  // Auras target what they will enchant as they are cast
  if (tl.subtypes.includes('Aura')) {
    const m = oracle.match(/^Enchant (creature you control|creature|land|Forest)/m);
    const kinds = { 'creature you control': 'creatureYouControl', creature: 'creature', land: 'land', Forest: 'Forest' } as const;
    def.enchant ??= m ? kinds[m[1] as keyof typeof kinds] : 'creature';
    if (!def.spell) {
      def.spell = {
        targets: [
          {
            kind: 'permanent',
            prompt: `Choose what ${def.name} will enchant`,
            filter: (g, t, ctx) => t.kind === 'card' && !!g.card(t.id) && g.canEnchant(ctx.source, g.card(t.id)!, ctx.controller),
          },
        ],
      };
    }
  }
  return def;
}

const defCache = new Map<string, CardDef>();

export function getDef(name: string): CardDef | undefined {
  const key = normalizeName(name.split('//')[0]);
  if (defCache.has(key)) return defCache.get(key);
  const raw = rawByName.get(key) ?? extraRaw.get(key);
  if (!raw) return undefined;
  const def = buildDef(raw);
  defCache.set(key, def);
  return def;
}

export function knownLocally(name: string) {
  const key = normalizeName(name.split('//')[0]);
  return rawByName.has(key) || extraRaw.has(key);
}

const LS_KEY = 'pauper-sim-extra-cards-v1';
try {
  const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Record<string, RawCard>;
  for (const r of Object.values(saved)) extraRaw.set(normalizeName(r.name), r);
} catch {
  /* storage unavailable */
}

/** Fetch cards we don't have bundled from Scryfall. Returns names that couldn't be found. */
export async function fetchMissing(names: string[]): Promise<string[]> {
  const missing = [...new Set(names.filter((n) => !knownLocally(n)))];
  const notFound: string[] = [];
  for (let i = 0; i < missing.length; i += 70) {
    const chunk = missing.slice(i, i + 70);
    const res = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifiers: chunk.map((name) => ({ name: name.split('//')[0].trim() })) }),
    });
    if (!res.ok) throw new Error('Scryfall request failed: ' + res.status);
    const json = await res.json();
    for (const nf of json.not_found ?? []) notFound.push(nf.name);
    for (const c of json.data ?? []) {
      const face = c.card_faces ? c.card_faces[0] : c;
      const raw: RawCard = {
        name: c.name.split(' // ')[0],
        manaCost: face.mana_cost ?? '',
        cmc: c.cmc,
        typeLine: face.type_line ?? c.type_line,
        oracle: face.oracle_text ?? '',
        colors: c.colors ?? face.colors ?? [],
        power: face.power,
        toughness: face.toughness,
        keywords: c.keywords ?? [],
        image: (c.image_uris ?? face.image_uris)?.normal,
        art: (c.image_uris ?? face.image_uris)?.art_crop,
      };
      extraRaw.set(normalizeName(raw.name), raw);
    }
  }
  try {
    const obj: Record<string, RawCard> = {};
    for (const [k, v] of extraRaw) obj[k] = v;
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
  return notFound;
}
