import type { ManaColor } from './types';

export interface Cost {
  generic: number;
  W: number;
  U: number;
  B: number;
  R: number;
  G: number;
  C: number;
  /** hybrid symbols like {G/U}: each entry lists the colors that can pay it */
  hybrid?: ManaColor[][];
  /** Phyrexian symbols like {R/P}: payable with that color or 2 life */
  phyrexian?: ManaColor[];
  /** number of {X} symbols; the caster picks X and it's added to `generic` */
  x?: number;
}

export const COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];
const SINGLE = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

export function emptyCost(): Cost {
  return { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

export function emptyPool(): Record<ManaColor, number> {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

export function parseCost(s: string | undefined): Cost {
  const c = emptyCost();
  if (!s) return c;
  for (const m of s.matchAll(/\{([^}]+)\}/g)) {
    const sym = m[1];
    if (/^\d+$/.test(sym)) c.generic += parseInt(sym, 10);
    else if (sym === 'X') c.x = (c.x ?? 0) + 1;
    else if (/^[WUBRG]\/P$/.test(sym)) (c.phyrexian ??= []).push(sym[0] as ManaColor);
    else if (/^[WUBRGC]\/[WUBRGC]$/.test(sym)) (c.hybrid ??= []).push(sym.split('/') as ManaColor[]);
    else if (sym in c && sym !== 'generic' && sym !== 'hybrid') (c as any)[sym] += 1;
  }
  return c;
}

export function costMV(c: Cost): number {
  return c.generic + c.W + c.U + c.B + c.R + c.G + c.C + (c.hybrid?.length ?? 0) + (c.phyrexian?.length ?? 0);
}

export function costToString(c: Cost): string {
  let s = '';
  if (c.generic > 0 || costMV(c) === 0) s += `{${c.generic}}`;
  for (const k of SINGLE) s += `{${k}}`.repeat(c[k]);
  for (const h of c.hybrid ?? []) s += `{${h.join('/')}}`;
  return s;
}

export interface ManaSource {
  id: number;
  /** alternatives: each alternative is the list of mana it adds */
  options: ManaColor[][];
}

/**
 * Finds a way to pay `cost` using the floating pool first, then the given sources.
 * Returns the source ids to tap with the chosen option index, plus the pool left over,
 * or null if impossible.
 */
export function solvePayment(
  cost: Cost,
  pool: Record<ManaColor, number>,
  sources: ManaSource[],
): { taps: { id: number; option: number }[]; poolAfter: Record<ManaColor, number> } | null {
  const avail = { ...pool };
  // colored requirement slots: each slot is the set of colors that can pay it
  const slots: ManaColor[][] = [];
  for (const k of SINGLE) for (let i = 0; i < cost[k]; i++) slots.push([k]);
  for (const h of cost.hybrid ?? []) slots.push(h);
  const filled = slots.map(() => false);

  // Spend pool on single-color slots first, then hybrids
  slots.forEach((s, i) => {
    if (s.length === 1 && avail[s[0]] > 0) {
      avail[s[0]]--;
      filled[i] = true;
    }
  });
  slots.forEach((s, i) => {
    if (filled[i]) return;
    const c = s.find((x) => avail[x] > 0);
    if (c) {
      avail[c]--;
      filled[i] = true;
    }
  });

  // Least flexible sources first so flexible ones stay open
  const sorted = [...sources].sort((a, b) => flex(a) - flex(b));
  const taps: { id: number; option: number }[] = [];
  const used = new Set<number>();

  /** put one mana into the best unfilled slot (single-color slots first); returns slot index or -1 */
  const place = (m: ManaColor): number => {
    let best = -1;
    for (let i = 0; i < slots.length; i++) {
      if (filled[i] || !slots[i].includes(m)) continue;
      if (best < 0 || slots[i].length < slots[best].length) best = i;
    }
    if (best >= 0) filled[best] = true;
    return best;
  };

  const dfs = (): boolean => {
    const next = filled.indexOf(false);
    if (next < 0) return true;
    const want = slots[next];
    for (const s of sorted) {
      if (used.has(s.id)) continue;
      for (let oi = 0; oi < s.options.length; oi++) {
        const opt = s.options[oi];
        if (!opt.some((m) => want.includes(m))) continue;
        used.add(s.id);
        taps.push({ id: s.id, option: oi });
        const placed: number[] = [];
        const extra: ManaColor[] = [];
        // the mana that can pay the wanted slot goes there first
        const order = [...opt].sort((a, b) => Number(want.includes(b)) - Number(want.includes(a)));
        for (const m of order) {
          const i = place(m);
          if (i >= 0) placed.push(i);
          else {
            avail[m]++;
            extra.push(m);
          }
        }
        if (dfs()) return true;
        for (const i of placed) filled[i] = false;
        for (const m of extra) avail[m]--;
        taps.pop();
        used.delete(s.id);
      }
    }
    return false;
  };
  if (!dfs()) return null;

  // Generic: spend leftover pool (incl. excess from multi-mana sources), then least flexible sources
  let generic = cost.generic;
  for (const k of ['C', 'W', 'U', 'B', 'R', 'G'] as const) {
    const use = Math.min(avail[k], generic);
    avail[k] -= use;
    generic -= use;
  }
  for (const s of sorted) {
    if (generic <= 0) break;
    if (used.has(s.id)) continue;
    // pick the option with most mana (karoos, Utopia Sprawl)
    let best = 0;
    for (let oi = 1; oi < s.options.length; oi++) if (s.options[oi].length > s.options[best].length) best = oi;
    used.add(s.id);
    taps.push({ id: s.id, option: best });
    for (const m of s.options[best]) {
      if (generic > 0) generic--;
      else avail[m]++;
    }
  }
  if (generic > 0) return null;
  return { taps, poolAfter: avail };
}

function flex(s: ManaSource): number {
  const set = new Set<ManaColor>();
  for (const o of s.options) for (const m of o) set.add(m);
  // multi-mana sources are valuable; tap them last unless needed
  const amount = Math.max(...s.options.map((o) => o.length));
  return set.size + (amount > 1 ? 3 : 0);
}

export function totalAvailable(pool: Record<ManaColor, number>, sources: ManaSource[]): number {
  let n = 0;
  for (const k of COLORS) n += pool[k];
  for (const s of sources) n += Math.max(...s.options.map((o) => o.length));
  return n;
}
