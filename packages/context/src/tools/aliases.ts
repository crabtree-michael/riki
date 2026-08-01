/**
 * How a player says a thing, versus what it is called.
 *
 * The agent speaks the way a player does: `sf`, `shadow fiend` and `nevermore` are one hero; `bkb`
 * and `black king bar` are one item. That is a lookup table, and it belongs in one place rather
 * than in eight handlers (§4.3).
 *
 * **Not exhaustive, and deliberately so.** A full hero and item table is patch data, and dota2 §2.4
 * treats patch data as `ReferenceDataPort`'s job — baking 120+ heroes into source is a table that
 * is wrong the day a hero is renamed and that nobody notices, because the fuzzy matcher covers for
 * it. What lives here is the set a canonical name alone does *not* get you: nicknames and
 * abbreviations. §4.3's fuzzy-match rate is the maintenance signal for when this needs feeding.
 */

/** Canonical id → the ways it gets said. Canonical ids are Valve's `npc_dota_hero_*` suffixes. */
const HERO_ALIASES: Readonly<Record<string, readonly string[]>> = {
  nevermore: ['sf', 'shadow fiend'],
  windrunner: ['wr', 'windranger'],
  zuus: ['zeus'],
  wisp: ['io'],
  obsidian_destroyer: ['od', 'outworld destroyer', 'outworld devourer'],
  queenofpain: ['qop', 'queen of pain'],
  vengefulspirit: ['venge', 'vengeful spirit'],
  shadow_shaman: ['rhasta', 'shadow shaman'],
  witch_doctor: ['wd', 'witch doctor'],
  crystal_maiden: ['cm', 'crystal maiden', 'rylai'],
  drow_ranger: ['drow', 'traxex'],
  anti_mage: ['am', 'anti mage', 'antimage', 'magina'],
  centaur: ['cent', 'centaur warrunner'],
  furion: ["nature's prophet", 'natures prophet', 'np', 'prophet'],
  necrolyte: ['necro', 'necrophos'],
  doom_bringer: ['doom'],
  skeleton_king: ['wk', 'wraith king'],
  treant: ['treant protector'],
  magnataur: ['magnus'],
  rattletrap: ['clockwerk', 'clock'],
  life_stealer: ['naix', 'lifestealer'],
  nyx_assassin: ['nyx'],
  templar_assassin: ['ta', 'templar assassin', 'lanaya'],
  phantom_assassin: ['pa', 'phantom assassin', 'mortred'],
  phantom_lancer: ['pl', 'phantom lancer'],
  keeper_of_the_light: ['kotl', 'keeper of the light'],
  legion_commander: ['lc', 'legion commander', 'tresdin'],
  ember_spirit: ['ember'],
  storm_spirit: ['storm'],
  earth_spirit: ['earth spirit'],
  void_spirit: ['void spirit'],
  faceless_void: ['fv', 'void', 'faceless void'],
  night_stalker: ['ns', 'night stalker'],
  sand_king: ['sk', 'sand king'],
  dragon_knight: ['dk', 'dragon knight'],
  troll_warlord: ['troll'],
  winter_wyvern: ['ww', 'winter wyvern'],
  arc_warden: ['arc'],
  monkey_king: ['mk', 'monkey king'],
  spirit_breaker: ['sb', 'spirit breaker', 'bara'],
  bounty_hunter: ['bh', 'bounty hunter', 'gondar'],
  naga_siren: ['naga'],
  ogre_magi: ['ogre'],
};

const ITEM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  black_king_bar: ['bkb', 'black king bar'],
  blink: ['blink dagger', 'dagger'],
  power_treads: ['treads', 'power treads'],
  magic_wand: ['wand'],
  magic_stick: ['stick'],
  ultimate_scepter: ['aghs', "aghanim's scepter", 'aghanims scepter', 'scepter'],
  aghanims_shard: ['shard', "aghanim's shard", 'aghanims shard'],
  manta: ['manta style'],
  butterfly: ['bfly'],
  bfury: ['battlefury', 'battle fury', 'bf'],
  radiance: [],
  desolator: ['deso'],
  assault: ['ac', 'assault cuirass'],
  heart: ['heart of tarrasque'],
  satanic: [],
  sheepstick: ['scythe of vyse', 'sheep stick', 'hex'],
  orchid: ['orchid malevolence'],
  bloodthorn: ['bloodthorne'],
  silver_edge: ['se'],
  shivas_guard: ["shiva's guard", 'shivas guard', 'shivas'],
  pipe: ['pipe of insight'],
  crimson_guard: ['cg', 'crimson guard'],
  lotus_orb: ['lotus'],
  force_staff: ['force'],
  glimmer_cape: ['glimmer'],
  ghost: ['ghost scepter'],
  eul: ['eul scepter', 'euls', "eul's scepter of divinity", 'cyclone'],
  refresher: ['refresher orb'],
  octarine_core: ['octarine'],
  travel_boots: ['bots', 'boots of travel'],
  arcane_boots: ['arcanes', 'arcane boots'],
  tranquil_boots: ['tranquils', 'tranquil boots'],
  phase_boots: ['phase', 'phase boots'],
};

/** Named capture regions the sidecar knows. Tier 3 is the only tier that names one (§3.3). */
const REGION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  minimap: ['map', 'mini map', 'mini-map'],
  scoreboard: ['score', 'top bar', 'topbar'],
  shop: ['store'],
  hud: ['bottom bar', 'status bar'],
  inventory: ['items', 'bag'],
  killfeed: ['kill feed', 'feed'],
};

/** `spoken form → canonical id`, built once. Canonical ids map to themselves. */
function invert(table: Readonly<Record<string, readonly string[]>>): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [canonical, spokens] of Object.entries(table)) {
    out.set(normalise(canonical), canonical);
    for (const spoken of spokens) {
      const key = normalise(spoken);
      // First declaration wins: `od` appears under two canonical heroes because Valve renamed one,
      // and silently taking the later one would resolve a live hero to a dead id.
      if (!out.has(key)) out.set(key, canonical);
    }
  }
  return out;
}

/** Lowercase, strip punctuation, collapse whitespace. `Anti-Mage` and `anti mage` are one key. */
export function normalise(spoken: string): string {
  return spoken
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const HERO_BY_SPOKEN = invert(HERO_ALIASES);
export const ITEM_BY_SPOKEN = invert(ITEM_ALIASES);
export const REGION_BY_SPOKEN = invert(REGION_ALIASES);

export const KNOWN_REGIONS: readonly string[] = Object.keys(REGION_ALIASES);
