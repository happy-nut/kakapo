#!/usr/bin/env bash
# Everything this repository can check about itself, in the one order that is safe.
#
# The order is not a preference. test/menu-accelerators.test.mjs spawns the real Electron out of
# this checkout's node_modules, and the verify harness's stopApp() kills every Electron pid from
# this checkout, so a real-app run overlapping the suite kills that test's app and invalidates the
# run without either side saying so. Suite first, then the app, one at a time. An npm install in
# the middle does the same from the other side.
#
# Thin on purpose: every step is a command that already exists.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== build (jsdom reads dist/, so an untested build measures the old bundle)"
npm run build

echo "== jsdom suite"
npm test

echo "== the environment the real-app checks need"
node .claude/skills/verify-kakapo/doctor.mjs

echo "== the real app, in English and then in Korean"
node .claude/skills/verify-kakapo/stack-trace.mjs
KAKAPO_VERIFY_LOCALE=ko node .claude/skills/verify-kakapo/stack-trace.mjs

echo "== chrome text, measured at 1440 and 900 in both locales"
npm run ui:text

echo "== all of it passed; screenshots and transcripts are under .kakapo-verify/"
