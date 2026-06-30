# Cancer vs. Treatment — a Game-Theory Simulator

A small, self-contained browser game in which **you are the oncologist** and the cancer is
an adapting opponent. It is built on the model baseline in:

> Staňková K, Brown JS, Dalton WS, Gatenby RA.
> **Optimizing Cancer Treatment Using Game Theory: A Review.**
> *JAMA Oncology* 2019;5(1):96–103.

## How to run

Just open **`index.html`** in any modern browser (double-click it, or
`open index.html` on macOS). No build step, no server, no internet — `index.html`
loads `sim.js` from the same folder.

```
multidrug_sim/
├─ index.html   ← the game (UI, tumour view, charts)
├─ sim.js       ← the simulation engine (DOM-free, unit-testable)
└─ README.md    ← this file
```

---

## The game in one paragraph

Each turn you choose how much of **Drug A** and **Drug B** to give, staying under the
**maximum tolerable toxicity** (= the higher of the two base toxicities). Drugs kill cancer
cells; cells that survive can **evolve resistance — but only to a drug you actually
administered**, and that resistance **decays** on turns you withhold the drug. That single
rule is the whole game: hammering one drug forever lets the cancer adapt to it (the paper's
"play scissors forever and the cancer evolves rock"), while **cycling drugs and using
treatment holidays** keeps the cancer off-balance.

### What you'll see

- **The tumour** is drawn as a chunky **16-bit pixel blob**, coloured by composition
  (red stem core → orange niche → green regular bulk). Every turn, cells that **divided**
  sparkle with a glitter and cells that **died** grey-out and fade — so a cytotoxic turn
  visibly dims and reddens the mass, while a growth turn shimmers at the edges.
- **Patient health / quality-of-life** erodes with cumulative toxicity and recovers on
  treatment holidays. Run it to zero and the patient dies — even if the tumour was shrinking.
- **Max turns** is configurable; set it to **0** to play with no turn limit (the game then
  runs until cure or patient death).
- **Suggest** fills the sliders with the planner's recommended move; **Model autoplay** hands
  the game to the planner, which advances **one turn every 2 seconds** so you can watch
  its strategy unfold (press again to stop and take back control).

You are scored against three reference strategies played on the same random seed:

| Strategy | What it does |
|---|---|
| **Typical — Drug A** | Drug A at max tolerable dose **every** turn (constant MTD, never switches) |
| **Typical — Drug B** | Drug B at max tolerable dose **every** turn |
| **Adaptive AI** | A receding-horizon planner that looks a few turns ahead and is penalised for letting the cancer evolve resistance — the paper's **Stackelberg / "evolutionarily enlightened"** play |

Lower score = better (score = mean tumour burden as a % of the starting size, measured
over the full horizon so that killing the patient early counts as a catastrophe, not a
"win").

---

## Mapping to the paper's model

The paper's Figure 1 gives the cancer's fitness-generating function:

```
G(uC, uT, N) = r · ((1 − uC)·K − N)/K  −  uT / (k + b·uC)
```

| Paper term | In this game |
|---|---|
| `uT` — treatment dose | per-drug **dose × effectiveness** (with combo multipliers when both drugs are given) |
| `uC` — resistance strategy | **per-cell-type, per-drug resistance** (`resist[type][drug]`) |
| kill term `uT / (k + b·uC)` | drug kill `eff · dose · (1 − resistance)` — resistance **blunts** the drug |
| cost of resistance `(1 − uC)` | modelled as resistance **decay when a drug is withheld**: sensitive cells regain ground, so population-average resistance falls (rewarding holidays/switching) |
| `K` — carrying capacity | logistic brake on all proliferation (`K = 3 × tumour size`) |
| leader–follower (Stackelberg) | the cancer adapts **only to drugs already played** — it is always the follower |
| oncologist objective `Jₜ` (balance dose toxicity vs. tumour burden) | the scoreboard metric + the patient **health/quality-of-life** meter |

**The key lesson the model reproduces** (paper, p. 3): *"maximum cell killing is an optimal
strategy only if no cancer cells are capable of evolving a successful resistance."* So:

- Against a **tough, resistant tumour**, constant MTD fails (resistance escapes and/or
  toxicity kills the patient) while adaptive play controls it.
- Give yourself a **silver-bullet drug** (very high effectiveness, near-zero toxicity) against
  an **easy, low-resistance tumour**, and constant MTD **cures outright** — and the adaptive
  AI can do no better. Maximum cell-killing *is* optimal when resistance can't evolve.

---

## The three cancer cell types

Per-type initial counts, proliferation and resistance are **derived** from the global
*tumour size / growth / resistance* dials you set on the start screen (shown live in the
"Derived cancer profile" table).

1. **Regular** — the bulk of the tumour. Highly proliferative, very sensitive, evolves
   resistance slowly. Easy to kill, but constantly **re-seeded by the stem core**.
2. **Niche** — surrounds the stem core. Crawls along very slowly and **only regenerates
   while the core lives**; somewhat sensitive; has a **high, almost-fixed baseline
   resistance**; and **shields** the stem core (the more niche, the less your drugs reach
   the core). Crucially, once the niche is **stripped away the exposed core is *sensitised*** —
   the same drug that barely scratched a shielded core (~1% kill/turn) bites far harder once
   the niche is gone (~36% kill/turn at the default settings). Stripping the niche is therefore
   the key that unlocks killing the core — and since the niche keeps regenerating from the
   core, you must suppress it continuously (another reason combination therapy pays off).
3. **Stem core** — central, slow-dividing, the **most resistant** and the **fastest to
   evolve** new resistance, and it **spawns regular cells** every turn. Clearing it is the
   only path to a true cure — and you usually have to strip the niche first.

This creates the central dilemma: the easy regular cells keep coming back because they are
reseeded by a protected, resistance-prone core. Constant single-drug MTD never resolves it.

---

## Your two drugs

For each drug you set: effectiveness vs **each** cell type, a **base toxicity**, and the
**combo multipliers** applied to *that drug's* effectiveness and toxicity when **both** drugs
are given in the same turn (each multiplier independent). Combining drugs can hit harder but
the combo toxicity multipliers eat into your per-turn toxicity budget — a real trade-off.

The defaults give an asymmetric pair: **Drug A** is a high-toxicity cytotoxic that crushes the
regular bulk but barely touches the core; **Drug B** is a **low-toxicity** core-/niche-targeted
agent. Because B is cheap on the toxicity budget, giving B *alone* leaves budget unspent — so
the rational move is to **top it up with Drug A**, i.e. a **combination**. With strong combo
effectiveness synergy (×1.35 / ×1.45) and only mild combo toxicity (×1.10 / ×1.15), mixing is
genuinely worth it, and the **best A : B ratio shifts as the cancer evolves** — lean on B to
strip the niche early, then rebalance toward A as the cancer's resistance to B climbs. Naive
single-agent MTD still fails; sustained max-combo still poisons the patient; only *adaptive*
combination wins.

---

## Please don't click here, just read ahead

<details>
<summary>(spoiler)</summary>

Before your first turn, click on the **Quality of Life** label, if you answer correctly, you might be ethically surprised.

</details>

## Notes / caveats

- This is an **educational toy**, not a clinically accurate model. Populations are continuous
  ("number of cells") with reproducible per-turn noise; a seeded PRNG makes every run — and
  the three reference strategies — share the same random draws for a fair comparison.
- `sim.js` is deliberately DOM-free so its dynamics can be tested headlessly (e.g. under
  Node or JavaScriptCore).
