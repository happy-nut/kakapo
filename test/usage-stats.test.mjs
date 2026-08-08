// The footer battery shows the quota that runs out FIRST. Claude's /usage payload lists per-model weekly caps
// alongside the session window, and reading only the session one reported "90% left" while the Fable weekly cap
// sat at 86% used — the window that actually stops work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeLimits, nextQuotaCache } from "../dist/usage-stats.js";

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
  assert.deepEqual(limits.map((l) => [l.kind, l.label, l.usedPercent]), [["weekly", "Fable", 86], ["weekly", "", 53], ["session", "", 10]]);
  assert.ok(limits[0].resetsAt > 0);
});

test("a failed refresh keeps the last good quota rather than dropping to a token count", () => {
  const good = { at: 1_000_000, value: [{ kind: "weekly", label: "Fable", usedPercent: 86, resetsAt: 0 }] };
  // The endpoint rate-limits; a 429 must not downgrade a live % to a raw token count.
  assert.equal(nextQuotaCache(good.at + 90_000, good, undefined), good);
  assert.equal(nextQuotaCache(good.at + 6 * 60 * 60_000, good, undefined), good, "a kept % beats no number at all");
  const fresher = [{ kind: "weekly", label: "Fable", usedPercent: 90, resetsAt: 0 }];
  assert.deepEqual(nextQuotaCache(good.at + 90_000, good, fresher), { at: good.at + 90_000, value: fresher });
});

test("an older payload without `limits` still yields the five-hour and weekly windows", () => {
  const limits = claudeLimits({ five_hour: { utilization: 10 }, seven_day: { utilization: 53 } });
  assert.deepEqual(limits.map((l) => [l.kind, l.usedPercent, l.resetsAt]), [["weekly", 53, 0], ["session", 10, 0]]);
  assert.deepEqual(claudeLimits({}), []);
});
