# GPU process memory — what it is, and what it is not

Measured 2026-08-25 against `/Applications/Kakapo.app` built from `0507cfc`, with `scripts/gpu-probe.mjs`.
Every figure below came out of that tool, whose own `selftest` guards the three misreadings that produced
wrong answers earlier in the session (units, wrong process, vmmap summary-vs-detail).

## What the 1 GB is

The process is the **GPU helper**, and the number is `phys_footprint`, which is what Activity Monitor shows.
Its RSS is ~150 MB, so `ps` does not see it at all — that mismatch is why it looked mysterious.

At 297 MB with three renderers:

| | |
|---|---|
| IOSurface | 148 MB / 40 regions (50%) |
| Owned physical footprint (unmapped) (graphics) | 104 MB / 67 regions (35%) |
| IOAccelerator (graphics) | 12 MB |

The IOSurfaces are per-view compositing buffers, not one runaway allocation: `3 × 2880×1920`, `4 × 1350×1806`,
`4 × 2880×512`, `4 × 2816×480`. Full window width at 2× retina, plus tile strips. The category total and the
sum of the individually mapped surfaces reconcile at **ratio 1.00**, which is the check that would have caught
the earlier "single 606 MB surface" claim.

## What it is not

**Not a leak.** Renderer count fixed, app idle, 99 samples over 299 s: 319.5 MB → 315.7 MB, −0.8 MB/min.
Verdict STEADY.

**Not retained by use.** Against a settled 408 MB baseline: opening the terminal panel +99 MB, fifteen
workspace switches −66 MB. After 150 s idle it returned to **408 MB exactly** — every megabyte released.

**Not caused by scrolling a big diff.** Scrolling the tallest review end-to-end twice took it 408 → 297 MB and
76 → 41 surfaces. Chromium released stale tiles; it did not accumulate.

**Not the terminal's WebGL canvases.** Released them for hidden workspaces (verified down to zero canvases per
hidden window) and the GPU process still sat at 941 MB and 1062 MB. That change was reverted — it blanked the
panes and bought nothing.

**Not JavaScript.** Renderer heaps ~12 MB each, main 22 MB, largest DOM element equivalent to 133 MB of
backing store. None of it is the same order as the footprint.

## What it is

Live compositor surface memory, proportional to how many full-window views are composited at once, and fully
reclaimable. Four workspaces plus the hub plus the modal overlay is six webContents, each owning a full-window
surface at 2× retina (~28 MB) plus tiles and double buffering — which is the right order of magnitude for the
941–1187 MB that was observed, and it is memory the system takes back.

## Limits of this result — read before acting on it

**The 1 GB state was not reproduced on demand.** Today's controlled runs peaked at 522 MB transient and
settled at 297–408 MB with three workspaces. The 941–1187 MB readings were real, but taken with four
workspaces after hours of use. The mechanism above is consistent with them and nothing else survived
measurement, but "consistent with" is weaker than "demonstrated", and this document should not be read as the
stronger claim.

**Renderer count could not be varied.** A cold boot goes 0 → 3 renderer processes between two samples 1.5 s
apart; Electron spawns them together, and the only other way to move the count is opening or closing the
user's own workspaces. So the per-workspace marginal cost is inferred from surface sizes, not measured.

## What to do

Nothing, on this evidence. There is no retention to fix and no leak to plug, and the one change made on the
assumption that there was made the app worse. The remaining lever is the number of simultaneously composited
full-window views, and shrinking hidden views was already measured at −60 MB sustained — Chromium is already
dropping most of a hidden view's tiles by itself.

If a hard ceiling is wanted rather than an explanation, the untested candidate is Chromium's
`--force-gpu-mem-available-mb`, which caps the budget and makes eviction more aggressive. It has not been
tried here and should not be shipped without the same measurement discipline.
