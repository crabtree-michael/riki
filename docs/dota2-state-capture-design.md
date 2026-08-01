# Dota 2 State Capture & Context System — Design

**Status:** Draft / design proposal
**Scope:** How Riki observes a live Dota 2 match and turns that observation into context for the voice agent.
**Out of scope:** The voice pipeline itself (STT/TTS/barge-in), the agent's coaching prompt design, distribution/installer.

---

## 1. Design goals & constraints

Riki is a voice coach. The product promise — *invisible until needed* — sets the constraints more than anything else:

| Goal | Implication for state capture |
|---|---|
| Never costs the player frames | Capture must be GPU-side, region-limited, adaptive, and out-of-process. Budget: **≤3% of one CPU core average, ≤200 MB RSS, no measurable FPS delta**. |
| Never gets anyone VAC-banned | **Read-only observation only.** No memory reads, no injection, no overlay, no input synthesis. See §8. |
| Never gives unfair information | Riki may only reason about what the player can already see. See §8.2. |
| Sub-second responsiveness | The world model must be ≤250 ms stale when a turn starts. This is why the model lives *outside* the LLM. |
| Doesn't overwhelm the agent | The LLM never sees the raw stream. It sees a ~300-token snapshot plus an event tape, and pulls detail via tools. See §6. |
| Doesn't leak the player's desktop | Window-scoped capture, no raw frame persistence, no voice-chat capture by default. See §7. |

The single most important architectural decision: **the world model is a normal in-memory data structure, not a conversation transcript.** State arrives at 5–10 Hz; the agent speaks maybe once a minute. Coupling those rates would be ruinous for both cost and latency.

---

## 2. Source inventory

Three live sources plus one offline source. They differ enormously in trust, and the design keeps that difference explicit all the way to the agent.

### 2.1 Game State Integration (GSI) — primary, authoritative

Valve's officially sanctioned integration. The client POSTs JSON to a local HTTP endpoint. Requires the `-gamestateintegration` launch option and a config file at:

```
<steam>/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/gamestate_integration_riki.cfg
```

```
"Riki"
{
    "uri"       "http://127.0.0.1:53101/gsi"
    "timeout"   "5.0"
    "buffer"    "0.1"
    "throttle"  "0.1"
    "heartbeat" "30.0"
    "auth"      { "token" "<random-per-install-secret>" }
    "data"
    {
        "provider"  "1"
        "map"       "1"
        "player"    "1"
        "hero"      "1"
        "abilities" "1"
        "items"     "1"
        "buildings" "1"
        "draft"     "1"
        "wearables" "0"
    }
}
```

What we get (player mode):

- **`map`** — `clock_time`, `game_time`, `game_state` (pre-game / strategy / hero selection / in-progress / post-game), `daytime`, `matchid`, `radiant_score`/`dire_score`, `paused`, `ward_purchase_cooldown`, Roshan-related timers, `win_team`.
- **`player`** — `steamid`, `name`, `team_name`, K/D/A, `last_hits`, `denies`, `gold` (reliable/unreliable split), `gpm`, `xpm`, `net_worth`, `hero_damage`, wards purchased/placed/destroyed, `camps_stacked`, `runes_activated`, gold-source breakdown.
- **`hero`** — `id`, `name`, `level`, `xp`, `alive`, `respawn_seconds`, `health`/`max_health`/`health_percent`, mana equivalents, `xpos`/`ypos` (world coordinates), `buyback_cost`, `buyback_cooldown`, `smoked`, `has_debuff`, and the full status-effect set (`stunned`, `silenced`, `hexed`, `disarmed`, `muted`, `break`, `magicimmune`), plus `talent_1..8` and Aghanim's scepter/shard flags.
- **`abilities`** — per slot: `name`, `level`, `cooldown`, `can_cast`, `passive`, `ultimate`.
- **`items`** — inventory slots 0–8, stash, teleport slot, neutral slot: `name`, `cooldown`, `charges`, `can_cast`, `contains_rune`, `purchaser`.
- **`buildings`** — tower/barracks/ancient health for both teams, per lane.
- **`draft`** — picks and bans with hero IDs, active team, time remaining. Only populated during the draft phase.

**The critical limitation:** in a live game the client exposes *only the local player's* data. Full ten-player data, `minimap`, `roshan`, and `couriers` components exist but are gated to spectators/observers. Valve did this deliberately, for exactly the reason Riki should respect it. This gap is the entire justification for the vision layer (§2.2).

**Rate.** `throttle` is the floor on inter-update spacing; `buffer` coalesces changes within a window. `0.1`/`0.1` targets ~10 Hz, but observed delivery is closer to **2–8 Hz and irregular**, and it varies with client load. Treat the rate as *unreliable* — never derive timing from update count, always from `map.clock_time` and a local monotonic clock. `heartbeat` guarantees a POST at least every 30 s even when nothing changes, which doubles as our liveness check.

> **Verify before building:** exact throttle behaviour, and whether `buffer` can reorder. Linux/Proton has a history of GSI bugs (ValveSoftware/Dota-2 #2333, #1023) — validate the target platform early rather than assuming parity.

### 2.2 Screen capture + CV — secondary, probabilistic

Everything GSI won't tell us, and that the player can nonetheless see on screen:

| Region | Yields | Method |
|---|---|---|
| Minimap | Enemy/ally hero positions (when visible), ward icons, creep wave positions, building state, smoke/TP pings | Template + color matching on ~12 px icons |
| Top bar | Enemy hero identity, level, respawn timers, K/D/A, buyback state, net worth lead | Fixed-position digit templates |
| Scoreboard (Alt-held) | Enemy items, ability levels, gold | OCR + item icon matching, opportunistic |
| Chat / kill feed | All-chat and team chat text, kill/assist events, "missing" pings | Console log preferred (§2.3); OCR fallback |
| Shop panel | What the player is browsing — a strong intent signal for item advice | Icon matching |
| Own HUD | Cross-check against GSI; catches GSI dropouts | Digit templates |

**Capture stack.** Per-platform, always **window-scoped, never full-desktop**:

- **Windows:** `Windows.Graphics.Capture` (WGC) against the Dota 2 window handle. Frames stay on the GPU as D3D11 textures.
- **Linux:** PipeWire via the `org.freedesktop.portal.ScreenCast` portal, window-restricted. (Note the GSI-on-Linux caveat above; Linux may end up vision-primary.)
- **macOS:** ScreenCaptureKit with a window filter.

Requires **borderless windowed** mode — exclusive fullscreen breaks or degrades window capture on all three platforms. Detect it and prompt the user once.

**Pipeline.** Crop-first is the whole performance story:

```
GPU frame ──► GPU crop to N fixed regions ──► downscale ──► readback (small!)
                                                              │
                                                    per-region 64-bit hash
                                                              │
                                                   unchanged? ──► drop
                                                              │
                                                     changed ──► CV worker
```

Reading back only the crops instead of a 4K frame cuts PCIe traffic by ~50×. Hashing before CV means the scoreboard region costs nothing for the 95% of the match it isn't open.

**Recognition, cheapest-first.** Dota's UI is a fixed-layout, fixed-font, sprite-based renderer — general-purpose OCR is the wrong tool for most of it:

1. **Digit/glyph template matching** for all numerals (timers, gold, levels, K/D/A). Dota renders numerals from a known font at known positions. Templates are faster than Tesseract and far more accurate on small glyphs. Build the atlas once per HUD scale.
2. **Icon template matching** (normalized cross-correlation) for heroes, items, and abilities. ~130 heroes × ~300 items is a small, static, ship-with-the-binary atlas.
3. **Minimap hero detection** — icons are ~10–14 px with a team-colored ring and a player-color dot. Color-key first to candidate blobs, then match the glyph. Player colors are the discriminator, and they're stable.
4. **Real OCR** (PaddleOCR or Tesseract, small model) *only* for free text: chat. Runs on change, not on a timer.
5. **VLM on a downscaled frame** — the escape hatch. Only when the agent explicitly requests it (§6.3), rate-limited to ≤1 per 5 s, never on a schedule.

**Calibration is mandatory, not optional.** Hardcoded pixel coordinates will break on real users. Sources of variance: resolution, aspect ratio (21:9 and 32:9 are common), Dota's HUD scale slider, HUD skins, **the "minimap on the right" setting**, and colorblind mode (which changes team and player colors). A one-time calibration pass on first launch should template-match 3–4 invariant anchors to solve for scale + offset, verify minimap side, and snapshot the color palette. Re-run on any resolution-change event, and validate anchors every ~30 s in-game — silently degrading to garbage coordinates is the worst possible failure mode.

**Confidence is a first-class output.** Every CV-derived fact carries a match score and a timestamp. A minimap blob at 0.62 confidence is not the same claim as a GSI health value, and the distinction must survive all the way into the agent's context (§6.2).

### 2.3 Console log — cheap, high-value, near-free

Launching with `-condebug` makes the client write `console.log` in the game directory, which includes chat lines and assorted events. Tailing a file is dramatically cheaper and more accurate than OCR'ing the chat box, so this should be the **primary** chat source with OCR as fallback.

> **Verify:** exactly which events reach `console.log` on current builds, and whether `-condebug` interacts badly with anything. Log rotation/truncation needs handling.

### 2.4 External APIs — pre-game and on-demand

OpenDota / STRATZ / Steam Web API, used **out of band** (never in the hot loop):

- At draft/loading: hero matchup data, typical item builds and timings for the player's hero, lane matchup notes, the player's own recent history and hero comfort.
- On demand: item/ability lookup, patch notes for the current version.

Cache aggressively to disk with a patch-version key. These are the highest-value tokens in the whole system because they're static — they go in the **cached prompt prefix** (§6.1) and cost nearly nothing per turn.

---

## 3. Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  Dota 2 client (untouched — read-only, no injection)              │
└──┬──────────────────┬──────────────────┬──────────────────────────┘
   │ HTTP POST        │ window frames    │ console.log
   ▼                  ▼                  ▼
┌────────┐      ┌───────────┐      ┌──────────┐     ┌─────────────┐
│ GSI    │      │ Capture   │      │ Log      │     │ External    │
│ server │      │ + CV      │      │ tailer   │     │ APIs (async)│
│ 2-8 Hz │      │ 1-5 Hz    │      │ event    │     │ pre-game    │
└───┬────┘      └─────┬─────┘      └────┬─────┘     └──────┬──────┘
    │                 │                 │                  │
    └────────┬────────┴─────────────────┴──────────────────┘
             ▼
    ┌─────────────────────────────────────────┐
    │  FUSION  — reconcile, trust-rank, decay │
    └────────────────┬────────────────────────┘
                     ▼
    ┌─────────────────────────────────────────┐
    │  WORLD MODEL  (§4)                      │
    │  authoritative snapshot + confidence    │
    │  + staleness, versioned, ring history   │
    └───────┬─────────────────────────┬───────┘
            ▼                         ▼
    ┌───────────────┐        ┌──────────────────┐
    │ EVENT ENGINE  │        │ CONTEXT BUILDER  │
    │ deltas → NL   │───────►│ + TOOL SURFACE   │
    │ + salience    │        │ (§6)             │
    └───────┬───────┘        └────────┬─────────┘
            │                         │
            ▼                         ▼
    ┌───────────────┐         ┌────────────────┐
    │ TRIGGER POLICY│────────►│  VOICE AGENT   │
    │ speak or not? │         │  (LLM)         │
    └───────────────┘         └────────────────┘
```

Process boundaries: capture+CV in its **own process** at below-normal priority. If the CV worker wedges or crashes, the agent degrades to GSI-only rather than dying. The GSI server and world model are lightweight enough to share the main process.

---

## 4. The world model

One in-memory struct, single-writer (the fusion thread), read by everything else via an immutable versioned snapshot. Illustrative shape:

```
WorldModel
  meta:      match_id, patch, clock_time, game_state, is_paused,
             wall_clock_at_last_update, model_version
  self:      hero, level, xp_to_next, hp/max, mp/max, position,
             alive, respawn_in, buyback{cost, affordable, cooldown},
             gold{reliable, unreliable, total}, net_worth, gpm, xpm,
             kda, last_hits, denies,
             abilities[{name, level, cooldown, castable, is_ult}],
             items[{slot, name, charges, cooldown, castable}],
             stash[], backpack[], neutral, tp_scroll,
             statuses[stunned, silenced, hexed, break, smoked, ...],
             talents[], scepter, shard
  allies[4]: hero, level?, net_worth?, position?, alive?, last_seen_at   ← CV-derived
  enemies[5]:hero, level?, items_seen[], position?, alive?, respawn_in?,
             last_seen_at, last_seen_position, confidence
  map:       towers{}, barracks{}, ancients{}, roshan{state, window},
             runes{next_power_at, next_bounty_at}, daytime,
             creep_waves[]?, wards_seen[]
  derived:   lane_state, missing_heroes[], gold_advantage,
             xp_advantage, items_affordable[], power_spike_in
  history:   ring buffer (~5 min) of world-model deltas
  chat:      ring buffer of recent chat lines
```

Three rules govern every field:

1. **Provenance.** Each field records its source (`gsi` / `cv` / `log` / `api` / `derived`). GSI always wins conflicts; CV never overwrites a fresh GSI value.
2. **Staleness.** Each field records `last_updated`. Anything CV-derived becomes progressively less trustworthy — an enemy position from 12 s ago is a *hypothesis*, and the context layer must render it as one ("last seen mid ~12s ago"), never as a fact.
3. **Confidence.** CV facts carry their match score. Below a per-detector threshold, the fact is dropped rather than surfaced. Silence is much better than a confident hallucination in a voice product — a wrong "they're all mid" gets someone killed and destroys trust permanently.

**Derived state** is where most of the coaching value lives, and it's all cheap local computation, not LLM work: gold-until-key-item, respawn/buyback affordability, next rune spawn, Roshan window, "you have 3 slots and a full stash", stacking-camp timing, power-spike proximity. Compute these in the model and hand the agent the conclusion.

---

## 5. Refresh rates

Every source runs at the slowest rate that doesn't lose information. Reasoning matters more than the numbers, which should be tuned against real captures.

| Source | Rate | Rationale |
|---|---|---|
| GSI push | as delivered (~2–8 Hz) | Free — push-based. Covers all self-state including cooldowns and HP. |
| Minimap CV | 4–5 Hz | Hero move speed ~300 units/s; a minimap pixel is ~60 units. 5 Hz keeps positional error ≈1 px. Faster buys nothing. |
| Top bar CV | 1 Hz | Levels, respawn timers, K/D/A — all slow-moving. |
| Scoreboard CV | event-driven | Only when Alt/scoreboard is up. Detected by region hash, costs nothing otherwise. |
| Shop CV | event-driven | Only when the shop panel is open. |
| Chat (log tail) | event-driven | Push, effectively free. |
| Chat OCR (fallback) | 2 Hz on change | Only if the log path is unavailable. |
| Full-frame VLM | on demand, ≤0.2 Hz | Expensive in latency, tokens, and privacy. Agent-invoked only. |
| External APIs | once pre-game + on demand | Cached by patch version. |
| Derived recompute | on world-model change, coalesced to 10 Hz | Pure CPU, microseconds. |
| Agent context refresh | at turn boundaries + on high-salience events | See §6. |

**Adaptive degradation.** If the CV worker's frame budget is exceeded, or a Dota frame-time probe shows stutter, shed load in this order: full-frame VLM → scoreboard → top bar → minimap. Minimap is last because it's the highest-value CV signal. During the draft and post-game, drop nearly everything.

---

## 6. Feeding the agent without drowning it

The core discipline: **the LLM's context is a *view* of the world model, not a log of it.** Three tiers.

### 6.1 Tier 1 — session preamble (cached, written once)

Set at match start, then immutable for the match, so it sits in the prompt cache prefix and costs almost nothing per turn:

- Player: hero, role, lane, rank bracket, hero comfort/history
- Draft: all ten heroes, with pre-fetched matchup notes
- Patch version and relevant patch notes for the player's hero
- Reference build/timing benchmarks for this hero in this matchup
- Riki's persona and speaking rules

Roughly 800–1500 tokens, paid once.

### 6.2 Tier 2 — rolling snapshot (~250–400 tokens, refreshed per turn)

Rendered from the world model at the moment a turn begins — compact text, not JSON. Prose-ish key/value lines cost meaningfully fewer tokens than JSON and read better to a model:

```
T 14:32 | day | you: Riki lvl 11, 84% hp, 61% mp, alive, top jungle
gold 1840 (rel 320) | nw 7.2k | 4/1/3 | lh 96/12 | gpm 512
abils: blink_strike UP, tricks_of_trade 4s, smoke_screen UP, invis UP
items: diffusal(1), phase, wraith, tp | stash: -- | slots 3 free
buy: diffusal2 in ~40s at this gpm
enemies: cm lvl10 alive · sf lvl12 alive · tide lvl11 DEAD 22s
         ws lvl10 alive · zeus lvl11 alive
seen: sf bot 4s ago(0.91) · tide died top 22s ago · cm ward-ish mid 31s ago(0.55)
unseen >20s: ws, zeus                      ← treat as unknown, not absent
map: t1 mid(them) t1 top(us) down | rosh window opens ~2:10
     power rune 1:28 | net worth: us +3.1k
recent: [22s] tide died top  [40s] you got 3rd item  [1:10] rosh killed by us
```

Design rules that matter:

- **Include uncertainty explicitly.** `(0.55)` and `unseen >20s` let the model hedge appropriately. Never render a stale CV position as a bare fact.
- **Elide what didn't change** when consecutive turns are close together, but never elide silently — a `(unchanged)` marker is fine, a missing field is not.
- **Pre-compute the arithmetic.** `buy: diffusal2 in ~40s` is far better than making the model do gold math it will sometimes get wrong.
- **Cap it hard.** A token ceiling with priority-ordered truncation; self-state and enemy state never get truncated, history does.

### 6.3 Tier 3 — tools (pull, not push)

Detail the agent fetches only when it actually needs it. This is what keeps Tier 2 small:

| Tool | Returns |
|---|---|
| `get_enemy_detail(hero)` | Items seen, levels, abilities, last-seen position + age |
| `get_minimap_summary()` | Fresh CV pass: all visible units with confidence |
| `get_item_info(name)` | Cost, components, stats, cooldown |
| `get_matchup_advice(hero_a, hero_b)` | Cached external data |
| `get_timings()` | Rune / Roshan / stack / day-night windows |
| `get_recent_events(n, since)` | Deeper slice of the event tape |
| `read_screen(region)` | VLM on a named region — last resort, rate-limited, consent-gated |
| `get_build_benchmark()` | Expected farm/level at this clock vs. actual |

### 6.4 Event engine & the "invisible until needed" policy

The event engine watches world-model deltas and emits typed, natural-language events (`enemy_missing`, `ult_ready`, `can_afford_key_item`, `low_hp_no_escape`, `rune_soon`, `tower_diveable`, `enemy_core_dead_window`, `stack_now`, `buyback_unaffordable`).

Each event gets a **salience score**. Riki speaks unprompted only when salience clears a threshold *and* the interrupt gates pass:

- **Cooldowns:** global (don't speak more than once per N seconds), and per-event-type (don't say "rune in 30s" every rune).
- **Suppression during high-intensity moments** — mid-teamfight advice is noise at best and actively harmful at worst. Detect via HP deltas, nearby enemy count, ability usage rate.
- **Novelty:** don't repeat advice the player already acted on, or that they ignored twice.
- **Player state:** never speak while the player is talking, and back off if they've dismissed similar prompts.

Unprompted speech is the feature most likely to make Riki annoying enough to uninstall. The threshold should start conservative and be user-tunable, with a hard "only when I ask" mode.

### 6.5 Latency budget

| Stage | Target |
|---|---|
| GSI POST → world model updated | <10 ms |
| Frame capture → CV fact in model | <120 ms |
| World model → rendered snapshot | <5 ms (pure formatting) |
| Snapshot + user turn → first audio out | dominated by LLM+TTS |

The point of the whole architecture is that context assembly is *never* on the critical path — by the time the user finishes speaking, the snapshot is already current.

---

## 7. Privacy

Screen capture is the most invasive thing a desktop app can do, and Riki's users will include streamers. The defaults must be defensible.

**Capture scope.** Window-scoped capture only, targeting the Dota 2 window handle. Never full-desktop, never other windows. This structurally excludes Discord, browsers, notification toasts, and second monitors — no filtering heuristic required, which is the right way to solve it.

**Retention.** Raw frames live in a bounded in-memory ring and are **never written to disk by default**. What persists to the world model is extracted facts (numbers, hero IDs, positions), not pixels. Opt-in debug capture writes to a clearly-labelled local directory with automatic expiry and a visible indicator while active.

**Cloud egress.** Enumerate exactly what leaves the machine:

- ✅ Extracted state facts and the rendered snapshot (contains hero names, timers, item names — no personal data)
- ⚠️ Chat text — contains **other people's** messages. Off by default, or scrubbed and summarized locally rather than sent verbatim.
- ⚠️ Screenshots to a VLM — the highest-risk path. Explicit opt-in, cropped to a named region, rate-limited, with an unmistakable indicator while it happens.
- ❌ Voice chat audio — **never captured.** Teammates did not consent to being recorded, and in several jurisdictions this is a legal question, not just an etiquette one. Riki captures the player's mic for its own wake-word/turn handling; it must not capture game voice output.
- ❌ Steam ID, real name, friend list — stripped or hashed before any egress.

**Local-first option.** A fully local mode (local STT/TTS, local model, no external API calls) should be a design target even if it ships later. It's the honest answer for streamers and for privacy-sensitive users, and having it as a target prevents architectural decisions that would foreclose it.

**Consent.** First-run flow explains, per source: what is captured, at what rate, where it goes. Per-source toggles that actually disable the source, not just hide the output. A persistent, always-visible indicator of what's active.

---

## 8. Anti-cheat, ToS, and fairness

### 8.1 Staying on the right side of Valve

Read-only observation of information already presented to the player is well-established territory — GSI is Valve-provided and explicitly intended for third-party tools, and screen capture is what every streaming and recording tool does. The bright lines Riki must not cross:

- **No process memory reads.** Ever.
- **No DLL injection, no hooking, no overlay rendering into the game.** Voice-only output is a genuine architectural advantage here: no injected overlay means no anti-cheat surface *and* no frame cost.
- **No input synthesis or automation.** Riki advises; the player acts. Nothing that could be characterized as scripting.
- **No packet inspection or network interception.**
- **No spectator-GSI feeding a live player.** Spectator mode exposes full ten-player data. Piping that to someone playing the match would be straightforward cheating. If Riki ever supports a spectator/coaching mode, it must be hard-isolated from player mode with no shared path.

Worth confirming against current Valve policy before shipping, and worth reaching out to Valve directly given the product category.

### 8.2 The fairness rule

Stronger than the ToS rule, and it's a product commitment: **Riki may only reason about information the player could have obtained by looking at their own screen.**

Concretely — no inferring warded-off positions from timing patterns, no fog-of-war reconstruction beyond what the minimap actually renders, no using GSI's precise `xpos`/`ypos` to compute things the player couldn't eyeball. The CV layer only reads pixels the player is already being shown.

This constraint is worth taking seriously beyond compliance. A coach that tells you things you couldn't have known teaches you nothing; a coach constrained to your own information teaches you to read your own screen better. The constraint is the product.

---

## 9. Performance

**Budget:** ≤3% of one core average (≤8% peak), ≤200 MB RSS, no measurable FPS delta, ≤50 MB GPU memory.

Where the wins come from:

- **Crop on GPU, read back small.** The dominant cost in naive screen capture is full-frame readback. Cropping to ~6 small regions first cuts it by roughly 50× at 4K.
- **Hash before recognize.** Most regions are static most of the time. A 64-bit hash comparison costs microseconds and skips the entire CV pass.
- **Template match, don't neural-net.** Fixed fonts and fixed sprites don't need a model. NCC on small regions is microseconds; a general OCR pass is milliseconds; a VLM call is hundreds of milliseconds plus network.
- **Separate process, below-normal priority.** The OS scheduler protects the game. Consider CPU affinity away from the game's primary threads on high-core machines.
- **Adaptive shedding** driven by a real signal (see below), not a fixed rate.

**Measure the right thing.** The metric that matters isn't Riki's CPU% — it's Dota's *1% low* frame time with Riki running versus not. Benchmark on a low-end machine (the median Dota box is not a 4090) across 1080p/1440p/4K, and gate releases on it. A tool that costs 5 FPS in a teamfight will be uninstalled no matter how good the advice is.

---

## 10. Failure modes

| Failure | Detection | Response |
|---|---|---|
| GSI not configured | No POST within 30 s of game start | Guided setup: write the cfg, prompt for the launch option, verify |
| GSI stops mid-game | Heartbeat missed (>35 s) | Fall back to CV-only, tell the user, keep retrying |
| Exclusive fullscreen | Capture returns black/fails | Prompt once to switch to borderless |
| Resolution / HUD scale change | Anchor match fails | Auto-recalibrate; suspend CV until anchors pass |
| Minimap on right | Calibration check | Handled by calibration; re-verify periodically |
| Colorblind mode | Palette snapshot mismatch | Re-derive player colors during calibration |
| CV confidence collapse | Rolling match-score average drops | Suppress CV facts entirely; GSI-only; notify |
| CV process crash | Supervisor | Restart with backoff; degrade to GSI-only meanwhile |
| Reconnect / pause | `game_state`, `paused` | Freeze the model, mark everything stale, resync on resume |
| Custom game / Turbo / Ability Draft | `map.customgamename`, mode detection | Disable mode-specific advice rather than giving wrong advice |

Cross-cutting principle: **degrade loudly to the developer, quietly to the user, and never silently into wrongness.** Riki saying "I've lost track of the map" is fine. Riki confidently describing a map state from 40 seconds ago is not.

---

## 11. Open questions

1. **GSI rate in practice** — measure real delivery rates and jitter across a full match on each platform before committing to the 5 Hz minimap budget.
2. **Linux/Proton GSI viability** — known-buggy historically. May force vision-primary on Linux.
3. **Minimap detection accuracy** — what F1 is actually achievable on 12 px icons during a chaotic teamfight? This is the load-bearing assumption of the whole CV layer and should be prototyped *first*, before any of the surrounding architecture.
4. **Ward and creep-wave detection** — probably worth it, but needs a value/accuracy check.
5. **Trigger threshold tuning** — needs real users. Start conservative.
6. **Is a VLM fallback worth having at all**, or does the latency plus privacy cost exceed its value versus just saying "I can't see that"?
7. **Valve's position** on this product category — worth asking directly rather than inferring.

---

## 12. Suggested build order

Each step is independently useful, and the risky assumption gets tested early rather than after the architecture is committed:

1. **GSI server + world model + snapshot renderer.** Self-state only. Already enough for a genuinely useful cooldown/gold/timing coach, and it validates the context format end to end.
2. **Console log tail** for chat and events. Cheap, high value.
3. **Minimap CV spike** — standalone, measured against hand-labelled frames. *This is the go/no-go for the vision layer;* build it before anything that depends on it.
4. **Capture pipeline + calibration**, once the spike says minimap detection works.
5. **Top bar + scoreboard CV.**
6. **Event engine + trigger policy.** Tune on real matches.
7. **External API enrichment** and the cached preamble.
8. **VLM fallback,** if §11.6 resolves in its favour.
