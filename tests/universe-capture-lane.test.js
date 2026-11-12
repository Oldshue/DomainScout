"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { plan } = require("../scripts/universe-capture-lane");

test("capture lane runs only inside its window and once per published day", () => {
  const at = (iso, state) => plan({ now: new Date(iso), windowMinutes: 170, state });
  assert.deepEqual(at("2026-09-16T07:02:00Z"), { day: "2026-09-16", run: false, reason: "before-window" });
  assert.equal(at("2026-09-16T07:05:00Z").run, true);
  assert.equal(at("2026-09-16T07:05:00Z").closes, Date.parse("2026-09-16T09:50:00Z"));
  assert.equal(at("2026-09-16T09:29:00Z").run, true);
  assert.equal(at("2026-09-16T09:30:00Z").reason, "window-closed");
  assert.equal(at("2026-09-17T03:00:00Z").reason, "window-closed");
  assert.equal(at("2026-09-16T08:00:00Z", { day: "2026-09-16", complete: true }).reason, "published");
  assert.equal(at("2026-09-16T08:00:00Z", { day: "2026-09-15", complete: true }).run, true);
  assert.equal(at("2026-09-16T08:00:00Z", { day: "2026-09-16", complete: false }).run, true);
});
