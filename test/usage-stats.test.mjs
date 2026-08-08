// The footer battery shows the quota that runs out FIRST. Claude's /usage payload lists per-model weekly caps
// alongside the session window, and reading only the session one reported "90% left" while the Fable weekly cap
// sat at 86% used — the window that actually stops work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeLimits } from "../dist/usage-stats.js";

test("claude limits are worst-first across every window, labelled by scope", () => {
  const limits = claudeLimits({
    five_hour: { utilization: 10, resets_at: "2026-08-08T04:39:59.697720+00:00" },
    seven_day: { utilization: 53, resets_at: "2026-08-12T09:59:59.697746+00:00" },
    limits: [
      { kind: "session", percent: 10, resets_at: "2026-08-08T04:39:59.697720+00:00", scope: null },
      { kind: "weekly_all", percent: 53, resets_at: "2026-08-12T09:59:59.697746+00:00", scope: null },
      { kind: "weekly_scoped", percent: 86, resets_at: "2026-08-12T10:00:00.698006+00:00", scope: { model: { display_name: "Fable" } } },
    ],
  });
  assert.deepEqual(limits.map((l) => [l.label, l.usedPercent]), [["Fable", 86], ["weekly", 53], ["5h", 10]]);
  assert.ok(limits[0].resetsAt > 0);
});

test("an older payload without `limits` still yields the five-hour and weekly windows", () => {
  const limits = claudeLimits({ five_hour: { utilization: 10 }, seven_day: { utilization: 53 } });
  assert.deepEqual(limits.map((l) => [l.label, l.usedPercent, l.resetsAt]), [["weekly", 53, 0], ["5h", 10, 0]]);
  assert.deepEqual(claudeLimits({}), []);
});
