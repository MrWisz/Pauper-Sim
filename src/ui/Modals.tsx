import { useEffect, useState } from 'react';
import type { Game } from '../engine/game';
import type { CardInstance, ChoiceRequest, ManaColor } from '../engine/types';
import { CardView } from './CardView';

const COLOR_NAME: Record<ManaColor, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };

export function Modals({
  g,
  req,
  respond,
  onHover,
  onInspect,
}: {
  g: Game;
  req: ChoiceRequest;
  respond: (v: any) => void;
  onHover: (c: CardInstance | null) => void;
  onInspect?: (c: CardInstance) => void;
}) {
  const [sel, setSel] = useState<number[]>([]);
  const [bottom, setBottom] = useState<Set<number>>(new Set());
  const [order, setOrder] = useState<number[]>([]);
  const [minimized, setMinimized] = useState(false);
  const [num, setNum] = useState(0);
  useEffect(() => {
    setSel([]);
    setBottom(new Set());
    setOrder(req.type === 'scry' ? req.cards.map((c) => c.id) : []);
    setMinimized(false);
    if (req.type === 'number') setNum(req.max);
  }, [req]);

  const toggle = (id: number, max: number) => {
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : max === 1 ? [id] : s.length >= max ? s : [...s, id]));
  };

  const shell = (title: string, body: React.ReactNode, buttons: React.ReactNode, sub?: string) =>
    minimized ? (
      <div className="modal-min" onClick={() => setMinimized(false)}>
        ▲ {title}
      </div>
    ) : (
      <div className="modal-backdrop">
        <div className="modal wide">
          <div className="modal-title">
            {title}
            <button className="min-btn" title="Hide to look at the board" onClick={() => setMinimized(true)}>
              ▼
            </button>
          </div>
          {sub && <div className="modal-sub">{sub}</div>}
          {body}
          <div className="btns">{buttons}</div>
        </div>
      </div>
    );

  const cardGrid = (cards: CardInstance[], max: number, badge?: (c: CardInstance) => string | undefined) => (
    <div className="modal-cards">
      {cards.map((c) => (
        <CardView
          key={c.id}
          g={g}
          card={c}
          size="hand"
          highlight={sel.includes(c.id) ? 'selected' : null}
          onClick={() => toggle(c.id, max)}
          onHover={onHover}
          onInspect={onInspect}
          badge={badge?.(c) ?? (sel.includes(c.id) && max > 1 ? `#${sel.indexOf(c.id) + 1}` : undefined)}
        />
      ))}
    </div>
  );

  switch (req.type) {
    case 'mulligan': {
      const n = 7 - req.mulligans - 1;
      return shell(
        req.mulligans ? `Mulligan ${req.mulligans}: keep this hand?` : 'Opening hand',
        <div className="modal-cards">
          {req.hand.map((c) => (
            <CardView key={c.id} g={g} card={c} size="hand" onHover={onHover}
          onInspect={onInspect} />
          ))}
        </div>,
        <>
          <button className="btn secondary" onClick={() => respond(false)}>
            Mulligan (to {n})
          </button>
          <button className="btn primary" onClick={() => respond(true)}>
            Keep
          </button>
        </>,
        req.mulligans ? `You will put ${req.mulligans} card${req.mulligans > 1 ? 's' : ''} on the bottom.` : undefined,
      );
    }
    case 'bottom':
      return shell(
        `Choose ${req.count} card${req.count > 1 ? 's' : ''} to put on the bottom`,
        cardGrid(req.cards, req.count),
        <button className="btn primary" disabled={sel.length !== req.count} onClick={() => respond(sel)}>
          Confirm
        </button>,
      );
    case 'mode':
      return shell(
        `${req.source.def.name}: choose one`,
        <div className="mode-list">
          {req.options.map((o, i) => (
            <button key={i} className="btn mode" disabled={!o.enabled} onClick={() => respond(i)}>
              {o.text}
            </button>
          ))}
        </div>,
        req.cancellable ? (
          <button className="btn secondary" onClick={() => respond(null)}>
            Cancel
          </button>
        ) : null,
      );
    case 'cards': {
      const ok = sel.length >= req.min && sel.length <= req.max;
      // when the choices come from several zones (e.g. Highway Robbery: hand or battlefield), show them in labelled groups
      const ZONE_ORDER = ['hand', 'battlefield', 'graveyard', 'exile', 'library'] as const;
      const ZONE_LABEL: Record<string, string> = {
        hand: 'In your hand',
        battlefield: 'On the battlefield',
        graveyard: 'In your graveyard',
        exile: 'In exile',
        library: 'In your library',
      };
      const zones = ZONE_ORDER.filter((z) => req.cards.some((c) => c.zone === z));
      const picked = sel.length === 1 ? req.cards.find((c) => c.id === sel[0]) : undefined;
      // with mixed zones, say what will happen to the picked card
      const verb =
        zones.length > 1 && picked && req.purpose === 'discard'
          ? picked.zone === 'hand'
            ? `Discard ${picked.def.name}`
            : `Sacrifice ${picked.def.name}`
          : null;
      return shell(
        req.prompt,
        zones.length > 1 ? (
          <div className="scry-areas">
            {zones.map((z) => (
              <div key={z} className="scry-area">
                <div className="scry-label">{ZONE_LABEL[z]}</div>
                {cardGrid(
                  req.cards.filter((c) => c.zone === z),
                  req.max,
                )}
              </div>
            ))}
          </div>
        ) : (
          cardGrid(req.cards, req.max)
        ),
        <>
          {req.cancellable && (
            <button className="btn secondary" onClick={() => respond(null)}>
              Cancel
            </button>
          )}
          {req.min === 0 && sel.length === 0 && (
            <button className="btn secondary" onClick={() => respond([])}>
              Skip
            </button>
          )}
          <button className="btn primary" disabled={!ok} onClick={() => respond(sel)}>
            {verb ?? `Confirm${req.max > 1 ? ` (${sel.length}/${req.max})` : ''}`}
          </button>
        </>,
        req.source ? `Source: ${req.source.def.name}` : undefined,
      );
    }
    case 'yesno':
      return shell(
        req.prompt,
        req.source ? (
          <div className="modal-cards">
            <CardView g={g} card={req.source} size="hand" onHover={onHover}
          onInspect={onInspect} />
          </div>
        ) : null,
        <>
          <button className="btn secondary" onClick={() => respond(false)}>
            No
          </button>
          <button className="btn primary" onClick={() => respond(true)}>
            Yes
          </button>
        </>,
      );
    case 'color':
      return shell(
        req.purpose ? `${req.source.def.name}: choose a color` : `${req.source.def.name}: choose mana`,
        <div className="mode-list">
          {req.options.map((o, i) => (
            <button key={i} className={`btn mode mana-${o[0]}`} onClick={() => respond(i)}>
              {o.map((m) => COLOR_NAME[m]).join(' + ')}
            </button>
          ))}
        </div>,
        req.purpose ? null : (
          <button className="btn secondary" onClick={() => respond(null)}>
            Cancel
          </button>
        ),
      );
    case 'scry': {
      // display order doubles as library order: left-most top card is drawn first
      const ord = order.length === req.cards.length ? order : req.cards.map((c) => c.id);
      const byId = new Map(req.cards.map((c) => [c.id, c]));
      const topIds = ord.filter((id) => !bottom.has(id));
      const bottomIds = ord.filter((id) => bottom.has(id));
      const move = (id: number, dir: -1 | 1) => {
        const group = bottom.has(id) ? bottomIds : topIds;
        const i = group.indexOf(id);
        const other = group[i + dir];
        if (other === undefined) return;
        const next = [...ord];
        const a = next.indexOf(id);
        const b = next.indexOf(other);
        [next[a], next[b]] = [next[b], next[a]];
        setOrder(next);
      };
      const slot = (id: number, i: number, group: number[], isTop: boolean) => {
        const c = byId.get(id)!;
        return (
          <div key={id} className="scry-slot">
            <CardView
              g={g}
              card={c}
              size="hand"
              onHover={onHover}
          onInspect={onInspect}
              highlight={isTop ? 'selected' : null}
              badge={isTop ? (i === 0 ? 'Next draw' : `Draw #${i + 1}`) : group.length > 1 ? `Bottom #${i + 1}` : 'Bottom'}
            />
            <div className="scry-btns">
              <button className="btn small secondary" disabled={i === 0} onClick={() => move(id, -1)} title="Move left">
                ◀
              </button>
              <button
                className="btn small secondary"
                onClick={() => setBottom((b) => (isTop ? new Set([...b, id]) : new Set([...b].filter((x) => x !== id))))}
              >
                {isTop ? 'To bottom' : 'To top'}
              </button>
              <button className="btn small secondary" disabled={i === group.length - 1} onClick={() => move(id, 1)} title="Move right">
                ▶
              </button>
            </div>
          </div>
        );
      };
      return shell(
        `Scry ${req.cards.length}`,
        <div className="scry-areas">
          <div className="scry-area">
            <div className="scry-label">Top of library — left card is drawn first</div>
            <div className="modal-cards">
              {topIds.length ? topIds.map((id, i) => slot(id, i, topIds, true)) : <div className="empty">No cards on top</div>}
            </div>
          </div>
          <div className="scry-area">
            <div className="scry-label">Bottom of library</div>
            <div className="modal-cards">
              {bottomIds.length ? bottomIds.map((id, i) => slot(id, i, bottomIds, false)) : <div className="empty">No cards on the bottom</div>}
            </div>
          </div>
        </div>,
        <button className="btn primary" onClick={() => respond({ top: topIds, bottom: bottomIds })}>
          Done
        </button>,
        'Use ◀ ▶ to change the order, and To top / To bottom to move cards between piles.',
      );
    }
    case 'number': {
      const n = Math.max(req.min, Math.min(req.max, num));
      return shell(
        req.prompt,
        <div className="number-pick">
          <CardView g={g} card={req.source} size="hand" onHover={onHover} onInspect={onInspect} />
          <div className="number-controls">
            <button className="btn secondary" disabled={n <= req.min} onClick={() => setNum(n - 1)}>
              −
            </button>
            <span className="number-value">X = {n}</span>
            <button className="btn secondary" disabled={n >= req.max} onClick={() => setNum(n + 1)}>
              +
            </button>
          </div>
          <div className="modal-sub">You can afford up to X = {req.max}.</div>
        </div>,
        <>
          <button className="btn secondary" onClick={() => respond(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => respond(n)}>
            Cast with X = {n}
          </button>
        </>,
      );
    }
    case 'order':
      return shell(
        req.prompt,
        cardGrid(req.cards, req.cards.length),
        <button className="btn primary" disabled={sel.length !== req.cards.length} onClick={() => respond(sel)}>
          Confirm
        </button>,
      );
    default:
      return null;
  }
}
