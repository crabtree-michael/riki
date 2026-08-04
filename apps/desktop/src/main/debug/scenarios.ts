/**
 * The scripted GSI sequence behind `scenario.match` (ADR-0039).
 *
 * ## Why it posts rather than injects
 *
 * The frames go to the running GSI server over loopback, exactly as Dota 2's own POSTs do. The
 * shorter route — build `Observation`s and hand them to the bus — would skip the token check, the
 * payload parser, the session tracker and every lifecycle edge, which is most of the machinery a
 * scenario is worth running against. What is proved by "the button made Riki speak" depends entirely
 * on how much of the real path the button used.
 *
 * ## Why the clock advances at 4×, and not faster
 *
 * `packages/gsi`'s session tracker raises `clock_discontinuity` when a frame's clock differs from
 * the extrapolated one by more than `DISCONTINUITY_THRESHOLD_SECONDS` (5), and a discontinuity
 * resyncs the world model — which resets the latch set and the cooldown clocks the scenario is
 * trying to exercise. The comparison is per frame against the *previous* frame, so what matters is
 * the drift each step introduces: 2 game seconds per 500 ms of wall clock is 1.5 s of drift a frame,
 * comfortably inside the threshold, and a run takes about eleven seconds.
 *
 * Measured, not reasoned: driving the same fixture at 8× on 2026-08-03 produced three
 * `world model reset: clock_discontinuity` rows in the Problems panel.
 *
 * ## What it aims at
 *
 * The first stack window, at 0:53. Only two detectors are reachable from GSI alone — `stack_now`
 * and `rune_soon` — because both are derived from the match clock. Every combat detector
 * (`low_hp_no_escape`, `enemy_missing`, `ult_ready`, `enemy_core_dead_window`) needs enemy positions
 * from the vision sidecar and returns nothing without them, so a GSI-only scenario aimed at one
 * would prove only that it is silent.
 *
 * Between the two, the stack is the one that fits in a button: the first detectable bounty is at
 * 3:00 and the drift rule above forbids skipping ahead to meet it, so a bounty run is three quarters
 * of a minute long. `stack_now` fires within `stackLeadSeconds` (12) and clears `speakThreshold`
 * (0.3) at about 4 s out, since `salience = kindWeight(0.42) × urgency` and
 * `urgency = 15 / (15 + (secondsUntil − 1.5))`.
 */

/** One frame of the script. `atMs` is milliseconds from the run's start. */
export interface ScenarioFrame {
  readonly atMs: number;
  readonly body: Record<string, unknown>;
  /** What this frame is for, as a trace line. Null on the frames that are just the clock moving. */
  readonly note: string | null;
}

const MATCH_ID = '9000000001';

/** 2 game seconds per frame, one frame per 500 ms. See the header. */
const FRAME_INTERVAL_MS = 500;
const CLOCK_STEP_SECONDS = 2;

/**
 * The first stack window, at 0:53, and the pre-horn clock the walk starts from.
 *
 * A bounty would do as well on the arithmetic and not on the wall clock: the first one Riki can
 * detect is at 3:00, the walk cannot skip ahead to meet it without tripping the discontinuity rule
 * below, and walking there continuously is three quarters of a minute of button. The first stack is
 * fifteen seconds away and reachable from the clock alone, which is the property that matters.
 */
const TARGET_STACK_SECONDS = 53;
const WALK_FROM_SECONDS = -4;
/** Two frames past the target, so the run shows the detection lapsing rather than just stopping. */
const WALK_TO_SECONDS = TARGET_STACK_SECONDS + 4;

/**
 * Where the two interesting notes land, mirrored from `@riki/events` rather than imported.
 *
 * Copied on purpose: these decide when a *comment* is printed, and importing `DEFAULT_TRIGGER_CONFIG`
 * to caption a log line would make the script's text change when somebody tunes a threshold — while
 * the frames, which are the thing that matters, stayed identical. `scenarios.test.ts` asserts both
 * notes actually fire, which is the failure mode a hand-copied number has here.
 */
const DETECT_LEAD_SECONDS = 12;
const THRESHOLD_LEAD_SECONDS = 5;

function body(clock: number, state: string): Record<string, unknown> {
  return {
    provider: { name: 'Dota 2', appid: 570, version: 47, timestamp: 1_754_000_000 },
    map: {
      name: 'start',
      matchid: MATCH_ID,
      // `game_time` includes the pre-horn minute; `clock_time` is the match clock the runes are on.
      game_time: clock + 90,
      clock_time: clock,
      daytime: true,
      nightstalker_night: false,
      game_state: state,
      paused: false,
      win_team: 'none',
      customgamename: '',
      radiant_score: 0,
      dire_score: 0,
      ward_purchase_cooldown: 0,
    },
    player: {
      steamid: '76561190000000000',
      name: 'scenario',
      activity: 'playing',
      kills: 0,
      deaths: 0,
      assists: 0,
      last_hits: 20,
      denies: 3,
      kill_streak: 0,
      commands_issued: 800,
      team_name: 'radiant',
      gold: 1200,
      gold_reliable: 0,
      gold_unreliable: 1200,
      gold_from_hero_kills: 0,
      gold_from_creep_kills: 800,
      gpm: 0,
      xpm: 0,
      net_worth: 1300,
      hero_damage: 500,
      wards_purchased: 0,
      wards_placed: 0,
      wards_destroyed: 0,
      runes_activated: 0,
      camps_stacked: 0,
    },
    hero: {
      xpos: -1200,
      ypos: -1000,
      id: 71,
      name: 'npc_dota_hero_riki',
      level: 6,
      xp: 2200,
      alive: true,
      respawn_seconds: 0,
      buyback_cost: 380,
      buyback_cooldown: 0,
      health: 900,
      max_health: 1000,
      health_percent: 90,
      mana: 300,
      max_mana: 400,
      mana_percent: 75,
      silenced: false,
      stunned: false,
      disarmed: false,
      magicimmune: false,
      hexed: false,
      muted: false,
      break: false,
      aghanims_scepter: false,
      aghanims_shard: false,
      smoked: false,
      has_debuff: false,
    },
    abilities: {
      ability0: {
        name: 'riki_smoke_screen',
        level: 1,
        can_cast: true,
        passive: false,
        ability_active: true,
        cooldown: 0,
        ultimate: false,
      },
    },
    items: {
      slot0: { name: 'item_tango', purchaser: 0, can_cast: true, cooldown: 0, passive: false },
    },
    buildings: {},
  };
}

/**
 * The script: a continuous walk from just before the horn to just past the first stack window.
 *
 * Continuous, with no jump anywhere in it, because a jump is a `clock_discontinuity` — which is what
 * `scenarios.test.ts` asserts and what an earlier draft of this file got wrong.
 *
 * Pure, so `scenarios.test.ts` can assert the shape of the run — the salience arithmetic above is
 * checkable against the frame list without a socket, a clock or an app.
 */
export function stackWindowScript(): readonly ScenarioFrame[] {
  const frames: ScenarioFrame[] = [];
  let atMs = 0;
  // Crossings, not equalities. The walk steps by 2 from an even clock and the stack is at an odd
  // one, so `until` is always odd and `until === 12` is a note that can never fire — which is
  // exactly what the first draft of this function did, silently.
  let notedLead = false;
  let notedThreshold = false;

  for (let clock = WALK_FROM_SECONDS; clock <= WALK_TO_SECONDS; clock += CLOCK_STEP_SECONDS) {
    const preGame = clock < 0;
    const until = TARGET_STACK_SECONDS - clock;

    let note: string | null = null;
    if (clock === WALK_FROM_SECONDS) {
      note = 'pre-game — opens the match, which builds the coaching root and the session';
    } else if (clock === 0) {
      note = 'horn — the match is in progress and the ladder starts running';
    } else if (!notedLead && until > 0 && until <= DETECT_LEAD_SECONDS) {
      notedLead = true;
      note = `clock ${String(clock)} — stack in ${String(until)}s, stack_now starts detecting`;
    } else if (!notedThreshold && until > 0 && until <= THRESHOLD_LEAD_SECONDS) {
      notedThreshold = true;
      note = `clock ${String(clock)} — stack in ${String(until)}s, salience crosses speakThreshold`;
    }

    frames.push({
      atMs,
      body: body(
        clock,
        preGame ? 'DOTA_GAMERULES_STATE_PRE_GAME' : 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
      ),
      note,
    });
    atMs += FRAME_INTERVAL_MS;
  }
  return frames;
}

export interface MatchScenarioDeps {
  /** Posts one frame the way Dota does, answering the HTTP status. */
  readonly post: (body: Record<string, unknown>) => Promise<number>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly trace: (stage: string, message: string) => void;
}

/**
 * Run the script, tracing each frame that carries a note and every non-200.
 *
 * Every frame is traced when it fails and only the interesting ones when it succeeds: a run is
 * thirty POSTs, and thirty `-> 200` lines would bury the six that say what the run was for.
 */
export async function runMatchScenario(deps: MatchScenarioDeps): Promise<void> {
  const frames = stackWindowScript();
  let previousAtMs = 0;

  for (const frame of frames) {
    await deps.sleep(Math.max(0, frame.atMs - previousAtMs));
    previousAtMs = frame.atMs;

    const status = await deps.post(frame.body);
    if (status !== 200) {
      deps.trace(
        'fault',
        `GSI POST answered ${String(status)} — the scenario cannot drive the app`,
      );
      return;
    }
    if (frame.note !== null) deps.trace('scenario', frame.note);
  }

  deps.trace('scenario', `${String(frames.length)} frames posted, through the 0:53 stack`);
}
