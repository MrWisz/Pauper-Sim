import { useRef } from 'react';
import type { Game } from '../engine/game';
import type { CardDef, CardInstance } from '../engine/types';
import { KeywordIcons } from './KeywordIcons';

export function CardFace({ def, className = '' }: { def: CardDef; className?: string }) {
  if (def.image && !def.isToken) {
    return <img className={`card-img ${className}`} src={def.image} alt={def.name} draggable={false} loading="lazy" />;
  }
  return (
    <div className={`card-text-face ${className} ${tokenColor(def)}`}>
      <div className="ctf-name">{def.name}</div>
      <div className="ctf-type">{def.typeLine}</div>
      <div className="ctf-oracle">{def.oracle}</div>
      {def.power !== undefined && (
        <div className="ctf-pt">
          {def.power}/{def.toughness}
        </div>
      )}
    </div>
  );
}

function tokenColor(def: CardDef) {
  if (def.colors.length === 0) return 'tc-colorless';
  return 'tc-' + def.colors[0];
}

interface Props {
  g: Game;
  card: CardInstance;
  size?: 'hand' | 'field' | 'small';
  highlight?: 'playable' | 'target' | 'selected' | 'attacking' | 'blocking' | null;
  onClick?: (c: CardInstance, e: React.MouseEvent) => void;
  onHover?: (c: CardInstance | null) => void;
  /** long-press (touch screens): show the card big without acting on it */
  onInspect?: (c: CardInstance) => void;
  badge?: string;
}

export function CardView({ g, card, size = 'field', highlight, onClick, onHover, onInspect, badge }: Props) {
  const press = useRef<{ timer: number; fired: boolean } | null>(null);
  const startPress = (e: React.PointerEvent) => {
    if (!onInspect || e.pointerType === 'mouse') return;
    const p = { timer: 0, fired: false };
    p.timer = window.setTimeout(() => {
      p.fired = true;
      onInspect(card);
    }, 450);
    press.current = p;
  };
  const endPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  const isCreature = g.isCreature(card) && card.zone === 'battlefield';
  const p = isCreature ? g.power(card) : 0;
  const t = isCreature ? g.toughness(card) : 0;
  const pMod = isCreature ? p - (card.def.power ?? 0) : 0;
  const tMod = isCreature ? t - (card.def.toughness ?? 0) - 0 : 0;
  const sick = isCreature && card.zone === 'battlefield' && g.isSick(card) && card.controller === g.active;
  const counters = Object.entries(card.counters).filter(([, n]) => n > 0);
  return (
    <div
      className={`card card-${size} ${card.tapped && card.zone === 'battlefield' ? 'tapped' : ''} ${card.attacking ? 'attacking' : ''} ${highlight ? 'hl-' + highlight : ''} ${
        onClick ? 'clickable' : ''
      }`}
      onClick={(e) => {
        e.stopPropagation();
        // a long-press already showed the card; don't also act on it
        if (press.current?.fired) {
          press.current = null;
          return;
        }
        onClick?.(card, e);
      }}
      onMouseEnter={() => onHover?.(card)}
      onMouseLeave={() => onHover?.(null)}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      onPointerCancel={endPress}
      onContextMenu={(e) => {
        if (onInspect) e.preventDefault();
      }}
      data-card-id={card.id}
    >
      <CardFace def={card.def} />
      {!card.def.implemented && (
        <div className="badge-unimpl" title="This card's text isn't scripted — only its type, P/T, keywords and mana abilities work.">
          !
        </div>
      )}
      {isCreature && (
        <div className={`pt ${pMod > 0 || tMod > 0 ? 'pt-up' : ''} ${pMod < 0 || tMod < 0 ? 'pt-down' : ''} ${card.damage ? 'pt-dmg' : ''}`}>
          {p}/{t - card.damage}
        </div>
      )}
      {card.damage > 0 && <div className="dmg">-{card.damage}</div>}
      {sick && <div className="sick" title="Summoning sick">zzz</div>}
      {counters.length > 0 && (
        <div className="counters">
          {counters.map(([k, n]) => (
            <span key={k}>
              {k === 'stun' ? '⊘' : k} ×{n}
            </span>
          ))}
        </div>
      )}
      {card.zone === 'battlefield' && <KeywordIcons g={g} card={card} />}
      {card.attacking && <div className="combat-badge atk">ATK</div>}
      {card.blocking !== null && <div className="combat-badge blk">BLK</div>}
      {badge && <div className="extra-badge">{badge}</div>}
    </div>
  );
}

export function CardBack({ small }: { small?: boolean }) {
  return <div className={`card-back ${small ? 'small' : ''}`} />;
}
