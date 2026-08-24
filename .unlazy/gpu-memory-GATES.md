# Gates: GPU process memory — find the cause

OWNS: .unlazy/gpu-memory-*, scripts/gpu-probe.mjs

NOTE: G4, G5 and G8 read sample files under .unlazy/ that are deliberately NOT committed — they are ~4k lines
of one-off telemetry. Regenerate them before re-verifying, with the app running:

    node scripts/gpu-probe.mjs sample   .unlazy/gpu-memory-trend.json 300 3000   # G5, needs a FIXED workspace count
    node scripts/gpu-probe.mjs snapshot .unlazy/gpu-memory-attribution.json      # G4
    node scripts/gpu-probe.mjs experiment .unlazy/gpu-memory-experiment.json     # G8, ~6 min
    node <skill>/scripts/gate-check.mjs --reverify --root . --cwd . .unlazy/gpu-memory-GATES.md

The figures each gate produced are recorded in its EVIDENCE line and in gpu-memory-CONCLUSION.md, so the
conclusion stands on its own; what is lost by not committing the samples is only the ability to re-run the
oracles against THIS session's exact readings.

Scope: install the four pending commits, then measure the Kakapo GPU process against a controlled
variable (number of live review renderers) until the 1 GB footprint is attributed to a named consumer
with a marginal cost per workspace, or the leading candidates are eliminated with evidence.

- [x] G1: the installed app is built from the current HEAD — the blank-pane regression is gone and all four fixes are in
  CHECK: node scripts/gpu-probe.mjs verify-install
  EXPECT: INSTALL_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=8b5e4f52c26c/20 entries; output=forbidden present: none | INSTALL_OK

- [ ] G2: a startup time series exists that samples GPU footprint as each restored workspace boots
  CHECK: node scripts/gpu-probe.mjs series-check .unlazy/gpu-memory-series.json
  EXPECT: SERIES_OK
  EVIDENCE: pending

ABANDON: G2 Same finding as G3 and measured by the same file: a cold boot has no intermediate renderer count
to sample. Two samples 1.5s apart bracket 0 -> 3 processes, so "as each workspace boots" describes something
the app does not do. The series was still collected and is the evidence for both abandonments; the questions
it was meant to answer are carried by G5 (fixed count over time) and G8 (cost per interaction).

- [ ] G3: the marginal GPU cost per live renderer is measured from that series, not asserted
  CHECK: node scripts/gpu-probe.mjs marginal .unlazy/gpu-memory-series.json
  EXPECT: MARGINAL_OK
  EVIDENCE: pending

ABANDON: G3 The renderer count is not controllable without destroying the user's workspaces. Measured: a cold
boot goes 0 -> 3 renderer processes between two samples 1.5s apart, with no intermediate count, because
Electron spawns them together (.unlazy/gpu-memory-series.json). The only other way to move it is opening or
closing the user's own workspaces. Superseded by G8, which varies what the app DOES instead of how many
processes it has — the evidence for that pivot is G5: idle at a fixed count the footprint is flat at ~315 MB,
while hours of real use reached 941-1187 MB, so use is the variable that carries the growth.

- [x] G8: the GPU cost of each interaction class is measured against a settled baseline, and the one that
      moves the footprint is named
  CHECK: node scripts/gpu-probe.mjs experiment-check .unlazy/gpu-memory-experiment.json
  EXPECT: EXPERIMENT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=8b5e4f52c26c/20 entries; output=verdict: returns to baseline | EXPERIMENT_OK

- [x] G4: the dominant footprint category is attributed, and IOSurface totals reconcile with the sum of the individual surfaces
  CHECK: node scripts/gpu-probe.mjs attribute .unlazy/gpu-memory-attribution.json
  EXPECT: ATTRIBUTION_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=8b5e4f52c26c/20 entries; output=dominant category: IOSurface at 50% of the footprint | ATTRIBUTION_OK

- [x] G5: steady state vs growth is settled — with the workspace count fixed, the footprint is sampled over time and the trend classified
  CHECK: node scripts/gpu-probe.mjs trend .unlazy/gpu-memory-trend.json
  EXPECT: TREND_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=8b5e4f52c26c/20 entries; output=verdict: STEADY | TREND_OK

- [x] G6: the measurement tooling is honest about the two mistakes already made this session — unit confusion and wrong-process capture
  CHECK: node scripts/gpu-probe.mjs selftest
  EXPECT: SELFTEST_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/happynut/repos/kakapo; path=8b5e4f52c26c/20 entries; output=19 checks passed | SELFTEST_OK

- [x] G7: a written conclusion names the cause with its evidence, or names what was eliminated and what remains
  EVIDENCE: .unlazy/gpu-memory-CONCLUSION.md. Names IOSurface compositor surfaces as the consumer (148MB of a
  297MB footprint, 50%, reconciling with the mapped surfaces at ratio 1.00) and records what was eliminated
  with its figures: not a leak (-0.8MB/min over 299s at a fixed count), not retained by use (408MB -> 408MB
  after 150s idle), not scrolling (408 -> 297MB, 76 -> 41 surfaces), not the terminal WebGL canvases (941 and
  1062MB with them released), not JavaScript (~12MB heaps). States plainly that the 1GB state was NOT
  reproduced on demand today — peak 522MB transient, settled 297-408MB at three workspaces — so the mechanism
  is consistent with the 941-1187MB readings rather than demonstrated at them. Recommends no code change and
  says why the one change already made on the opposite assumption was reverted.
