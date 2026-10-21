import type { Game } from './game';

export type PlayerId = 0 | 1;
export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';
export type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack' | 'none';

export type Step =
  | 'untap'
  | 'upkeep'
  | 'draw'
  | 'main1'
  | 'beginCombat'
  | 'declareAttackers'
  | 'declareBlockers'
  | 'firstStrikeDamage'
  | 'combatDamage'
  | 'endCombat'
  | 'main2'
  | 'end'
  | 'cleanup';

export type Keyword =
  | 'flying'
  | 'deathtouch'
  | 'haste'
  | 'flash'
  | 'lifelink'
  | 'indestructible'
  | 'reach'
  | 'trample'
  | 'vigilance'
  | 'first strike'
  | 'double strike'
  | 'defender'
  | 'menace'
  | 'hexproof'
  | 'ward';

/** A reference to something that can be targeted. */
export type Target =
  | { kind: 'player'; pid: PlayerId }
  | { kind: 'card'; id: number }
  | { kind: 'stack'; id: number };

export interface TargetSpec {
  prompt: string;
  /** What kinds of objects this spec can point at. */
  kind: 'any' | 'player' | 'permanent' | 'stack' | 'graveyardCard';
  filter?: (g: Game, t: Target, ctx: TargetCtx) => boolean;
  /** Min/max number of targets for this spec (default 1/1). */
  min?: number;
  max?: number;
  /** Must be different from the targets chosen for these earlier spec indexes. */
  distinctFrom?: number[];
}

export interface TargetCtx {
  controller: PlayerId;
  source: CardInstance;
  /** targets already chosen for earlier specs */
  chosen: Target[][];
}

export interface Ctx {
  g: Game;
  me: PlayerId;
  opp: PlayerId;
  src: CardInstance;
  targets: Target[][];
  mode: number;
  info: CastInfo;
  item?: StackItem;
}

export interface CastInfo {
  method: 'normal' | 'madness' | 'flashback' | 'plot' | 'alt' | 'overload' | 'bestow' | 'omen' | 'foretell';
  /** kicker paid */
  kicked?: boolean;
  /** number of times replicate was paid */
  replicate?: number;
  /** spells cast before this one this turn (storm) */
  storm?: number;
  /** value chosen for X */
  x?: number;
  altIndex?: number;
  sacrificed?: { mv: number; name: string; wasCreature: boolean };
  discarded?: CardInstance;
  evidence?: boolean;
  /** Trigger-specific payload (event that caused it). */
  event?: GameEvent;
}

export interface SpellMode {
  text: string;
  targets?: TargetSpec[];
  resolve: (c: Ctx) => Promise<void>;
}

export interface SpellDef {
  targets?: TargetSpec[];
  resolve?: (c: Ctx) => Promise<void>;
  modes?: SpellMode[];
}

export interface AdditionalCost {
  kind: 'discard' | 'sacrifice' | 'collectEvidence';
  optional?: boolean;
  amount?: number;
  filter?: (g: Game, card: CardInstance) => boolean;
  prompt: string;
}

export interface AltCost {
  label: string;
  canPay: (g: Game, card: CardInstance, pid: PlayerId) => boolean;
  pay: (g: Game, card: CardInstance, pid: PlayerId) => Promise<boolean>;
  /** mana that must still be paid (default none) */
  mana?: string;
}

export interface ActivatedCost {
  mana?: string;
  tap?: boolean;
  sacSelf?: boolean;
  exileSelf?: boolean;
  discardSelf?: boolean;
  life?: number;
  sacrifice?: { filter: (g: Game, c: CardInstance) => boolean; prompt: string; count?: number };
  /** discard this many other cards from hand */
  discard?: number;
  returnUnblocked?: boolean;
  /** return a permanent you control to its owner's hand (Quirion Ranger) */
  returnPermanent?: { filter: (g: Game, c: CardInstance) => boolean; prompt: string };
}

export interface ActivatedDef {
  text: string;
  /** Short label for buttons */
  label?: string;
  zone?: 'battlefield' | 'hand' | 'graveyard';
  cost: ActivatedCost;
  targets?: TargetSpec[];
  sorcery?: boolean;
  /** Mana abilities resolve immediately and don't use the stack. */
  produces?: ManaColor[][];
  /** mana amount that depends on the board (Priest of Titania) */
  producesFn?: (g: Game, card: CardInstance) => ManaColor[][];
  /** {X} paid with this color only (Crypt Rats: "Spend only black mana on X") */
  xMana?: ManaColor;
  /** "Activate only once each turn" */
  oncePerTurn?: boolean;
  /** Special actions (plot) don't use the stack either. */
  special?: boolean;
  canActivate?: (g: Game, card: CardInstance, pid: PlayerId) => boolean;
  resolve: (c: Ctx) => Promise<void>;
  /** Hint for the AI */
  ai?: 'cycle' | 'ninjutsu' | 'draw' | 'damage' | 'removal' | 'utility' | 'plot' | 'never';
}

export type GameEvent =
  | { type: 'etb'; card: CardInstance }
  | { type: 'ltb'; card: CardInstance; to: Zone; wasCreature: boolean; wasArtifact: boolean; controller: PlayerId }
  | { type: 'cast'; card: CardInstance; controller: PlayerId }
  | { type: 'draw'; player: PlayerId; nth: number }
  | { type: 'combatDamagePlayer'; source: CardInstance; player: PlayerId; amount: number }
  | { type: 'step'; step: Step; active: PlayerId }
  | { type: 'discard'; card: CardInstance; player: PlayerId };

export interface TriggerDef {
  text: string;
  event: GameEvent['type'];
  /** Zone the source must be in to trigger (default battlefield). */
  zone?: Zone;
  match: (g: Game, self: CardInstance, ev: GameEvent) => boolean;
  targets?: TargetSpec[];
  resolve: (c: Ctx) => Promise<void>;
}

/** Static bonus an Aura or Equipment gives to the permanent it is attached to. */
export interface StaticGrant {
  power?: number | ((g: Game, host: CardInstance, self: CardInstance) => number);
  toughness?: number | ((g: Game, host: CardInstance, self: CardInstance) => number);
  keywords?: (g: Game, host: CardInstance, self: CardInstance) => Keyword[];
  subtypes?: string[];
  /** "Whenever enchanted creature deals damage, you gain that much life" */
  damageLifegain?: boolean;
  /** protection from the color chosen as the Aura entered */
  protectionFromChosen?: boolean;
  /** enchanted land: "{T}: Add one mana of any color" */
  anyColorMana?: boolean;
  /** enchanted land adds one extra mana of the chosen color when tapped */
  extraChosenMana?: boolean;
}

export interface CardDef {
  name: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  types: string[];
  subtypes: string[];
  supertypes: string[];
  colors: Color[];
  power?: number;
  toughness?: number;
  oracle: string;
  image?: string;
  art?: string;
  keywords: Keyword[];
  implemented: boolean;
  isToken?: boolean;

  entersTapped?: boolean | ((g: Game, card: CardInstance) => boolean);
  spell?: SpellDef;
  additionalCost?: AdditionalCost;
  altCosts?: AltCost[];
  triggers?: TriggerDef[];
  activated?: ActivatedDef[];
  affinity?: boolean;
  /** generic cost reduction (Tolarian Terror, Deem Inferior…) */
  costReduction?: (g: Game, card: CardInstance, pid: PlayerId) => number;
  /** back face of a transforming double-faced card */
  backFace?: CardDef;
  /** Changeling: every creature type */
  changeling?: boolean;
  /** Bestow cost: cast as an Aura that becomes a creature again when unattached */
  bestow?: string;
  /** "This permanent enters with X +1/+1 counters" */
  entersWithXCounters?: boolean;
  /** Omen half (Sagu Wildling // Roost Seek): a sorcery that shuffles the card back into the library */
  omen?: { name: string; manaCost: string; text: string; resolve: (c: Ctx) => Promise<void> };
  /** Kicker cost (optional extra cost) */
  kicker?: string;
  /** Replicate cost (pay any number of times to copy the spell) */
  replicate?: string;
  /** Storm: copy it for each spell cast before it this turn */
  storm?: boolean;
  /** Foretell cost: exile face down for {2} on your turn, cast later for this */
  foretell?: string;
  /** extra condition to be able to cast at all */
  castCondition?: (g: Game, card: CardInstance, pid: PlayerId) => boolean;
  /** Ward {N} (mana) or Ward—Pay N life */
  wardCost?: string;
  wardLife?: number;
  madness?: string;
  flashback?: {
    mana?: string;
    altLabel?: string;
    label?: string;
    canPay?: AltCost['canPay'];
    pay?: AltCost['pay'];
    /** escape: unlike flashback, the card isn't exiled afterwards */
    escape?: boolean;
  };
  overload?: string;
  /** Static bonus granted to the permanent this Aura/Equipment is attached to. */
  grant?: StaticGrant;
  /** Aura: what it can enchant */
  enchant?: 'creature' | 'creatureYouControl' | 'land' | 'Forest';
  /** "As this enters, choose a color" */
  chooseColor?: 'protection' | 'mana';
  /** extra blocking restriction, e.g. "can't be blocked except by creatures with flying" */
  canBeBlockedBy?: (g: Game, attacker: CardInstance, blocker: CardInstance) => boolean;
  /** Hints that tell the AI what a spell/ability is for */
  ai?: AiHint;
}

export interface AiHint {
  kind:
    | 'burn'
    | 'removal'
    | 'counter'
    | 'draw'
    | 'drain'
    | 'sweeper'
    | 'pump'
    | 'discard'
    | 'gyHate'
    | 'artifactRemoval'
    | 'blast'
    | 'fog'
    | 'other';
  amount?: number;
  /** only cast at instant speed in response / end of turn */
  reactive?: boolean;
}

export interface CardInstance {
  id: number;
  def: CardDef;
  owner: PlayerId;
  controller: PlayerId;
  zone: Zone;
  tapped: boolean;
  damage: number;
  deathtouched: boolean;
  enteredTick: number;
  counters: Record<string, number>;
  attachedTo: number | null;
  tempPower: number;
  tempToughness: number;
  tempKeywords: Keyword[];
  attacking: boolean;
  blocking: number | null;
  blockedBy: number[];
  wasBlocked: boolean;
  plottedTurn: number | null;
  /** front face while transformed (the card reverts when it leaves the battlefield) */
  frontDef?: CardDef;
  /** how it was cast (X, evidence…), kept while it's on the battlefield */
  castInfo?: CastInfo;
  /** cast with bestow and attached: it's an Aura, not a creature */
  bestowed?: boolean;
  /** keywords "until your next turn" (Undercity's Throne of the Dead Three) */
  nextTurnKeywords?: Keyword[];
  /** goaded by this player until their next turn: must attack */
  goadedBy?: PlayerId;
  /** turn number each activated ability (by index) was last used, for once-per-turn abilities */
  lastActivated?: Record<number, number>;
  /** turn it was foretold (exiled face down) */
  foretoldTurn?: number;
  /** color chosen as it entered (Utopia Sprawl, Benevolent Blessing) */
  chosenColor?: Color;
  /** turn number this permanent entered (for "entered this turn") */
  enteredTurn: number;
}

export interface StackItem {
  id: number;
  kind: 'spell' | 'ability';
  controller: PlayerId;
  card: CardInstance;
  text: string;
  targets: Target[][];
  specs: TargetSpec[];
  mode: number;
  info: CastInfo;
  resolve?: (c: Ctx) => Promise<void>;
  /** mana value of the spell (for Spellstutter etc.) */
  mv: number;
}

export interface Player {
  id: PlayerId;
  name: string;
  life: number;
  library: CardInstance[];
  hand: CardInstance[];
  graveyard: CardInstance[];
  exile: CardInstance[];
  pool: Record<ManaColor, number>;
  landsPlayedThisTurn: number;
  drawsThisTurn: number;
  landEnteredThisTurn: boolean;
  lost: boolean;
  drewFromEmpty: boolean;
  mulligans: number;
  /** Circle of Protection: Blue shields left this turn */
  copBlue?: number;
}

export type Action =
  | { type: 'pass' }
  | { type: 'playLand'; cardId: number }
  | { type: 'cast'; cardId: number; method: CastInfo['method']; altIndex?: number }
  | { type: 'activate'; cardId: number; index: number };

export type ChoiceRequest =
  | { type: 'priority'; player: PlayerId }
  | { type: 'mulligan'; player: PlayerId; hand: CardInstance[]; mulligans: number }
  | { type: 'bottom'; player: PlayerId; cards: CardInstance[]; count: number }
  | {
      type: 'targets';
      player: PlayerId;
      spec: TargetSpec;
      candidates: Target[];
      source: CardInstance;
      cancellable: boolean;
    }
  | { type: 'mode'; player: PlayerId; source: CardInstance; options: { text: string; enabled: boolean }[]; cancellable: boolean }
  | {
      type: 'cards';
      player: PlayerId;
      prompt: string;
      cards: CardInstance[];
      min: number;
      max: number;
      cancellable?: boolean;
      /** reason, for the AI */
      purpose: 'discard' | 'sacrifice' | 'putBack' | 'reveal' | 'search' | 'exileGraveyard' | 'returnLand' | 'other' | 'evidence' | 'graveyardReturn' | 'takeAll' | 'strongest' | 'shuffleBack' | 'bounceOwn';
      source?: CardInstance;
    }
  | { type: 'yesno'; player: PlayerId; prompt: string; purpose: string; source?: CardInstance }
  | { type: 'color'; player: PlayerId; options: ManaColor[][]; source: CardInstance; purpose?: 'mana' | 'protection' | 'sprawl' }
  | { type: 'attackers'; player: PlayerId; candidates: CardInstance[] }
  | { type: 'blockers'; player: PlayerId; attackers: CardInstance[]; candidates: CardInstance[] }
  | { type: 'scry'; player: PlayerId; cards: CardInstance[] }
  | { type: 'order'; player: PlayerId; prompt: string; cards: CardInstance[] }
  | { type: 'number'; player: PlayerId; prompt: string; min: number; max: number; source: CardInstance; purpose: 'x' | 'replicate' };

export interface Controller {
  choose(g: Game, req: ChoiceRequest): Promise<any>;
}
