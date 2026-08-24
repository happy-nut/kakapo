# Gates: GPU process memory — find the cause

OWNS: .unlazy/gpu-memory-*, scripts/gpu-probe.mjs

Scope: install the four pending commits, then measure the Kakapo GPU process against a controlled
variable (number of live review renderers) until the 1 GB footprint is attributed to a named consumer
with a marginal cost per workspace, or the leading candidates are eliminated with evidence.

- [ ] G1: the installed app is built from the current HEAD — the blank-pane regression is gone and all four fixes are in
  CHECK: node scripts/gpu-probe.mjs verify-install
  EXPECT: INSTALL_OK
  EVIDENCE: pending

- [ ] G2: a startup time series exists that samples GPU footprint as each restored workspace boots
  CHECK: node scripts/gpu-probe.mjs series-check .unlazy/gpu-memory-series.json
  EXPECT: SERIES_OK
  EVIDENCE: pending

- [ ] G3: the marginal GPU cost per live renderer is measured from that series, not asserted
  CHECK: node scripts/gpu-probe.mjs marginal .unlazy/gpu-memory-series.json
  EXPECT: MARGINAL_OK
  EVIDENCE: pending

- [ ] G4: the dominant footprint category is attributed, and IOSurface totals reconcile with the sum of the individual surfaces
  CHECK: node scripts/gpu-probe.mjs attribute .unlazy/gpu-memory-attribution.json
  EXPECT: ATTRIBUTION_OK
  EVIDENCE: pending

- [ ] G5: steady state vs growth is settled — with the workspace count fixed, the footprint is sampled over time and the trend classified
  CHECK: node scripts/gpu-probe.mjs trend .unlazy/gpu-memory-trend.json
  EXPECT: TREND_OK
  EVIDENCE: pending

- [ ] G6: the measurement tooling is honest about the two mistakes already made this session — unit confusion and wrong-process capture
  CHECK: node scripts/gpu-probe.mjs selftest
  EXPECT: SELFTEST_OK
  EVIDENCE: pending

- [ ] G7: a written conclusion names the cause with its evidence, or names what was eliminated and what remains
  EVIDENCE: pending
