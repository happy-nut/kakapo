// Layout-level CSS invariants that jsdom can't exercise (it has no flexbox layout — offsetHeight is always
// 0), so they're guarded as text against the built stylesheet. These regressed real, user-visible behaviour
// (the diff stopped scrolling and the caret fell off-screen on big files), so treat a break here as serious.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../dist/viewer.css", import.meta.url), "utf8");

// Return the declaration block of the FIRST rule whose selector text contains `needle`.
function ruleBodyContaining(needle) {
  const re = new RegExp("([^{}]*" + needle.replace(/[.#*\[\]]/g, "\\$&") + "[^{}]*)\\{([^}]*)\\}", "s");
  const m = css.match(re);
  return m ? m[2] : null;
}

function ruleBodyForExactSelector(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp("(^|})\\s*" + escaped + "\\s*\\{([^}]*)\\}", "s"));
  return m ? m[2] : null;
}

test("diff stays scrollable for a single big file: .d2h-file-wrapper keeps flex-shrink:0", () => {
  // The bug: #diff2html-container is a column flexbox and .d2h-file-wrapper has overflow:hidden, which makes
  // the flex item's min-height 0. With the default flex-shrink:1, a single shown file (showOnlyFile) shrinks
  // to the viewport height and overflow:hidden clips the rest — the diff can't scroll and the caret leaves
  // the screen near the bottom of a large file. flex-shrink:0 pins the wrapper to its content height.
  const wrapper = ruleBodyContaining(".d2h-file-wrapper");
  assert.ok(wrapper, ".d2h-file-wrapper rule must exist");
  assert.match(wrapper, /flex-shrink:\s*0\b/, "the fix: .d2h-file-wrapper must keep flex-shrink:0");

  // Guard the PRECONDITIONS too, so the test still means something if the layout is refactored: if overflow
  // stops being hidden, or the container stops being a column flexbox, the flex-shrink:0 may no longer be
  // load-bearing — but then this assertion forces a human to re-check rather than silently passing.
  assert.match(wrapper, /overflow:\s*hidden\b/, "precondition: wrapper still clips (overflow:hidden) — why shrink must be 0");
  const container = ruleBodyContaining("diff2html-container");
  assert.ok(container && /display:\s*flex/.test(css), "precondition: #diff2html-container is a flexbox");
  assert.match(css, /diff2html-container[^{}]*\{[^}]*flex-direction:\s*column/s, "precondition: container is a COLUMN flexbox");
});

test("a focused dock / settings overlay hides the file's blinking caret beneath it (single visible caret)", () => {
  // A focused merged/memo dock (or the settings overlay) owns the only caret. jsdom has no :has() and no
  // layout, so guard the rule as text: the file's .code-cursor must be display:none while the dock has focus
  // (or settings is up), so two carets can never blink across visible panels ("커서는 보이는 패널 통틀어 하나만").
  assert.match(css, /body:has\(\.dock-panel:focus-within\)\s*\.code-cursor[\s\S]{0,200}display:\s*none/, "a focused dock hides the file caret");
  assert.match(css, /body:has\(#settings-modal:not\(\.hidden\)\)\s*\.code-cursor/, "settings overlay covered");
});

test("the comment composer textarea restores its own caret (not transparent-inherited from the diff)", () => {
  // .mc-input is injected INSIDE #diff2html-container, which sets caret-color: transparent (the file view
  // uses a fake .code-cursor). caret-color inherits, so .mc-input must restore it — a focused textarea must
  // show its real caret. (The single-caret rule hides the FILE caret while composing, not the textarea's.)
  const input = ruleBodyContaining(".mc-input");
  assert.ok(input, ".mc-input rule must exist");
  assert.match(input, /caret-color:\s*var\(--text\)/, ".mc-input restores caret-color so the composer caret is visible");
});

test("source line-number gutter stays compact and internally aligned", () => {
  const body = ruleBodyContaining(".source-body");
  assert.ok(body, ".source-body rule must exist");
  assert.match(body, /--source-gutter-width:\s*56px\b/, "source gutter stays compact");

  const num = ruleBodyForExactSelector(".num");
  assert.ok(num, ".num rule must exist");
  assert.match(num, /width:\s*var\(--source-gutter-width\)/, "line-number cells use the shared gutter width");
  assert.match(num, /min-width:\s*var\(--source-gutter-width\)/, "long source lines cannot crush the gutter");
  assert.match(num, /max-width:\s*var\(--source-gutter-width\)/, "the gutter remains aligned with its painted background");
  assert.match(num, /padding:\s*2px\s+6px\b/, "line-number padding does not re-widen the gutter");

  const sourceNum = ruleBodyContaining(".source-table .num");
  assert.ok(sourceNum, "source table line-number override must exist");
  assert.match(sourceNum, /white-space:\s*nowrap/, "multi-digit line numbers never stack vertically");
  assert.match(sourceNum, /overflow-wrap:\s*normal/, "generic table-cell wrapping cannot split line numbers");

  assert.match(
    css,
    /source-body:not\(\.empty\):not\(\.image-body\)[^{}]*\{[\s\S]*var\(--source-gutter-width\)/,
    "the gutter background/divider uses the same shared width",
  );
  assert.match(
    css,
    /\.source-table\s+\.mc-thread-cell[^{}]*\{[^}]*calc\(var\(--source-gutter-width\)\s*\+\s*10px\)/,
    "source comment rows stay aligned with the compact gutter",
  );
});

test("raw source rows never soft-wrap, keeping caret scroll math stable", () => {
  const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
  const rule = css.match(/\.source-body:not\(\.rendered-body\)\s+\.source-row\s*>\s*\.source-code\s*\{[^}]+\}/)?.[0] || "";
  assert.match(rule, /white-space:\s*pre\s*;/, "raw code behaves like an editor line, not a wrapping document");
  assert.match(rule, /overflow-wrap:\s*normal\s*;/, "long tokens use horizontal scrolling instead of growing row height");
});

test("shared Markdown typography preserves readable paragraph rhythm", () => {
  const paragraph = ruleBodyContaining(".markdown-body p");
  assert.ok(paragraph, "shared Markdown paragraph rule exists");
  assert.match(paragraph, /margin:\s*0\s+0\s+1\.1em/, "paragraphs retain a visible bottom gap");
  assert.doesNotMatch(css, /\.md-cell\s*>\s*:last-child\s*\{[^}]*margin-bottom:\s*0/, "source block rows no longer erase every block's bottom margin");
});

test("packaged app reuses its top toolbars as compact draggable window chrome", () => {
  assert.match(css, /body\s*\{[^}]*--rail-width:\s*36px/, "the activity rail uses the compact desktop width");
  assert.match(css, /body\.native-app\s*\{[^}]*--native-titlebar-height:\s*40px/, "native title bar has one compact shared height");
  assert.match(css, /body\.native-app\s*\{[^}]*--native-traffic-safe-width:\s*76px/, "native window buttons expose their occupied width");
  assert.match(css, /body\.native-app\s+\.activity-rail\s*\{[^}]*padding-top:\s*calc\(var\(--native-titlebar-height\)/, "traffic lights do not cover activity buttons");
  assert.match(css, /body\.native-app\s+\.activity-rail\s*\{[^}]*border-right:\s*0/, "the full-height divider does not cross the traffic lights");
  assert.match(css, /body\.native-app\s+\.activity-rail::after\s*\{[^}]*top:\s*var\(--native-titlebar-height\)/, "the rail divider starts below the native controls");
  assert.match(css, /body\.native-app\s+\.activity-rail::before,[\s\S]{0,160}top:\s*var\(--native-titlebar-height\)/, "a horizontal divider closes the traffic-light strip");
  assert.match(css, /\.rail-btn\s*\{[^}]*width:\s*28px;\s*height:\s*28px/, "activity buttons stay compact while retaining a click target");
  assert.match(css, /\.rail-btn\s*>\s*svg\s*\{[^}]*width:\s*16px;\s*height:\s*16px/, "view icons match the smaller settings glyph");
  assert.match(css, /body\.native-app\s+\.sidebar\s*\{[^}]*padding-top:\s*var\(--native-titlebar-height\)/, "the non-scrolling sidebar frame permanently reserves the traffic-light row");
  assert.match(css, /body\.native-app\s+\.sidebar-scroll\s*\{[^}]*padding-top:\s*8px/, "the project tree keeps only its compact internal spacing");
  assert.match(css, /body\.native-app\s+\.diff-toolbar,[\s\S]{0,180}-webkit-app-region:\s*drag/, "the existing review toolbar moves the window");
  assert.match(css, /body\.native-app\s+\.diff-toolbar\s+button,[\s\S]{0,500}-webkit-app-region:\s*no-drag/, "toolbar actions remain clickable inside the drag region");
  assert.match(css, /body\.native-app\.sidebar-collapsed\s+\.diff-toolbar,[\s\S]{0,240}padding-left:\s*calc\(var\(--native-traffic-safe-width\)\s*-\s*var\(--rail-width\)\s*\+\s*8px\)/, "a collapsed sidebar keeps breadcrumbs clear of traffic lights");
  assert.match(css, /\.sidebar-brand,\s*\.sidebar-scroll,\s*\.sidebar-footer\s*\{[^}]*width:\s*var\(--sidebar-width,\s*264px\)/, "fixed header and scrolling contents keep their layout while the grid track closes");
  assert.doesNotMatch(css, /body\.sidebar-collapsed\s+\.sidebar\s*\{[^}]*visibility:\s*hidden/, "sidebar content is not blanked before the close animation finishes");
  assert.match(css, /\.sidebar-resizer\s*\{[^}]*transition:\s*left\s+180ms/, "the resize divider follows the collapsing track instead of jumping");
});

test("non-code panels use dedicated high-contrast chrome tokens", () => {
  assert.match(css, /--chrome-bg:\s*#1c1d1f/, "dark chrome uses a neutral canvas without a blue cast");
  assert.match(css, /--chrome-panel:\s*#232426/, "dark floating panels use a neutral surface");
  assert.match(css, /--chrome-text:\s*#f1f1f2/, "dark chrome has brighter primary text");
  assert.match(css, /--chrome-muted:\s*#b9bbc0/, "dark chrome secondary text remains readable");
  assert.match(css, /--chrome-selected:\s*#3a3c40/, "menu selection fill stays neutral instead of tinting the whole UI blue");
  assert.match(css, /\.activity-rail,[\s\S]{0,180}background:\s*var\(--chrome-bg\)/, "navigation uses the UI-only canvas");
  assert.match(css, /\.settings-panel,[\s\S]{0,420}background:\s*var\(--chrome-panel\)/, "floating panels use the stronger surface");
  const sourceBody = ruleBodyForExactSelector(".source-body");
  assert.ok(sourceBody, "source body rule exists");
  assert.match(sourceBody, /background:\s*var\(--panel\)/, "the code view keeps the code canvas");
  assert.doesNotMatch(sourceBody, /--chrome-/, "UI tokens do not leak into the code view");
});

test("modern chrome uses one compact radius and elevation system without rounding code tables", () => {
  assert.match(css, /--ui-radius-sm:\s*6px/, "compact controls share a six-pixel radius");
  assert.match(css, /--ui-radius-xl:\s*14px/, "floating surfaces share a restrained large radius");
  assert.match(css, /\.settings-panel,[\s\S]{0,180}border-radius:\s*var\(--ui-radius-xl\)/, "settings and floating panels use the surface radius");
  assert.match(css, /\.tree-dir summary,[\s\S]{0,240}border-radius:\s*var\(--ui-radius-sm\)/, "navigation rows use the compact control radius");
  assert.match(css, /\.settings-textarea,[\s\S]{0,180}border-radius:\s*var\(--ui-radius-md\)/, "form controls share the medium radius");
  assert.match(css, /\.rail-btn\s*>\s*svg\s*\{[^}]*width:\s*16px;\s*height:\s*16px/, "all rail SVGs occupy the same optical box");
  assert.match(css, /\.d2h-file-wrapper\s*\{[^}]*border-radius:\s*0/, "diff rows retain exact square alignment");
  assert.match(css, /\.source-body\s*\{[^}]*border:\s*1px solid var\(--border\)/, "the source canvas remains a flat editor surface");
});

test("activity rail shortcut bubbles disappear when hover ends even if the button keeps focus", () => {
  assert.match(css, /\.rail-btn:hover\s+\.rail-tip\s*\{[^}]*opacity:\s*1/, "pointer hover reveals the rail shortcut bubble");
  assert.doesNotMatch(
    css,
    /\.rail-btn:focus-visible\s+\.rail-tip\s*\{[^}]*opacity:\s*1/,
    "retained keyboard focus must not leave a shortcut bubble stuck over the project tree",
  );
});

test("diff hunk connectors bridge both center line-number gutters without stealing input", () => {
  const connector = ruleBodyContaining(".mc-diff-connectors");
  assert.ok(connector, "the center-gutter connector overlay exists");
  assert.match(connector, /width:\s*104px/, "the overlay spans both 52px line-number gutters");
  assert.match(connector, /pointer-events:\s*none/, "connectors never block text selection or caret clicks");
  assert.match(connector, /z-index:\s*4/, "the curve crosses the opaque gutter backgrounds");
  const connectorShape = ruleBodyForExactSelector(".mc-diff-connector");
  assert.match(connectorShape || "", /stroke:\s*none/, "the connector fill has no rectangular outline around the line-number gutters");
  const addedConnector = ruleBodyForExactSelector(".mc-diff-connector-added");
  assert.match(addedConnector || "", /fill:\s*color-mix\(in srgb, var\(--diff-added\) 78%, transparent\)/, "the addition curve stays translucent enough to preserve line-number legibility");
  assert.match(connector, /shape-rendering:\s*geometricPrecision/, "curved connector edges use geometric precision");
  const asymmetricLayer = ruleBodyForExactSelector(".mc-asymmetric-scroll-content");
  assert.match(asymmetricLayer || "", /will-change:\s*transform/, "the base code and gutter stack stays on one composited scroll layer");

  const changedNumber = ruleBodyContaining(".d2h-diff-table tr.mc-diff-change > td.d2h-code-side-linenumber");
  assert.ok(changedNumber, "changed line numbers have an explicit connector-aware rule");
  assert.match(changedNumber, /background-color:\s*var\(--panel\)\s*!important/, "the curve is not stacked over rectangular change fills");

  const oldNumber = ruleBodyContaining(".d2h-file-side-diff:first-child .mc-diff-gutter-layer");
  const newNumber = ruleBodyForExactSelector(".mc-diff-gutter-layer");
  assert.ok(oldNumber && newNumber, "both diff gutters use the panel-level layer");
  const numberCell = ruleBodyForExactSelector(".d2h-code-side-linenumber");
  assert.match(numberCell || "", /position:\s*relative/, "diff2html number cells remain non-sticky model anchors");
  assert.match(newNumber, /position:\s*sticky/, "each pane pins one native gutter layer instead of every row cell");
  assert.match(newNumber, /pointer-events:\s*none/, "the gutter layer cannot interfere with selection or caret clicks");
  assert.match(oldNumber, /left:\s*calc\(100cqw\s*-\s*52px\)/, "the base gutter sticks to the centre edge using the pane viewport, not code width");
  assert.match(newNumber, /left:\s*0/, "the working-tree gutter sticks to the centre edge");
  assert.match(css, /\.mc-layered-diff-side\s+\.d2h-code-side-linenumber\s*\{[^}]*visibility:\s*hidden/, "the original table cells are never painted as a second gutter");
  const diffTable = ruleBodyForExactSelector(".d2h-diff-table");
  assert.match(diffTable || "", /width:\s*max-content/, "the sticky containing block spans the full horizontal scroll range");
  assert.match(diffTable || "", /min-width:\s*100%/, "short diffs still fill their pane");
  assert.match(diffTable || "", /table-layout:\s*auto/, "the table exposes its real content width to sticky positioning");
  assert.match(diffTable || "", /border-spacing:\s*0/, "table spacing cannot reopen a seam between the change background and gutter");
  assert.doesNotMatch(css, /--mc-diff-(?:gutter|code)-offset/, "no scroll-following transform variables remain");

  const insertionResume = ruleBodyContaining(".mc-asymmetric-insert-resume > td");
  const insertionTail = ruleBodyContaining(".mc-asymmetric-insert-tail > td");
  assert.match(insertionResume || "", /color-mix\(in srgb, var\(--diff-added\) 78%, transparent\)/, "the collapsed base-side marker matches the translucent addition curve");
  assert.match(insertionTail || "", /color-mix\(in srgb, var\(--diff-added\) 78%, transparent\)/, "a trailing collapsed insertion matches the translucent addition curve");
  assert.doesNotMatch((insertionResume || "") + (insertionTail || ""), /var\(--active\)/, "insertion markers never fall back to unrelated blue focus color");
});

test("diff comment composers stay pinned inside the working-tree viewport", () => {
  const card = ruleBodyForExactSelector(".mc-layered-diff-side:last-of-type .mc-comment-row .mc-card");
  assert.match(card || "", /position:\s*sticky/, "diff comments are viewport UI, not horizontally scrolling source text");
  assert.match(card || "", /left:\s*62px/, "the comment begins ten pixels after the single visible working-tree gutter");
  assert.match(card || "", /max-width:\s*calc\(100cqw\s*-\s*74px\)/, "the composer and its actions cannot be clipped at the pane's right edge");
  const spacerCell = ruleBodyForExactSelector(".mc-comment-spacer-row td");
  assert.match(spacerCell || "", /background:\s*var\(--bg\)/, "the paired base timeline slot cannot expose a split table background");
  assert.match(css, /\.mc-comment-spacer\s*\{[^}]*pointer-events:\s*none/, "the invisible paired slot never steals review input");
});
