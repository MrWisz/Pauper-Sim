import { useLayoutEffect, useRef, useState } from 'react';
import type { Game, FxEvent } from '../engine/game';
import type { CardDef, PlayerId } from '../engine/types';
import { CardFace } from './CardView';

type Overlay = { id: number; ms: number } & (
  | { kind: 'float'; x: number; y: number; text: string; tone: 'dmg' | 'gain' | 'info' }
  | { kind: 'ghost'; rect: DOMRect; def: CardDef; to: string }
  | { kind: 'ring'; rect: DOMRect }
  | { kind: 'spotlight'; def: CardDef; caption: string; mine: boolean }
  | { kind: 'banner'; text: string; mine: boolean }
  | { kind: 'combat'; text: string }
);

let seq = 0;

/** Turns the engine's visual events into short-lived overlays (damage numbers, dying cards, cast spotlights…). */
export function FxLayer({ g, me }: { g: Game; me: PlayerId }) {
  const rects = useRef(new Map<number, DOMRect>());
  const seen = useRef(g.fx.length ? g.fx[g.fx.length - 1].id : 0);
  const [overlays, setOverlays] = useState<Overlay[]>([]);

  useLayoutEffect(() => {
    const fresh = g.fx.filter((e) => e.id > seen.current);
    if (fresh.length) {
      seen.current = fresh[fresh.length - 1].id;
      const add: Overlay[] = [];
      for (const e of fresh) add.push(...toOverlays(e));
      if (add.length) {
        setOverlays((o) => [...o, ...add]);
        for (const o of add) setTimeout(() => setOverlays((cur) => cur.filter((x) => x.id !== o.id)), o.ms);
      }
    }
    // remember where every visible card is, so we can animate cards that just left
    document.querySelectorAll<HTMLElement>('.board .row [data-card-id], .board .hand [data-card-id]').forEach((el) => {
      rects.current.set(+el.dataset.cardId!, el.getBoundingClientRect());
    });
  });

  function cardRect(id: number): DOMRect | undefined {
    const el = document.querySelector<HTMLElement>(`.board .row [data-card-id="${id}"]`);
    return el ? el.getBoundingClientRect() : rects.current.get(id);
  }
  function playerRect(pid: PlayerId) {
    return document.querySelector<HTMLElement>(`.avatar[data-pid="${pid}"]`)?.getBoundingClientRect();
  }
  const center = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

  function toOverlays(e: FxEvent): Overlay[] {
    const id = () => ++seq;
    switch (e.type) {
      case 'turn':
        return [{ id: id(), ms: 1700, kind: 'banner', text: e.player === me ? 'Your Turn' : "Opponent's Turn", mine: e.player === me }];
      case 'cast':
        return [
          {
            id: id(),
            ms: e.controller === me ? 1000 : 1800,
            kind: 'spotlight',
            def: e.card.def,
            caption: `${e.controller === me ? 'You cast' : 'Opponent casts'}${e.text && e.text !== e.card.def.name ? ' — ' + e.text : ''}`,
            mine: e.controller === me,
          },
        ];
      case 'damage': {
        const r = e.target.kind === 'player' ? playerRect(e.target.pid) : e.target.kind === 'card' ? cardRect(e.target.id) : undefined;
        if (!r) return [];
        const c = center(r);
        return [
          { id: id(), ms: 1300, kind: 'float', x: c.x, y: c.y, text: `-${e.amount}`, tone: 'dmg' },
          { id: id(), ms: 600, kind: 'ring', rect: r },
        ];
      }
      case 'life': {
        if (e.amount < 0) {
          const r = playerRect(e.pid);
          if (!r) return [];
          const c = center(r);
          return [{ id: id(), ms: 1300, kind: 'float', x: c.x, y: c.y, text: `${e.amount}`, tone: 'dmg' }];
        }
        const r = playerRect(e.pid);
        if (!r) return [];
        const c = center(r);
        return [{ id: id(), ms: 1300, kind: 'float', x: c.x, y: c.y, text: `+${e.amount}`, tone: 'gain' }];
      }
      case 'leave': {
        const r = rects.current.get(e.card.id);
        if (!r || e.card.def.isToken && e.to !== 'graveyard') return [];
        return [{ id: id(), ms: 900, kind: 'ghost', rect: r, def: e.card.def, to: e.to }];
      }
      case 'trigger': {
        const r = cardRect(e.card.id);
        return r ? [{ id: id(), ms: 900, kind: 'ring', rect: r }] : [];
      }
      case 'countered':
        return [{ id: id(), ms: 1300, kind: 'float', x: window.innerWidth / 2, y: window.innerHeight / 2 - 60, text: `${e.card.def.name} countered!`, tone: 'info' }];
      case 'combat':
        return [{ id: id(), ms: 1300, kind: 'combat', text: e.text }];
    }
  }

  return (
    <div className="fx-layer">
      {overlays.map((o) => {
        switch (o.kind) {
          case 'float':
            return (
              <div key={o.id} className={`fx-float fx-${o.tone}`} style={{ left: o.x, top: o.y }}>
                {o.text}
              </div>
            );
          case 'ring':
            return <div key={o.id} className="fx-ring" style={{ left: o.rect.left, top: o.rect.top, width: o.rect.width, height: o.rect.height }} />;
          case 'ghost':
            return (
              <div
                key={o.id}
                className={`fx-ghost fx-ghost-${o.to}`}
                style={{ left: o.rect.left, top: o.rect.top, width: o.rect.width, height: o.rect.height }}
              >
                <CardFace def={o.def} />
              </div>
            );
          case 'spotlight':
            return (
              <div key={o.id} className={`fx-spotlight ${o.mine ? 'mine' : 'theirs'}`}>
                <div className="fx-spot-caption">{o.caption}</div>
                <CardFace def={o.def} />
              </div>
            );
          case 'banner':
            return (
              <div key={o.id} className={`fx-banner ${o.mine ? 'mine' : 'theirs'}`}>
                {o.text}
              </div>
            );
          case 'combat':
            return (
              <div key={o.id} className="fx-combat">
                ⚔ {o.text}
              </div>
            );
        }
      })}
    </div>
  );
}
