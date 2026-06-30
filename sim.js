/* ===================================================================
 * sim.js  —  Cancer vs. Treatment turn-based simulation engine
 * -------------------------------------------------------------------
 * Model baseline: Staňková, Brown, Dalton & Gatenby,
 *   "Optimizing Cancer Treatment Using Game Theory", JAMA Oncol 2019.
 *
 *   Fitness-generating function (their Fig. 1):
 *       G(uC,uT,N) = r * ((1-uC)K - N)/K  -  uT / (k + b*uC)
 *
 *   - uT  : treatment dose            -> here: per-drug dose * effectiveness
 *   - uC  : cancer resistance strategy-> here: per-type, per-drug resistance
 *   - the kill term  uT/(k+b*uC)      -> resistance blunts the drug
 *   - the (1-uC) term                 -> resistance costs proliferation
 *   - cancer is a FOLLOWER: resistance only rises against a drug that was
 *     actually applied, and decays when a drug is withheld (Stackelberg).
 *
 * This file is DOM-free so it can be unit-tested under Node.
 * =================================================================== */
(function (root) {
  "use strict";

  /* ---------- seeded PRNG (mulberry32) ---------- */
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  const TYPES = ["regular", "niche", "stem"];
  const DRUGS = ["A", "B"];
  const QOL_FLOOR = 33;   // palliative AI tries to keep quality-of-life above this

  /* ===================================================================
   * DEFAULT player-facing inputs
   * =================================================================== */
  const DEFAULT_INPUT = {
    // --- Drug A: cytotoxic, hammers fast-dividing bulk, weak on the core.
    //     Higher base toxicity, so single-agent A is the "expensive" option.
    drugA: { name: "Drug A (cytotoxic)",
             effRegular: 0.90, effNiche: 0.45, effStem: 0.18,
             tox: 4.0, comboEff: 1.35, comboTox: 1.10 },
    // --- Drug B: targeted, reaches niche/core, gentle on bulk. LOW toxicity,
    //     so giving B alone wastes the toxicity budget -> topping up with A
    //     (i.e. a combination) is the rational move. Strong combo synergy and
    //     only mild combo toxicity make mixing genuinely worth it.
    drugB: { name: "Drug B (core-targeted)",
             effRegular: 0.42, effNiche: 0.70, effStem: 0.60,
             tox: 2.5, comboEff: 1.45, comboTox: 1.15 },

    // --- Global cancer dials (per-type stats are DERIVED from these) ---
    tumorSize: 1000,    // total starting cells
    growth: 0.35,       // 0..1 global proliferativeness
    resistance: 0.30,   // 0..1 global baseline resistance

    // --- Advanced (sensible defaults) ---
    nicheShield: 2.0,   // how strongly the niche shields the stem core
    stemExposeBonus: 1.0, // extra kill on the core once the niche is stripped away
    stemSpawn: 0.12,    // regular cells spawned per stem cell per turn
    resDecay: 0.08,     // resistance decay/turn for a withheld drug
    toxHealthCost: 1.0, // patient health lost per toxicity unit
    healthRecovery: 5.0,// health regained on a full treatment holiday
    maxTurns: 60,       // 0 = unlimited (play until cure / patient death)
    progressionMult: 2.5 // lose if total burden >= this * tumorSize
  };

  /* ===================================================================
   * deriveParams: turn the player's global dials into a full param set
   * (per-type initial counts, proliferation rates, resistances...)
   * =================================================================== */
  function deriveParams(input) {
    const inp = input || DEFAULT_INPUT;
    const S = inp.tumorSize, g = inp.growth, R = inp.resistance;
    // The global resistance dial controls BOTH the baseline resistance AND
    // how readily the cancer evolves *new* resistance. Low R => an "easy",
    // silver-bullet-friendly tumour where constant MTD can win outright.
    const evoFactor = 0.2 + 1.6 * R;

    const drug = (d) => ({
      name: d.name,
      eff: { regular: d.effRegular, niche: d.effNiche, stem: d.effStem },
      tox: d.tox, comboEff: d.comboEff, comboTox: d.comboTox
    });

    const maxTox = Math.max(inp.drugA.tox, inp.drugB.tox);

    return {
      drugs: { A: drug(inp.drugA), B: drug(inp.drugB) },
      maxTox,
      S, K: 3 * S,
      progressionLimit: inp.progressionMult * S,
      nicheShield: inp.nicheShield,
      stemExposeBonus: inp.stemExposeBonus,
      resDecay: inp.resDecay,
      toxHealthCost: inp.toxHealthCost,
      healthRecovery: inp.healthRecovery,
      maxTurns: inp.maxTurns,
      // maxTurns <= 0 means "unlimited": play until cure / death. We still cap
      // the loop & score horizon internally so nothing runs forever.
      unlimited: inp.maxTurns <= 0,
      horizon: inp.maxTurns > 0 ? inp.maxTurns : 400,

      types: {
        // 1. Regular: bulk, highly proliferative, very sensitive, low evolvability
        regular: {
          count0: 0.70 * S,
          prolif: 0.25 + 0.75 * g,
          res0:   clamp(0.05 + 0.15 * R, 0, 1),
          cap:    0.97,
          evolv:  0.03 * evoFactor
        },
        // 2. Niche: surrounds the core, crawls along (+ grows with stem),
        //    somewhat sensitive, high-ish fixed baseline resistance, shields core
        niche: {
          count0: 0.22 * S,
          prolifBase: 0.01 + 0.03 * g,
          prolifFromStem: 0.02,            // niche regenerates while stem lives
          res0:   clamp(0.35 + 0.35 * R, 0, 1),
          cap:    clamp(0.35 + 0.35 * R + 0.08, 0, 1), // barely moves
          evolv:  0.004 * evoFactor
        },
        // 3. Stem core: central, slow-dividing, most resistant, seeds regulars
        stem: {
          count0: 0.08 * S,
          prolif: 0.02 + 0.15 * g,
          res0:   clamp(0.55 + 0.40 * R, 0, 1),
          cap:    0.98,
          evolv:  0.10 * evoFactor,
          spawn:  inp.stemSpawn
        }
      },
      _input: inp
    };
  }

  /* ===================================================================
   * initialState
   * =================================================================== */
  function initialState(params) {
    const t = params.types;
    return {
      turn: 0,
      cells: { regular: t.regular.count0, niche: t.niche.count0, stem: t.stem.count0 },
      resist: {
        regular: { A: t.regular.res0, B: t.regular.res0 },
        niche:   { A: t.niche.res0,   B: t.niche.res0 },
        stem:    { A: t.stem.res0,    B: t.stem.res0 }
      },
      health: 100,
      outcome: null,           // null | 'cure' | 'progression' | 'toxicDeath'
      lastAction: { doseA: 0, doseB: 0 },
      toxThisTurn: 0
    };
  }

  function totalCells(state) {
    return state.cells.regular + state.cells.niche + state.cells.stem;
  }

  /* ---------- toxicity actually spent for an action ---------- */
  function toxicityOf(action, params) {
    const both = action.doseA > 0 && action.doseB > 0;
    const A = params.drugs.A, B = params.drugs.B;
    const tA = action.doseA * A.tox * (both ? A.comboTox : 1);
    const tB = action.doseB * B.tox * (both ? B.comboTox : 1);
    return tA + tB;
  }
  function isActionLegal(action, params) {
    return toxicityOf(action, params) <= params.maxTox + 1e-9 &&
           action.doseA >= -1e-9 && action.doseA <= 1 + 1e-9 &&
           action.doseB >= -1e-9 && action.doseB <= 1 + 1e-9;
  }

  /* ===================================================================
   * simulateTurn — the heart of the game
   *   order:  (1) administer & toxicity   (2) kill   (3) proliferate
   *           (4) cancer adapts (resistance up vs applied drug, decay vs withheld)
   * deterministic=true -> expected values (used by the AI planner)
   * =================================================================== */
  function simulateTurn(state, action, params, rng, deterministic) {
    if (state.outcome) return state;             // game already ended
    const s = cloneState(state);
    const t = params.types;
    const noise = deterministic
      ? () => 1
      : () => 1 + (rng() * 2 - 1) * 0.08;        // ±8% reproducible jitter

    const both = action.doseA > 0 && action.doseB > 0;
    const effMul = { A: both ? params.drugs.A.comboEff : 1,
                     B: both ? params.drugs.B.comboEff : 1 };
    const dose = { A: action.doseA, B: action.doseB };

    /* (1) toxicity -> patient health */
    const tox = toxicityOf(action, params);
    s.toxThisTurn = tox;
    s.health = clamp(
      s.health - tox * params.toxHealthCost +
      (tox <= 1e-9 ? params.healthRecovery : 0), 0, 100);

    /* Niche -> stem-core exposure factor (multiplies the core's drug kill).
     * While the niche is present it SHIELDS the core (factor < 1). Once the
     * niche is stripped away the exposed core is SENSITISED (factor > 1): the
     * stroma that protected it is gone, so the same drugs bite much harder. */
    const nicheFrac = t.niche.count0 > 0
      ? clamp(s.cells.niche / t.niche.count0, 0, 1) : 0;
    const stemExposure = (1 / (1 + params.nicheShield * nicheFrac))
                       * (1 + params.stemExposeBonus * (1 - nicheFrac));

    /* (2) kill phase — uses CURRENT resistance (set by past exposure) */
    for (const type of TYPES) {
      let kill = 0;
      for (const d of DRUGS) {
        if (dose[d] <= 0) continue;
        const eff = params.drugs[d].eff[type] * effMul[d];
        let k = eff * dose[d] * (1 - s.resist[type][d]);  // uT/(k+b uC) analogue
        if (type === "stem") k *= stemExposure;           // niche shields / exposes core
        kill += k;
      }
      kill = clamp(kill * noise(), 0, 0.95);
      s.cells[type] *= (1 - kill);
    }

    /* (3) proliferation phase (logistic brake via carrying capacity K) */
    const tot = totalCells(s);
    const room = clamp(1 - tot / params.K, 0, 1);

    const reg0 = s.cells.regular, nic0 = s.cells.niche, stm0 = s.cells.stem;
    // regular: fast growth, plus fresh regulars seeded by the stem core
    s.cells.regular = reg0 + reg0 * t.regular.prolif * room * noise()
                           + stm0 * t.stem.spawn * room * noise();
    // niche: very slow, plus regeneration tied to the stem core
    s.cells.niche = nic0 + (nic0 * t.niche.prolifBase
                           + stm0 * t.niche.prolifFromStem) * room * noise();
    // stem: slow self-renewal
    s.cells.stem = stm0 + stm0 * t.stem.prolif * room * noise();

    /* (4) cancer adapts — FOLLOWER move (Stackelberg) */
    for (const type of TYPES) {
      const cfg = t[type];
      for (const d of DRUGS) {
        if (dose[d] > 0) {
          // resistance climbs toward the type's cap, faster at higher dose
          const gain = cfg.evolv * dose[d] * (cfg.cap - s.resist[type][d])
                       * (deterministic ? 1 : (0.5 + rng()));
          s.resist[type][d] = clamp(s.resist[type][d] + gain, 0, cfg.cap);
        } else {
          // drug withheld -> resistance decays toward this type's baseline
          const floor = cfg.res0;
          if (s.resist[type][d] > floor) {
            s.resist[type][d] = Math.max(
              floor, s.resist[type][d] - params.resDecay *
                     (s.resist[type][d] - floor) *
                     (deterministic ? 1 : (0.5 + rng())));
          }
        }
      }
    }

    s.turn += 1;
    s.lastAction = { doseA: dose.A, doseB: dose.B };

    /* ---- terminal checks ---- */
    const total = totalCells(s);
    if (total < 1) s.outcome = "cure";
    else if (s.health <= 0) s.outcome = "toxicDeath";
    else if (total >= params.progressionLimit) s.outcome = "progression";
    return s;
  }

  function cloneState(s) {
    return {
      turn: s.turn,
      cells: { regular: s.cells.regular, niche: s.cells.niche, stem: s.cells.stem },
      resist: {
        regular: { A: s.resist.regular.A, B: s.resist.regular.B },
        niche:   { A: s.resist.niche.A,   B: s.resist.niche.B },
        stem:    { A: s.resist.stem.A,    B: s.resist.stem.B }
      },
      health: s.health, outcome: s.outcome,
      lastAction: { doseA: s.lastAction.doseA, doseB: s.lastAction.doseB },
      toxThisTurn: s.toxThisTurn
    };
  }

  /* ===================================================================
   * Action helpers / candidate generation
   * =================================================================== */
  // single-drug maximum dose within the toxicity budget
  function maxSingleDose(drugKey, params) {
    return clamp(params.maxTox / params.drugs[drugKey].tox, 0, 1);
  }
  const ACTION_A_MAX = (p) => ({ doseA: maxSingleDose("A", p), doseB: 0 });
  const ACTION_B_MAX = (p) => ({ doseA: 0, doseB: maxSingleDose("B", p) });
  const ACTION_HOLIDAY = () => ({ doseA: 0, doseB: 0 });

  // grid of legal (doseA,doseB) candidates for the planner
  function candidateActions(params) {
    const grid = [0, 0.25, 0.5, 0.75, 1.0];
    const out = [];
    for (const a of grid) for (const b of grid) {
      const act = { doseA: a, doseB: b };
      if (isActionLegal(act, params)) out.push(act);
    }
    return out;
  }

  /* ===================================================================
   * Scoring (lower = better) — mirrors the oncologist objective JT:
   *   balance toxicity against tumour burden, integrated over time.
   * =================================================================== */
  function turnCost(state, params) {
    const burden = totalCells(state) / params.S;
    const tox = state.toxThisTurn / params.maxTox;
    return 0.6 * burden + 0.4 * tox * tox;
  }

  /* ===================================================================
   * AI planner (auto-play) — receding-horizon greedy rollout.
   * Plans on EXPECTED dynamics (deterministic), penalising tumour burden,
   * toxicity AND resistance build-up -> naturally discovers the
   * Stackelberg lesson: switch drugs / use holidays, don't hammer one drug.
   * =================================================================== */
  function planAction(state, params, horizon, mode) {
    horizon = horizon || 6;
    mode = mode || "cure";
    const cands = candidateActions(params);

    function resistTotal(st) {
      let r = 0;
      for (const ty of TYPES) for (const d of DRUGS) r += st.resist[ty][d];
      return r;
    }
    // Default "cure" objective: drive the tumour down, hate resistance build-up.
    function cureCost(prev, next) {
      let c = turnCost(next, params);
      c += 0.7 * Math.max(0, resistTotal(next) - resistTotal(prev)); // hate new resistance
      c += 0.5 * (next.cells.stem / params.types.stem.count0);       // value killing core
      if (next.outcome === "cure") c -= 50;
      if (next.outcome === "progression" || next.outcome === "toxicDeath") c += 50;
      return c;
    }
    // Palliative "comfort first" objective: prolong life while holding quality
    // of life above QOL_FLOOR. It shuns toxicity that would crash QoL, but still
    // doses just enough to keep the tumour from progressing (also lethal).
    function palliativeCost(prev, next) {
      let c = 0;
      c += 0.35 * (next.toxThisTurn / params.maxTox);                // mild comfort pref (still willing to dose)
      // QoL is a CONSTRAINT, not a target: a cliff at the floor and a steep ramp
      // just above it, but no reward for sitting far above — so it spends QoL
      // down toward the floor to fight the tumour and survive longer.
      if (next.health <= QOL_FLOOR) c += 90;
      else if (next.health < QOL_FLOOR + 8) c += 4 * ((QOL_FLOOR + 8) - next.health);
      c += 0.7 * (totalCells(next) / params.S);                      // fight the tumour to avoid progression death
      if (next.outcome === "toxicDeath") c += 150;                   // treatment killing patient = worst
      if (next.outcome === "progression") c += 120;                  // tumour killing patient = nearly as bad
      if (next.outcome === "cure") c -= 30;                          // a reachable cure is still welcome
      if (!next.outcome) c -= 1.0;                                   // reward each turn the patient stays alive
      return c;
    }
    const stepCost = mode === "palliative" ? palliativeCost : cureCost;
    // greedy rollout from a state, returns discounted cumulative cost
    function rollout(start, depth) {
      let st = start, total = 0, discount = 1;
      for (let i = 0; i < depth && !st.outcome; i++) {
        let best = null, bestC = Infinity, bestNext = null;
        for (const a of cands) {
          const nx = simulateTurn(st, a, params, null, true);
          const c = stepCost(st, nx);
          if (c < bestC) { bestC = c; best = a; bestNext = nx; }
        }
        total += discount * bestC; discount *= 0.9; st = bestNext; void best;
      }
      return total;
    }

    let bestAction = ACTION_HOLIDAY(), bestScore = Infinity;
    for (const a of cands) {
      const nx = simulateTurn(state, a, params, null, true);
      const score = stepCost(state, nx) + rollout(nx, horizon - 1);
      if (score < bestScore) { bestScore = score; bestAction = a; }
    }
    return bestAction;
  }

  /* ===================================================================
   * Policies & a full strategy runner (for the comparison chart)
   * =================================================================== */
  const POLICIES = {
    typicalA:   (state, params) => ACTION_A_MAX(params),
    typicalB:   (state, params) => ACTION_B_MAX(params),
    auto:       (state, params) => planAction(state, params, 6),
    palliative: (state, params) => planAction(state, params, 6, "palliative")
  };

  // Horizon-normalised score for a burden trajectory (lower = better).
  // After the run ends we fill remaining turns up to params.horizon with 0
  // (cure) or the progression cap (patient death / tumour escape), so a run
  // that ends early is judged on what it left behind, not rewarded for length.
  function scoreSeries(burden, outcome, params) {
    let fill;
    if (outcome === "cure") fill = 0;
    else if (outcome === "toxicDeath" || outcome === "progression")
      fill = params.progressionLimit;
    else fill = null; // survived to horizon: average what actually happened
    let sum = 0;
    for (let i = 1; i <= params.horizon; i++) {
      const b = i < burden.length ? burden[i]
              : (fill == null ? burden[burden.length - 1] : fill);
      sum += b / params.S;
    }
    return (sum / params.horizon) * 100; // mean burden as % of initial size
  }

  // Run a non-interactive policy to termination on a fixed seed.
  // Score is horizon-NORMALISED so strategies of different lengths compare
  // fairly: after the run ends we fill the remaining turns with 0 (if cured)
  // or the progression cap (if the patient died / the tumour escaped). Thus a
  // strategy that kills the patient at turn 12 is correctly scored as a
  // catastrophe, not rewarded for "stopping early". Lower score = better.
  function runStrategy(policy, params, seed) {
    const rng = makeRng(seed);
    let st = initialState(params);
    const burden = [totalCells(st)];
    const health = [st.health];
    const doses = [];
    while (!st.outcome && st.turn < params.horizon) {
      const action = policy(st, params);
      doses.push(action);
      st = simulateTurn(st, action, params, rng, false);
      burden.push(totalCells(st));
      health.push(st.health);
    }
    const outcome = st.outcome || "survived";
    const score = scoreSeries(burden, outcome, params);

    return {
      burden, health, doses, score,
      outcome,
      turns: st.turn,
      finalBurden: totalCells(st),
      finalHealth: st.health,
      minBurden: Math.min.apply(null, burden)
    };
  }

  /* ---------- exports ---------- */
  const API = {
    DEFAULT_INPUT, TYPES, DRUGS,
    makeRng, deriveParams, initialState, simulateTurn,
    totalCells, toxicityOf, isActionLegal, maxSingleDose,
    candidateActions, planAction, runStrategy, scoreSeries, POLICIES, turnCost,
    ACTION_A_MAX, ACTION_B_MAX, ACTION_HOLIDAY
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.CancerSim = API;
})(typeof window !== "undefined" ? window : globalThis);
