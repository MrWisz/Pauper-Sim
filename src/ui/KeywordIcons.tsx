import type { Game } from '../engine/game';
import type { CardInstance, Keyword } from '../engine/types';

/** Icon + display name for each keyword ability we track. Flash is left out: it doesn't matter once a card is on the battlefield. */
const KEYWORDS: { k: Keyword; icon: string; name: string }[] = [
  { k: 'flying', icon: '🕊️', name: 'Flying' },
  { k: 'reach', icon: '🕸️', name: 'Reach' },
  { k: 'first strike', icon: '🗡️', name: 'First strike' },
  { k: 'double strike', icon: '⚔️', name: 'Double strike' },
  { k: 'deathtouch', icon: '☠️', name: 'Deathtouch' },
  { k: 'lifelink', icon: '❤️', name: 'Lifelink' },
  { k: 'trample', icon: '🦶', name: 'Trample' },
  { k: 'vigilance', icon: '👁️', name: 'Vigilance' },
  { k: 'haste', icon: '⚡', name: 'Haste' },
  { k: 'menace', icon: '😈', name: 'Menace' },
  { k: 'hexproof', icon: '🧿', name: 'Hexproof' },
  { k: 'ward', icon: '🌀', name: 'Ward' },
  { k: 'indestructible', icon: '💎', name: 'Indestructible' },
  { k: 'defender', icon: '🧱', name: 'Defender' },
];

const COLOR_NAME: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };

export interface KeywordChip {
  key: string;
  icon: string;
  /** natural = printed on the card; granted = from an Aura/Equipment; temp = until end of turn */
  origin: 'natural' | 'granted' | 'temp';
  title: string;
  /** small corner label, e.g. ward cost or protection color */
  sub?: string;
}

/** Every keyword-like ability a permanent currently has, and where it comes from. */
export function keywordChips(g: Game, c: CardInstance): KeywordChip[] {
  const out: KeywordChip[] = [];
  const atts = g.attachments(c);
  for (const { k, icon, name } of KEYWORDS) {
    if (!g.hasKeyword(c, k)) continue;
    if (c.def.keywords.includes(k)) {
      const wardCost = k === 'ward' ? c.def.wardCost ?? (c.def.wardLife ? `pay ${c.def.wardLife} life` : '') : '';
      out.push({
        key: k,
        icon,
        origin: 'natural',
        title: k === 'ward' ? `Ward ${wardCost} — opponents' spells and abilities that target it are countered unless they pay` : name,
        sub: k === 'ward' ? wardCost.replace(/[{}]/g, '') || undefined : undefined,
      });
      continue;
    }
    const from = atts.filter((e) => e.def.grant?.keywords?.(g, c, e).includes(k)).map((e) => e.def.name);
    if (from.length) out.push({ key: k, icon, origin: 'granted', title: `${name} — from ${from.join(', ')}` });
    else if (c.tempKeywords.includes(k)) out.push({ key: k, icon, origin: 'temp', title: `${name} — until end of turn` });
    else out.push({ key: k, icon, origin: 'granted', title: name });
  }
  // abilities that aren't keywords but change how combat works
  for (const col of g.protections(c)) {
    const src = atts.find((e) => e.def.grant?.protectionFromChosen && e.chosenColor === col);
    out.push({
      key: 'pro-' + col,
      icon: '🛡️',
      origin: 'granted',
      title: `Protection from ${COLOR_NAME[col] ?? col}${src ? ` — from ${src.def.name}` : ''}`,
      sub: col,
    });
  }
  const links = atts.filter((e) => e.def.grant?.damageLifegain).map((e) => e.def.name);
  if (links.length)
    out.push({ key: 'lifegain', icon: '💗', origin: 'granted', title: `You gain life equal to the damage it deals — from ${links.join(', ')}` });
  if (c.def.canBeBlockedBy) out.push({ key: 'evasion', icon: '🚫', origin: 'natural', title: "Can't be blocked except by creatures with flying" });
  return out;
}

export function KeywordIcons({ g, card }: { g: Game; card: CardInstance }) {
  const chips = keywordChips(g, card);
  if (!chips.length) return null;
  return (
    <div className="kw-strip">
      {chips.map((ch) => (
        <span key={ch.key} className={`kw-chip kw-${ch.origin}`} title={ch.title}>
          {ch.icon}
          {ch.sub && <span className="kw-pro">{ch.sub}</span>}
        </span>
      ))}
    </div>
  );
}
