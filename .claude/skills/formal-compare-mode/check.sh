#!/bin/sh
set -u

here=$(cd "$(dirname "$0")" && pwd)
jar=${TLA_TOOLS:-$HOME/.cache/kakapo-formal/tla2tools.jar}

if [ ! -f "$jar" ]; then
  echo "tla2tools.jar not found at $jar"
  echo "fetch it with:"
  echo "  mkdir -p $(dirname "$jar") && curl -sL -o $jar https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar"
  exit 2
fi
command -v java >/dev/null 2>&1 || { echo "java not found — TLC needs a JVM (brew install openjdk)"; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$here/CompareMode.tla" "$work/"

failed=0
for auto in TRUE FALSE; do
  for mark in TRUE FALSE; do
   for restored in FALSE; do
    cat > "$work/Run.cfg" <<EOF
SPECIFICATION Spec
CONSTANTS
    AutoResolves = $auto
    MarkUsable = $mark
    RestoredTip = $restored
INVARIANTS
    TypeOK
    MenuTellsTheTruth
EOF
    printf '\n=== AutoResolves=%s MarkUsable=%s RestoredTip=%s ===\n' "$auto" "$mark" "$restored"
    # Its own metadata directory per run. TLC names that directory after the clock, and eight runs of a
    # sixteen-state model all start inside the same second — so sharing one working directory made a run
    # collide with its predecessor's metadata and produce NO output at all, neither a result nor an error.
    # A checker that can be silent is worse than one that fails.
    meta="$work/meta-$auto-$mark-$restored"
    out=$(cd "$work" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
            -config Run.cfg -metadir "$meta" -workers auto CompareMode.tla 2>&1)
    if printf '%s' "$out" | grep -q "Model checking completed. No error has been found."; then
      states=$(printf '%s\n' "$out" | grep -E "^[0-9]+ states generated" | head -1)
      echo "  holds${states:+ — $states}"
    elif printf '%s' "$out" | grep -q "Error: Invariant"; then
      failed=1
      printf '%s\n' "$out" | sed -n '/Error: Invariant/,$p' | head -60
    else
      failed=1
      echo "  TLC did not produce a result:"
      printf '%s\n' "$out" | tail -20 | sed 's/^/    /'
    fi
   done
  done
done

if [ "$failed" -eq 0 ]; then
  echo
  echo "MenuTellsTheTruth holds in all four shapes."
else
  echo
  echo "MenuTellsTheTruth is violated — read the trace above as a sequence of handler calls."
fi
exit "$failed"
