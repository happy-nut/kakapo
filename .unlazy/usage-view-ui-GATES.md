# The usage view's UI — gates

The data side of IntelliJ's module/test division shipped in #122; this is the part you can see. IntelliJ
does not say "test file" in words — it tints the ROW (File Colors) and marks the FOLDER (its
testSourceFolder icon), and its usage view is a tree with twistied nodes, an icon per node, the count in
parentheses after the name, and the occurrence bolded inside the line it sits on.

Values are IntelliJ's own: `FileColorManagerImpl` for the File Colors palette (Green #effae7/#49544a,
Yellow #ffffe4/#4f4b41), `TestsScope.getDefaultColorName()` for which scope takes Green, and the polygons
and hexes of `platform/icons/src/nodes/testSourceFolder.svg` (#62B543, #F26522), `Module.svg` (#40B6E0)
and `ppLibFolder.svg` for the folder marks.

- [x] G1 a usage node folds, keeps its count, and takes its rows out of the arrows' reach
      CHECK: node --test test/usage-grouping.test.mjs
      EXPECT: # fail 0
- [x] G2 Collapse All / Expand All fold and unfold the whole tree
      CHECK: node --test test/usage-grouping.test.mjs
      EXPECT: # fail 0
- [x] G3 each node carries the icon IntelliJ gives it, and a usage-type node carries none
      CHECK: node --test test/usage-grouping.test.mjs
      EXPECT: # fail 0
- [x] G4 the occurrence is marked inside the line, and the rest of the line survives
      CHECK: node --test test/usage-grouping.test.mjs
      EXPECT: # fail 0
- [x] G5 a folded tree is still a tree — it does not report "no usages"
      CHECK: node --test test/usage-grouping.test.mjs
      EXPECT: # fail 0
- [x] G6 a drag past the end of a short file selects to the end, not back to the top
      CHECK: node --test test/source-drag-selection.test.mjs
      EXPECT: # fail 0
- [x] G7 the whole suite passes
      CHECK: npm test
      EXPECT: # fail 0
- [x] G8 in the real app: the File Color is IntelliJ's exact value, the folder marks have a size, the
      nesting is drawn for headers AND rows, and the occurrence is actually bold
      CHECK: npm run nav:smoke
      EXPECT: checks passed in the real app

## Evidence — measured 2026-10-26, zsh, /Users/happynut/repos/kakapo

- G1..G5 `node --test test/usage-grouping.test.mjs` → `# pass 16 / # fail 0`.
- G6 `node --test test/source-drag-selection.test.mjs` → `# pass 5 / # fail 0`.
- G7 `npm test` → `# pass 942 / # fail 0` (929 before this change), run against one tree state with
  `npm run nav:smoke` straight after it.
- G8 `npm run nav:smoke` → `33/33 checks passed in the real app`, including the File Color by value
  (`rgb(73, 84, 74)` = #49544a), both folder marks with a real size, the nesting drawn for headers AND
  the rows under them, the occurrence at font-weight 700, and a CDP-injected drag that ends below the
  last line selecting from the drag's own anchor to the file's last row, rather than back to line 1.

Three defects this round, all of them invisible to jsdom and all three found in a real browser:
- rows were flush left under a four-deep header: `.quick-open-item`'s `padding` shorthand is declared
  later in viewer.css than the indent rule, so it won.
- a fully folded tree reported "no usages", because the empty-state check counted rows rather than nodes.
- the drag correction was first written on `mousemove` and did nothing at all: the browser updates a drag
  selection in that event's DEFAULT ACTION, which runs after listeners, so it overwrote the correction
  every time. It belongs on `selectionchange`, after the update.
