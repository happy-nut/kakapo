import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../dist/viewer.css", import.meta.url), "utf8");

function ruleBodyContaining(needle) {
  const re = new RegExp("([^{}]*" + needle.replace(/[.#*\[\]]/g, "\\$&") + "[^{}]*)\\{([^}]*)\\}", "s");
  const m = css.match(re);
  return m ? m[2] : null;
}

const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBodyForExactSelector(selector) {
  const bodies = ruleBodiesForExactSelector(selector);
  return bodies.length ? bodies[0] : null;
}

function ruleBodiesForExactSelector(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?:^|})\\s*" + escaped + "\\s*\\{([^}]*)\\}", "g");
  return Array.from(cssRules.matchAll(re), (m) => m[1]);
}

function ruleDeclaring(selector, needle) {
  return ruleBodiesForExactSelector(selector).find((b) => b.includes(needle)) ?? null;
}

test("diff stays scrollable for a single big file: .d2h-file-wrapper keeps flex-shrink:0", () => {
  const wrapper = ruleBodyContaining(".d2h-file-wrapper");
  assert.ok(wrapper, ".d2h-file-wrapper rule must exist");
  assert.match(wrapper, /flex-shrink:\s*0\b/, "the fix: .d2h-file-wrapper must keep flex-shrink:0");

  assert.match(wrapper, /overflow:\s*hidden\b/, "precondition: wrapper still clips (overflow:hidden) — why shrink must be 0");
  const container = ruleBodyContaining("diff2html-container");
  assert.ok(container && /display:\s*flex/.test(css), "precondition: #diff2html-container is a flexbox");
  assert.match(css, /diff2html-container[^{}]*\{[^}]*flex-direction:\s*column/s, "precondition: container is a COLUMN flexbox");
});

test("a focused dock / settings overlay hides the file's blinking caret beneath it (single visible caret)", () => {
  assert.match(css, /body:has\(\.dock-panel:focus-within\)\s*\.code-cursor[\s\S]{0,200}display:\s*none/, "a focused dock hides the file caret");
  assert.match(css, /body:has\(#settings-modal:not\(\.hidden\)\)\s*\.code-cursor/, "settings overlay covered");
});

test("the merged dock is a centred floating panel with clickable header controls", () => {
  const panelWidth = /\.dock-panel\s*\{\s*position:\s*fixed;[^}]*width:\s*min\((\d+)px,\s*calc\(100vw\s*-\s*(\d+)px\)\)/s.exec(css);
  assert.ok(panelWidth, "the floating panel declares a width capped against the viewport");
  const cardWidth = /\.mc-card\s*\{[^}]*max-width:\s*(\d+)px/s.exec(css);
  assert.ok(cardWidth, "the card it wraps declares a width");
  const [panel, gutter, card] = [Number(panelWidth[1]), Number(panelWidth[2]), Number(cardWidth[1])];
  assert.ok(panel > card, `the panel (${panel}px) is wider than the card it wraps (${card}px)`);
  assert.ok(panel - card <= 240,
    `the panel wraps the card rather than stranding ${panel - card}px of unusable surface beside it`);
  assert.ok(gutter > 0, "and it stays inset from the viewport edges");
  assert.match(css, /\.dock-panel\s*\{\s*position:\s*fixed;[^}]*left:\s*50%/s, "the panel stays centred");
  const dockButtons = ruleBodyForExactSelector(".dock-bar button");
  const activeDockButtons = ruleBodyForExactSelector(".dock-bar button:not(:disabled)");
  assert.match(dockButtons || "", /-webkit-app-region:\s*no-drag/, "every dock-header button remains interactive in Electron chrome");
  assert.match(activeDockButtons || "", /cursor:\s*pointer/, "clear, copy, and maximize controls advertise clickability");
});

const layerLadder = () => {
  const root = /^:root \{([\s\S]*?)^\}/m.exec(css);
  assert.ok(root, "the stylesheet still opens with a :root block");
  const rungs = [...root[1].matchAll(/^\s*(--z-[\w-]+):\s*(\d+);/gm)].map((m) => [m[1], Number(m[2])]);
  assert.ok(rungs.length >= 14, `the ladder is declared in :root (found ${rungs.length} rungs)`);
  return rungs;
};
const layerOf = (selector) => {
  const at = css.indexOf("\n" + selector + " {");
  assert.ok(at >= 0, `${selector} has a rule of its own`);
  const body = css.slice(at, css.indexOf("}", at));
  const match = /z-index:\s*var\((--z-[\w-]+)\)/.exec(body);
  assert.ok(match, `${selector} takes its z-index from the ladder, not from a literal: ${body.trim()}`);
  const rung = layerLadder().find(([name]) => name === match[1]);
  assert.ok(rung, `${selector} names ${match[1]}, which is not on the ladder`);
  return rung[1];
};

test("the layer ladder is declared in the order it paints", () => {
  const rungs = layerLadder();
  for (let i = 1; i < rungs.length; i += 1) {
    assert.ok(rungs[i][1] >= rungs[i - 1][1],
      `${rungs[i][0]} (${rungs[i][1]}) is declared after ${rungs[i - 1][0]} (${rungs[i - 1][1]}) but paints below it`);
  }
});

test("no application surface writes a raw z-index", () => {
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const offenders = [...declarations.matchAll(/z-index:\s*(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((value) => value >= 40);
  assert.deepEqual(offenders, [],
    "an application layer is declared as a literal; put it on the ladder in :root so its order is visible");
  assert.ok(/z-index:\s*var\(--z-/.test(declarations), "surfaces take their layer from the ladder");
});

test("the modal launcher paints above the surfaces it can be opened over", () => {
  const quickOpen = layerOf(".quick-open");
  assert.ok(layerOf(".file-find") < quickOpen, "the current-file search is editor chrome, not a modal");
  assert.ok(layerOf(".dock-panel") < quickOpen, "Cmd+E over an open terminal must not open behind it");
  assert.ok(layerOf(".settings-modal") < quickOpen, "Cmd+E over Settings must not open behind it");
  assert.ok(layerOf(".history-view") < quickOpen, "Cmd+E over History/Explain must not open behind it");
});

test("the caret hint paints above the surfaces it answers from", () => {
  const hint = layerOf(".mc-caret-hint");
  assert.ok(hint > layerOf(".dock-panel"), "a reply raised with the dock open has to be readable");
  assert.ok(hint > layerOf(".dock-backdrop"), "and not dimmed by the backdrop either");
  assert.ok(hint > layerOf(".history-view"), "History raises hints of its own");
  assert.ok(hint < layerOf(".settings-modal"), "Settings owns the screen while it is open");
});

test("scrollbar thumbs remain layout-stable but only paint while scrolling", () => {
  const gutter = ruleBodyForExactSelector("::-webkit-scrollbar");
  const thumb = ruleBodyForExactSelector("::-webkit-scrollbar-thumb");
  const activeThumb = ruleBodyForExactSelector(".mc-scroll-active::-webkit-scrollbar-thumb");
  assert.match(gutter || "", /width:\s*9px/, "hiding the thumb keeps a fixed scrollbar gutter so content never shifts");
  assert.match(gutter || "", /height:\s*9px/, "horizontal scroll surfaces keep the same reserved gutter too");
  assert.match(thumb || "", /background-color:\s*transparent/, "an idle scrollbar hides its thumb without removing its gutter");
  assert.match(thumb || "", /transition:\s*background-color\s+180ms/, "the thumb fades instead of disappearing abruptly");
  assert.match(activeThumb || "", /background-color:\s*color-mix/, "active scrolling reveals the thumb");
  assert.match(css, /::-webkit-scrollbar-corner,\s*\n::-webkit-resizer\s*\{\s*background:\s*transparent/, "scrollable previews never expose a white native corner or resize patch");
});

test("Find in Files uses a wide result canvas with compact, mode-local filters", () => {
  const panel = ruleBodyForExactSelector(".quick-open-panel");
  assert.match(panel || "", /width:\s*min\(980px,\s*calc\(100vw\s*-\s*48px\)\)/, "project search has enough width for file, match, and path columns");
  assert.match(css, /\.quick-open-search-options\s*\{[^}]*display:\s*none/s, "search-only controls do not leak into file or recent dialogs");
  assert.match(css, /\.quick-open\.quick-content \.quick-open-search-options\s*\{[^}]*display:\s*flex/s, "extension and noise filters appear in Find in Files");
  assert.match(css, /\.qp-search-hit\s*\{[^}]*background:\s*color-mix/s, "the selected occurrence is visibly marked in the surrounding-code preview");
});

test("semantic navigation keeps filenames readable and test results visually distinct", () => {
  const label = ruleBodyForExactSelector(".semantic-peek-item-path");
  assert.match(label || "", /color:\s*var\(--chrome-text\)/, "basename:line labels use the high-contrast chrome text color");
  assert.match(css, /\.semantic-peek-item\.is-test,[\s\S]{0,120}\.quick-open-item\.usage-item\.is-test\s*\{[^}]*background:\s*color-mix/s, "test results receive a green-tinted background in both semantic result surfaces");
  assert.match(css, /\.semantic-peek-item\s*\{[^}]*grid-template-columns:\s*minmax\(145px,\s*36%\)\s+minmax\(0,\s*1fr\)/s, "the result row dedicates one compact column to basename:line instead of a full path plus line column");
});

test("Viewed state has no control inside the diff canvas or toolbar", () => {
  const renderSource = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
  assert.doesNotMatch(renderSource, /id=["']diff-viewed-toggle["']/, "the diff toolbar has no Viewed pill");
  const nativeViewed = ruleBodyForExactSelector(".d2h-file-collapse");
  assert.match(nativeViewed || "", /display:\s*none\s*!important/, "diff2html's native file-header checkbox stays unavailable");
});

test("folded-context labels stay centred in the visible diff pane", () => {
  const fold = ruleBodyForExactSelector(".mc-context-fold");
  assert.match(fold || "", /position:\s*sticky/, "the control follows the pane viewport instead of the max-content table");
  assert.match(fold || "", /left:\s*12px/, "equal viewport insets keep the control centred while horizontally scrolling");
  assert.match(fold || "", /width:\s*calc\(100cqw\s*-\s*24px\)/, "the control fits within the pane and leaves room for native scrollbar gutters");
  assert.match(fold || "", /max-width:\s*calc\(100cqw\s*-\s*24px\)/, "long labels cannot widen the control beyond the pane");
  const label = ruleBodyForExactSelector(".mc-context-fold-label");
  assert.match(label || "", /text-overflow:\s*ellipsis/, "an unusually long translation is clipped inside the centred control");
  assert.match(label || "", /white-space:\s*nowrap/, "the compact fold bar remains one line tall");
});

test("the empty-pane message centers without shrinking the pane into a stripe", () => {
  const scoped = ruleBodyForExactSelector("#diff2html-container > .empty");
  assert.match(scoped || "", /margin:\s*auto/, "the diff container's lone empty div still centers on both axes");
  assert.doesNotMatch(ruleBodyContaining(".empty") || "", /margin:\s*auto/,
    "…while the shared .empty rule leaves .source-body.empty at full width");
  assert.match(ruleBodyContaining(".source-body.empty") || "", /justify-content:\s*center/,
    "which centers its own text instead");
});

test("the comment composer textarea restores its own caret (not transparent-inherited from the diff)", () => {
  const input = ruleBodyContaining(".mc-input");
  assert.ok(input, ".mc-input rule must exist");
  assert.match(input, /caret-color:\s*var\(--text\)/, ".mc-input restores caret-color so the composer caret is visible");
});

test("source line-number gutter stays compact and internally aligned", () => {
  const owner = ruleDeclaring(".source-viewer", "--source-gutter-width");
  assert.ok(owner, ".source-viewer must declare the gutter width");
  assert.match(owner, /--source-gutter-width:\s*56px\b/, "source gutter stays compact");

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
  assert.match(
    css,
    /\.source-body\.source-blame-visible[^{}]*\{[^}]*--source-gutter-width:\s*clamp\(/,
    "blame expands the existing gutter instead of opening a separate panel",
  );
  assert.match(
    css,
    /\.source-blame-entry\s*\{[^}]*grid-template-columns:\s*64px\s+minmax\(0,\s*1fr\)/,
    "blame keeps distinct date and author columns beside the line number",
  );
  assert.match(
    css,
    /\.source-body\.source-blame-visible\s+\.source-table \.num\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
    "date and author grow to the left while the original source line-number edge stays beside code",
  );
  assert.match(css, /\.source-body\.source-blame-visible\s+\.source-table \.num\s*\{[^}]*gap:\s*6px/, "source attribution leaves a compact gap before the intrinsic-width line number");
  assert.match(css, /\.source-blame-entry\.mc-blame-age-0[^}]*background:/, "newest source blame rows have an age color");
  assert.match(css, /\.source-blame-entry\.mc-blame-age-4[^}]*background:/, "oldest source blame rows have a distinct age color");
});

test("raw source rows keep one-line defaults and expose an explicit wrap mode", () => {
  const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
  const rule = css.match(/\.source-body:not\(\.rendered-body\)\s+\.source-row\s*>\s*\.source-code\s*\{[^}]+\}/)?.[0] || "";
  assert.match(rule, /white-space:\s*pre\s*;/, "raw code behaves like an editor line, not a wrapping document");
  assert.match(rule, /overflow-wrap:\s*normal\s*;/, "long tokens use horizontal scrolling instead of growing row height");
  const wrapRule = css.match(/\.source-body\.line-wrap:not\(\.rendered-body\)\s+\.source-row\s*>\s*\.source-code\s*\{[^}]+\}/)?.[0] || "";
  assert.match(wrapRule, /white-space:\s*pre-wrap\s*;/, "line-wrap mode preserves indentation while wrapping long lines");
  assert.match(wrapRule, /overflow-wrap:\s*anywhere\s*;/, "line-wrap mode also contains long unbroken tokens");
  assert.match(css, /\.source-body\.line-wrap:not\(\.rendered-body\)\s+\.source-table\s*\{[^}]*table-layout:\s*fixed/, "wrap mode constrains the code column to the viewport");
});

test("diff line wrap constrains both panes while preserving the fixed gutter", () => {
  const sourceCss = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
  assert.match(
    sourceCss,
    /#diff2html-container\.line-wrap\s+\.d2h-diff-table\s*\{[^}]*width:\s*100%[^}]*table-layout:\s*auto/s,
    "wrapped diff tables fit their pane while preserving the explicit line-number column after colspan hunk rows",
  );
  assert.match(
    sourceCss,
    /#diff2html-container\.line-wrap\s+\.d2h-code-line-ctn\s*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/s,
    "diff wrapping preserves indentation and contains long tokens",
  );
  assert.match(
    sourceCss,
    /#diff2html-container\.line-wrap\s+\.d2h-file-side-diff\s*\{[^}]*overflow-x:\s*hidden/,
    "wrapped panes no longer expose a redundant horizontal scrollbar",
  );
  assert.match(sourceCss, /\.mc-diff-gutter-layer[^}]*width:\s*52px/, "the layered gutter width remains independent of wrapped code");
  assert.match(
    sourceCss,
    /\.mc-diff-blame-visible \.d2h-file-side-diff:first-child \.mc-diff-gutter-number[^}]*grid-template-columns:\s*max-content\s+minmax\(0,\s*1fr\)/,
    "base blame keeps its line number first, directly beside base code",
  );
  assert.match(
    sourceCss,
    /\.mc-diff-blame-visible \.d2h-file-side-diff:last-of-type \.mc-diff-gutter-number[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content/,
    "working-tree blame keeps its line number last, directly beside working code",
  );
  assert.match(sourceCss, /\.mc-diff-blame-visible \.mc-diff-gutter-number[^}]*gap:\s*6px/, "diff attribution and line number remain visibly separated on both panes");
  assert.match(sourceCss, /\.mc-diff-blame-entry\.mc-blame-age-0[^}]*background:/, "diff blame uses the same newest age color");
});

test("shared Markdown typography preserves readable paragraph rhythm", () => {
  const paragraph = ruleBodyContaining(".markdown-body p");
  assert.ok(paragraph, "shared Markdown paragraph rule exists");
  assert.match(paragraph, /margin:\s*0\s+0\s+1\.1em/, "paragraphs retain a visible bottom gap");
  assert.doesNotMatch(css, /\.md-cell\s*>\s*:last-child\s*\{[^}]*margin-bottom:\s*0/, "source block rows no longer erase every block's bottom margin");
});

test("the sidebar collapses without blanking its contents or jumping its divider", () => {
  assert.match(css, /body\s*\{[^}]*--rail-width:\s*0px/, "no rail column is reserved");
  const trackDefault = /grid-template-columns:\s*var\(--rail-width\)\s*var\(--sidebar-width,\s*(\d+)px\)/.exec(css);
  assert.ok(trackDefault, "the grid declares a sidebar track with a default width");
  const fallback = new RegExp(
    String.raw`\.sidebar-brand,\s*\.sidebar-scroll\s*\{[^}]*width:\s*var\(--sidebar-width,\s*${trackDefault[1]}px\)`,
  );
  assert.match(css, fallback, "fixed header and scrolling contents keep their layout while the grid track closes");
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
  assert.doesNotMatch(css, /\.rail-btn\.is-active::before/, "activity selection uses a complete surface rather than a partial blue rail");
  assert.match(css, /\.rail-btn\.is-active\s*\{[^}]*background:\s*var\(--chrome-selected\)/, "the active rail button is one filled surface");
  assert.match(css, /\.tree-focus,[\s\S]{0,220}box-shadow:\s*none/, "sidebar selections use a complete neutral surface without an inset accent");
  const tabStrip = css.match(/^\.source-tabs\s*\{([^}]*)\}/m)?.[1];
  assert.ok(tabStrip, "the file tab strip has a rule of its own");
  assert.match(tabStrip, /height:\s*var\(--header-band\)/, "the tab strip is exactly the shared header band");
  assert.match(tabStrip, /margin:\s*0/, "and adds no outer spacing that would lift its bottom rule");
  assert.doesNotMatch(tabStrip, /padding/, "nothing sits under the tabs: the strip's rule meets the sidebar header's");
  assert.match(css, /\.source-tab\s*\{[^}]*border-radius:\s*var\(--ui-radius-md\) var\(--ui-radius-md\) 0 0/, "file tabs only round their attached top corners");
  assert.match(css, /\.source-tab\.active\s*\{[^}]*margin-bottom:\s*-1px[^}]*background:\s*var\(--chrome-bg\)[^}]*box-shadow:\s*none/, "the active tab joins the content surface without a floating shadow");
  assert.match(css, /\.source-tabs\s*\{[^}]*overflow:\s*hidden/, "overflowing file tabs are collected instead of exposing a horizontal scroller");
  assert.match(css, /\.source-tab-overflow\s*\{[^}]*flex:\s*0\s+0\s+44px/, "the N+ group reserves one stable compact tab width");
  assert.match(css, /\.settings-cat\.active\s*\{[^}]*box-shadow:\s*none/, "settings navigation follows the same full-surface selection language");
});

const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, "");
function selectorOfRuleContaining(declaration) {
  const i = cssBare.indexOf(declaration);
  if (i < 0) return null;
  return cssBare.slice(0, cssBare.lastIndexOf("{", i)).split(/[{}]/).pop().trim().replace(/\s+/g, " ");
}

test("the shared transition names every interactive chrome row, and no code row", () => {
  const selector = selectorOfRuleContaining("transition: color 120ms ease, background-color 120ms");
  assert.ok(selector, "the shared chrome transition rule still exists");
  for (const row of [".change-row", ".file-link", ".tree-dir summary", ".viewed-box"]) {
    assert.ok(selector.includes(row), `${row} is a row the pointer lands on — it shares the one transition: ${selector}`);
  }
  for (const code of [".source-row", ".code-cursor", ".d2h-code-line", ".source-code"]) {
    assert.ok(!selector.includes(code), `${code} is the code canvas: a transition there is paid per caret move`);
  }
});

test("every surface that opens over the app shares one entrance", () => {
  const selector = selectorOfRuleContaining("animation: mc-surface-in");
  assert.ok(selector, "the shared entrance rule still exists");
  for (const surface of [".dock-panel", ".semantic-peek", ".quick-open-panel", ".settings-panel", ".mc-dropdown",
    ".compare-menu-main", ".compare-menu-branches"]) {
    assert.ok(selector.includes(surface), `${surface} opens over the app — it uses the shared entrance: ${selector}`);
  }
  assert.match(css, /\.quick-open:not\(\.hidden\):not\(\.anchored\)\s*\{\s*animation:\s*dock-backdrop-in/,
    "the dim behind the launcher fades in rather than cutting over an already-blurred page");
});

test("panel focus is a brief shared flash instead of a persistent native outline", () => {
  assert.match(css, /\[data-mc-focus-panel\]:focus\s*\{[^}]*outline:\s*none/, "a stale DOM-focused scroller cannot keep a permanent blue rectangle");
  assert.match(css, /\.mc-panel-focus-flash\s*\{[^}]*animation:\s*mc-panel-focus-flash\s+520ms/, "every panel uses the same roughly half-second focus flash");
  assert.match(css, /@keyframes\s+mc-panel-focus-flash\s*\{[\s\S]{0,240}100%\s*\{[^}]*outline-color:\s*transparent/, "the focus effect fades completely away");
  assert.match(css, /\.history-list\.mc-panel-focus-flash\s*\{[^}]*outline:\s*0;[^}]*animation:\s*mc-history-list-focus-flash/, "history focus does not draw over the activity-rail boundary");
  assert.match(css, /@keyframes\s+mc-history-list-focus-flash\s*\{[\s\S]{0,520}inset\s+-2px\s+0[\s\S]{0,300}100%\s*\{[^}]*box-shadow:\s*inset\s+0\s+0\s+transparent/, "history keeps a three-sided focus cue that fades without a left edge");
  assert.doesNotMatch(css, /body\.native-app/, "no rule is scoped to the layout the app stopped using");
  assert.doesNotMatch(css, /--native-(titlebar-height|title-safe|traffic-safe)/,
    "and nothing reads the custom properties that layout defined");
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
  const deletionGap = ruleBodyContaining(".mc-asymmetric-delete-gap");
  assert.match(deletionGap || "", /display:\s*none/, "deleted base-only lines cannot leave gray blank rows in the working tree");
  assert.match(insertionResume || "", /color-mix\(in srgb, var\(--diff-added\) 78%, transparent\)/, "the collapsed base-side marker matches the translucent addition curve");
  assert.match(insertionTail || "", /color-mix\(in srgb, var\(--diff-added\) 78%, transparent\)/, "a trailing collapsed insertion matches the translucent addition curve");
  assert.doesNotMatch((insertionResume || "") + (insertionTail || ""), /var\(--active\)/, "insertion markers never fall back to unrelated blue focus color");
});

test("diff comment composers stay pinned inside the working-tree viewport", () => {
  const card = ruleBodyForExactSelector(".mc-layered-diff-side + .mc-layered-diff-side .mc-comment-row .mc-card");
  assert.match(card || "", /position:\s*sticky/, "diff comments are viewport UI, not horizontally scrolling source text");
  assert.match(card || "", /left:\s*62px/, "the comment begins ten pixels after the single visible working-tree gutter");
  assert.match(card || "", /max-width:\s*calc\(100cqw\s*-\s*74px\)/, "the composer and its actions cannot be clipped at the pane's right edge");
  const baseCard = ruleBodyForExactSelector(".mc-layered-diff-side:first-child .mc-comment-row .mc-card");
  assert.match(baseCard || "", /position:\s*sticky/, "base-pane comments are viewport UI too, not scrolling source text");
  assert.match(baseCard || "", /max-width:\s*calc\(100cqw\s*-\s*74px\)/, "the card stops short of the base pane's right-hand gutter instead of sliding under it");
  const spacerCell = ruleBodyForExactSelector(".mc-comment-spacer-row td");
  assert.match(spacerCell || "", /background:\s*transparent/, "the paired base timeline slot cannot paint its own colour over the canvas");
  assert.match(ruleBodyContaining(".mc-comment-row td") || "", /background:\s*transparent/, "nor can the comment row it is paired with");
  assert.match(css, /\.mc-comment-spacer\s*\{[^}]*pointer-events:\s*none/, "the invisible paired slot never steals review input");
});

test("no rule sets a property that a later rule with the same selector sets again", () => {
  const blanked = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const rules = [];
  const atRules = [];
  let head = "";
  for (let i = 0; i < blanked.length; i++) {
    const ch = blanked[i];
    if (ch === "{") {
      const selector = head.trim();
      head = "";
      if (selector.startsWith("@")) { atRules.push(selector); continue; }
      let depth = 1, j = i + 1;
      for (; j < blanked.length && depth > 0; j++) {
        if (blanked[j] === "{") depth++;
        else if (blanked[j] === "}") { depth--; if (!depth) break; }
      }
      const declarations = blanked.slice(i + 1, j).split(";")
        .filter((d) => d.includes(":") && !d.includes("{"))
        .map((d) => ({ prop: d.slice(0, d.indexOf(":")).trim().toLowerCase(), important: d.includes("!important") }))
        .filter((d) => d.prop);
      rules.push({
        selectors: selector.split(",").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean),
        declarations,
        scope: atRules.join(">"),
        line: blanked.slice(0, i).split("\n").length,
      });
      i = j;
      continue;
    }
    if (ch === "}") { atRules.pop(); head = ""; continue; }
    head += ch;
  }

  const byKey = new Map();
  rules.forEach((rule, index) => rule.selectors.forEach((s) => {
    const key = rule.scope + "|" + s;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ index, rule });
  }));

  const shadowed = [];
  rules.forEach((rule, index) => {
    for (const declaration of rule.declarations) {
      if (declaration.important) continue;
      const deadEverywhere = rule.selectors.every((s) => (byKey.get(rule.scope + "|" + s) || []).some(({ index: other, rule: later }) =>
        other > index && later.declarations.some((d) => d.prop === declaration.prop && !d.important)));
      if (deadEverywhere) shadowed.push(`${rule.selectors.join(", ")} — ${declaration.prop} (viewer.css:${rule.line})`);
    }
  });
  assert.deepEqual(shadowed, [], "these declarations never apply — set the property where it wins, not twice");
});

test("selecting a comment turn cannot move the thread it is in", () => {
  const selected = ruleBodyContaining(".mc-comment-row.mc-row-selected .mc-card.mc-card-selected");
  assert.ok(selected, "the selected turn still has a ring");
  assert.match(selected, /box-shadow:\s*inset/, "drawn inside the card, so it needs no room of its own");
  assert.doesNotMatch(selected, /margin|padding|border-width/, "and claims no layout: any of these shifts the cards below");
  assert.equal(ruleBodyForExactSelector(".mc-thread-cell .mc-card.mc-card-selected + .mc-card"), null,
    "…so the neighbour no longer has to give its own margin back");
});

test("the viewed checkbox keeps an outline on every row the eye is on", () => {
  for (const selector of [".change-row:hover .viewed-box", ".file-link.active .viewed-box",
    ".change-row.active .viewed-box", ".tree-focus .viewed-box"]) {
    const rule = ruleBodyContaining(selector);
    assert.match(rule || "", /border-color:\s*currentColor/, `${selector} borrows the row's own colour`);
  }
  const box = ruleBodyContaining(".viewed-box") || "";
  assert.doesNotMatch(box, /(^|[^-])color:\s*transparent/, "the box itself is never transparent-coloured");
  assert.match(box, /color:\s*inherit/, "it takes the row's ink, which is what currentColor then resolves to");
  assert.match(ruleBodyContaining(".viewed-box::after") || "", /color:\s*transparent/,
    "the unticked mark is what is invisible");
  assert.match(ruleBodyContaining(".file-link.viewed .viewed-box::after") || "", /color:\s*#fff/,
    "and a ticked box shows it again");
});

test("the Changes tree writes an added file's name in ink, not in a diff fill", () => {
  const added = ruleBodyContaining(".change-row.ch-added .change-name");
  assert.ok(added, "added rows still colour their name");
  assert.doesNotMatch(added, /--add(-strong)?\b/, "no diff-fill token is used as a text colour");
  assert.match(added, /color:\s*var\(--chrome-vcs-\w+\)/, "it uses one of the sidebar's own ink colours");
});

test("every custom property a rule reads is one this stylesheet declares", () => {
  const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const read = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/gi)].map((m) => m[1]);
  const setInMarkup = new Set([
    "--depth",
    "--kakapo-ui-icon",
    "--structure-depth",
    "--sidebar-width",
    "--hgraph-w",
    "--bookmark-mark",
  ]);
  const undeclared = [...new Set(read.filter((name) => !declared.has(name) && !setInMarkup.has(name)))];
  assert.deepEqual(undeclared, [], "a var() must name a token this file declares, or one the markup sets");
});

test("the reduced-motion breath outranks the blanket animation clamp it sits under", () => {
  const blanket = /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{([^}]*)\}/.exec(css);
  assert.ok(blanket, "precondition: a blanket reduced-motion rule still clamps every animation");
  assert.match(blanket[1], /animation-duration:\s*\.001ms\s*!important/,
    "precondition: the clamp is !important — which is why the substitution below needs to be too");

  const substitution = /\.analysis-status\.is-indexing \.analysis-status-dot,[^{]*\{([^}]*)\}/.exec(css);
  assert.ok(substitution, "the busy indicators still substitute an animation under reduced motion");
  assert.match(substitution[1], /animation:\s*kakapo-breathe[^;]*!important/,
    "the breath is declared !important, or the blanket clamp above freezes it and the dot lies about working");
});

test("the side-by-side diff shows one horizontal scrollbar, not one per pane", () => {
  assert.match(css, /\.d2h-file-side-diff:first-child::-webkit-scrollbar\s*\{[^}]*height:\s*0/s,
    "the base pane's horizontal thumb is suppressed — the working tree's bar drives both");

  const side = ruleBodyForExactSelector(".d2h-file-side-diff");
  assert.ok(side, "precondition: .d2h-file-side-diff rule must exist");
  assert.match(side, /overflow-x:\s*auto\b/,
    "precondition: the base pane is still a SCROLLER — hiding its thumb must not stop it scrolling");

  const nav = readFileSync(new URL("../src/viewer/02-diff-nav.js", import.meta.url), "utf8");
  assert.match(nav, /function syncDiffSideScroll\b/,
    "precondition: the two sides are mirrored — without that, one bar would only move one pane");
});

test("a one-sided change still renders both diff panes, so the kept scrollbar always exists", async () => {
  const { renderDiff2Html } = await import("../dist/highlight.js");
  const patch = (header, from, to, hunk, lines) =>
    ["diff --git a/f b/f", header, "index 0000000..e69de29", from, to, hunk, ...lines, ""].join("\n");

  const added = patch("new file mode 100644", "--- /dev/null", "+++ b/f", "@@ -0,0 +1,2 @@", ["+hello", "+world"]);
  const deleted = patch("deleted file mode 100644", "--- a/f", "+++ /dev/null", "@@ -1,2 +0,0 @@", ["-hello", "-world"]);

  for (const [what, diff] of [["an added file", added], ["a deleted file", deleted]]) {
    const panes = (renderDiff2Html(diff).match(/d2h-file-side-diff/g) || []).length;
    assert.equal(panes, 2, `${what} still renders two side panes — the second one carries the only bar`);
  }
});

test("the stacked narrow-window sidebar is bounded, so the diff still gets the window", () => {
  const narrow = cssRules.match(/@media\s*\(max-width:\s*900px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(narrow, "the max-width:900px block must exist — it is what stacks the two columns");
  const body = narrow[1];

  assert.match(body, /\.content\s*\{[^}]*grid-row:\s*3/, "precondition: the diff is the row BELOW the sidebar");
  assert.match(body, /body\s*\{[^}]*grid-template-rows:[^;]*minmax\(0,\s*1fr\)/,
    "precondition: the diff's row is the one that takes what is left — so what is left has to be something");

  const sidebar = body.match(/\.sidebar\s*\{([^}]*)\}/);
  assert.ok(sidebar, ".sidebar must be restyled for the stacked layout");
  const bound = sidebar[1].match(/max-height:\s*[\d.]+(vh|px|%)/);
  const fixed = sidebar[1].match(/(?<!max-)height:\s*[\d.]+(vh|px|%)/);
  assert.ok(bound || fixed,
    "it must state a bound; an unbounded sidebar here is the file list's full height, which is the whole window on a long review");
  assert.ok(bound,
    "the bound belongs on max-height: a plain `height` also reserves that much for a one-file review");
  assert.match(sidebar[1], /height:\s*auto/,
    "…and the height itself is the tree's, so one row of tree is one row tall");
});

test("the sticky-lines overlay can inherit the gutter width: it is declared on the viewer, not the body", () => {
  assert.ok(ruleDeclaring(".source-viewer", "--source-gutter-width:"),
    "the base value belongs on the common ancestor of the body and the overlay");
  assert.equal(ruleDeclaring(".source-body", "--source-gutter-width:"), null,
    "declaring it on the body again would shadow nothing for the body and still miss the overlay");
  assert.match(cssRules, /\.source-viewer:has\(>\s*\.source-body\.source-blame-visible\)/,
    "the blame override is keyed off the viewer so the sticky header tracks it");
});

test("the history graph can never squeeze the commit out of its own row", () => {
  const hrow = ruleDeclaring(".hrow", "grid-template-columns");
  assert.ok(hrow, ".hrow must lay its columns out");
  assert.match(hrow, /grid-template-columns:\s*minmax\(0,\s*var\(--hgraph-w/,
    "the graph track must be able to shrink when the row cannot hold both");
  assert.match(ruleDeclaring(".hgraph-cell", "overflow"), /overflow:\s*hidden/,
    "and must clip rather than overflow once it has shrunk");
});

test("the Problems row has a template for the three things it paints", () => {
  const row = ruleDeclaring(".quick-open-item.problem-result", "grid-template-columns");
  assert.ok(row, "the Problems template is declared on a selector that outranks .quick-open-item");
  assert.match(row, /grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/,
    "mark | message | badge, with only the message taking the slack");
  for (const body of ruleBodiesForExactSelector(".problem-result")) {
    assert.doesNotMatch(body, /grid-template-columns/,
      "a bare .problem-result cannot win against the later .quick-open-item rule");
  }

  const insight = readFileSync(new URL("../src/viewer/18-code-insight.js", import.meta.url), "utf8");
  const template = /class="quick-open-item problem-result[\s\S]*?<\/button>/.exec(insight);
  assert.ok(template, "the Problems row is still built here");
  const children = (template[0].match(/\+ '<span class="(problem-mark|quick-open-main|quick-open-badge)"/g) || []).length;
  assert.equal(children, 3, "three top-level children, which is what the template above declares");
});

test("the extension chain keeps its width and the base name is what shrinks", () => {
  const tail = ruleDeclaring(".tree .path-tail", "max-width");
  assert.ok(tail, "the tail still caps its width");
  assert.match(tail, /max-width:\s*max\(\s*\d+ch\s*,\s*\d+%\s*\)/,
    "at least a dozen characters for the type, and half the row when half the row is more");
  const head = ruleDeclaring(".tree .path-head", "text-overflow");
  assert.match(head || "", /min-width:\s*0/, "and the base name is the one allowed to shrink to nothing");
  assert.match(head || "", /text-overflow:\s*ellipsis/, "with an ellipsis where it was cut");
});

test("the crumb trail gives way in the right order: the figure last, the directories first", () => {
  const crumb = ruleDeclaring(".crumb", "flex-shrink");
  assert.ok(crumb, "a plain crumb has a shrink budget");
  assert.match(crumb, /min-width:\s*0/, "and may shrink below its content");
  assert.match(crumb, /text-overflow:\s*ellipsis/, "saying so with an ellipsis");
  const leaf = ruleDeclaring(".crumb-leaf", "flex-shrink");
  assert.ok(leaf, "the file name has its own, smaller budget");
  const shrinkOf = (body) => Number((body.match(/flex-shrink:\s*(\d+)/) || [])[1]);
  assert.ok(shrinkOf(crumb) > shrinkOf(leaf),
    `directories give way before the file name (${shrinkOf(crumb)} > ${shrinkOf(leaf)})`);
  const stat = ruleDeclaring(".crumb-stat", "flex");
  assert.match(stat || "", /flex:\s*none/, "and the change counts never give way at all");
  const sep = ruleDeclaring(".crumb-sep", "flex-shrink");
  assert.ok(sep && shrinkOf(sep) === shrinkOf(crumb),
    "a separator goes with the crumb it separates, or the trail opens with a chevron pointing at nothing");
});

test("every chrome control a pointer aims at clears the 24px target floor", () => {
  const reveal = ruleDeclaring(".brand-reveal", "min-height");
  assert.match(reveal || "", /min-width:\s*24px/, "the reveal/settings buttons are 24px wide");
  assert.match(reveal || "", /min-height:\s*24px/, "and 24px tall");
  const pill = ruleDeclaring(".compare-pill", "min-height");
  assert.match(pill || "", /min-height:\s*24px/, "the compare pill is a button, and is 24px tall");
  const tools = ruleDeclaring(".sidebar-tools", "padding");
  assert.match(tools || "", /padding:\s*3px\s/, "the bar's padding leaves room for 24px buttons inside 30px");
  assert.match(tools || "", /min-height:\s*30px/, "and the bar is still the height it was");
});

test("the source caret is painted out of the flow, so a caret move cannot relayout the table", () => {
  const caret = ruleBodiesForExactSelector("#source-body .code-cursor");
  assert.ok(caret.length, "#source-body .code-cursor rule must exist");
  assert.ok(caret.some((body) => /position:\s*absolute\b/.test(body)), "the caret must be absolutely positioned");
  assert.ok(
    !caret.some((body) => /(^|;)\s*(left|top|right|bottom)\s*:/.test(body)),
    "and must keep its offsets auto — an offset would move it off the character it marks",
  );

  const cell = ruleBodiesForExactSelector(".source-code");
  assert.ok(cell.some((body) => /position:\s*relative\b/.test(body)),
    "precondition: .source-code is the positioning context (it already is, for the empty-line caret)");

  assert.ok(!/(^|,)\s*\.code-cursor\s*\{[^}]*position:\s*absolute/s.test(cssRules),
    "the rule must stay scoped to #source-body — the diff caret has no positioning context of its own");
});

function resolvePx(expr, vars) {
  let e = String(expr).trim();
  for (let i = 0; i < 8 && /var\(/.test(e); i += 1) {
    e = e.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,[^()]*)?\)/gi, (_, name) => {
      assert.ok(name in vars, "the ladder may only be built from values this guard knows: " + name);
      return "(" + vars[name] + ")";
    });
  }
  e = e.replace(/calc\(/g, "(").replace(/px/g, "");
  assert.match(e, /^[-+*/(). \d]+$/, "the ladder must stay plain arithmetic, not " + e);
  return Function("return " + e)();
}

function declarationIn(body, property) {
  const m = String(body || "").match(new RegExp("(?:^|;)\\s*" + property + "\\s*:\\s*([^;]+)"));
  return m ? m[1].trim() : null;
}

test("a folder and a file at the same depth begin on the same line", () => {
  const tree = ruleDeclaring(".tree", "--tree-pad");
  assert.ok(tree, ".tree must declare the ladder");
  const vars = {
    "--tree-pad": declarationIn(tree, "--tree-pad"),
    "--tree-indent": declarationIn(tree, "--tree-indent"),
  };
  assert.ok(vars["--tree-pad"] && vars["--tree-indent"], "both halves of the ladder are declared on .tree");

  const dirBase = declarationIn(ruleDeclaring(".tree-dir > summary", "--tree-base"), "--tree-base");
  const fileBase = declarationIn(ruleDeclaring(".tree .file-link", "--tree-base"), "--tree-base");
  assert.ok(dirBase && fileBase, "each row kind names its own base in padding-box terms");

  const fileBorder = declarationIn(ruleDeclaring(".file-link", "border:"), "border");
  assert.ok(fileBorder, ".file-link's border is what the two bases have to differ by");
  const borderPx = Number(String(fileBorder).match(/([\d.]+)px/)[1]);

  assert.equal(
    resolvePx(dirBase, vars) - resolvePx(fileBase, vars), borderPx,
    "the file row's base must be the folder's less its own border, or the two ladders drift apart",
  );

  for (const depth of [0, 1, 2, 5]) {
    const at = (base, border) => border + resolvePx(base, { ...vars, "--depth": String(depth) }) + depth * resolvePx(vars["--tree-indent"], vars);
    assert.equal(at(dirBase, 0), at(fileBase, borderPx), `depth ${depth}: both row kinds start at the same x`);
  }
});

test("the tree's indent guide rides the same ladder the rows do", () => {
  const guide = ruleDeclaring(".tree-dir::before", "left");
  assert.ok(guide, "the guide hangs on .tree-dir, the one box both trees have");
  const left = declarationIn(guide, "left");
  assert.match(left, /var\(\s*--tree-pad\s*\)/, "it starts from the rows' own base");
  assert.match(left, /var\(\s*--depth[^)]*\)\s*\*\s*var\(\s*--tree-indent\s*\)/, "and steps by the rows' own step");

  assert.match(declarationIn(guide, "top") || "", /var\(\s*--tree-row\s*\)/, "the guide starts one declared row down");
  const rows = [".tree-dir summary", ".file-link"].map((sel) => declarationIn(ruleDeclaring(sel, "min-height"), "min-height"));
  rows.forEach((value, i) => assert.match(value || "", /var\(\s*--tree-row\b/,
    `row kind ${i} is laid out at the same declared height the guide starts below`));

  assert.match(declarationIn(guide, "background") || "", /var\(\s*--indent-guide\s*\)/,
    "the tree guide and the code guide are the same ink");
});

test("every pair of tree rows is one declared step apart", () => {
  const rowSelectors = /(^|[,}])\s*[^{}]*(\.tree-dir\s*(>\s*)?summary|\.file-link|\.change-row|\.source-link)[^{}]*\{([^}]*)\}/g;
  const withMargin = Array.from(cssRules.matchAll(rowSelectors))
    .filter((m) => /(^|;)\s*margin(-block|-top|-bottom)?\s*:\s*(?!0)/.test(m[4]))
    .map((m) => m[0].slice(0, 90).replace(/\s+/g, " "));
  assert.deepEqual(withMargin, [], "no tree row may carry vertical margin of its own:\n  " + withMargin.join("\n  "));
  assert.match(ruleDeclaring(".tree-dir", "gap") || "", /gap:\s*var\(\s*--tree-row-gap\s*\)/,
    "the folder's own grid uses the declared step");
  assert.match(cssRules, /\.tree-dir:not\(\[open\]\)\s*\{[^}]*gap:\s*0/,
    "and a closed folder reserves none: its content row is the UA slot, which exists whether or not it is open");
});

function finalDeclaration(selector, property) {
  let value = null;
  ruleBodiesForExactSelector(selector).forEach((body) => {
    const direct = declarationIn(body, property);
    if (direct !== null) value = direct;
  });
  return value;
}

function edgeFromShorthand(shorthand, edge) {
  const parts = String(shorthand).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return edge === "top" || edge === "bottom" ? parts[0] : parts[1];
  if (parts.length === 3) return edge === "top" ? parts[0] : edge === "bottom" ? parts[2] : parts[1];
  return edge === "top" ? parts[0] : edge === "right" ? parts[1] : edge === "bottom" ? parts[2] : parts[3];
}

test("a chrome band leaves an even content box for the controls centred in it", () => {
  const band = Number(String(declarationIn(ruleDeclaring(":root", "--header-band"), "--header-band")).match(/([\d.]+)px/)[1]);
  assert.ok(band > 0, "--header-band is declared in px");

  [[".sidebar-brand"], [".source-toolbar", ".toolbar"]].forEach(([selector, base]) => {
    const padding = finalDeclaration(selector, "padding");
    const padTop = Number(String(edgeFromShorthand(padding, "top")).match(/([\d.]+)/)[1]);
    const padBottomDecl = finalDeclaration(selector, "padding-bottom");
    const padBottom = padBottomDecl !== null
      ? Number(String(padBottomDecl).match(/([\d.]+)/)[1])
      : Number(String(edgeFromShorthand(padding, "bottom")).match(/([\d.]+)/)[1]);
    const rule = finalDeclaration(selector, "border-bottom") || (base ? finalDeclaration(base, "border-bottom") : null);
    assert.ok(rule, `${selector}: the 1px rule under the band has to be found, or this arithmetic is fiction`);
    const border = Number(String(rule).match(/([\d.]+)px/)[1]);
    const inner = band - padTop - padBottom - border;
    assert.equal(inner % 2, 0,
      `${selector}: ${band} less ${padTop}+${padBottom} padding and its ${border}px rule leaves ${inner}, which centres an even control on a half pixel`);
  });
});

test("the toolbar's icon button is the height of the text button beside it", () => {
  const icon = finalDeclaration(".diff-tool-button", "height");
  assert.match(icon || "", /26px/, "the icon button is 26px tall");
  assert.match(finalDeclaration(".diff-tool-button", "width") || "", /26px/, "and square");
  const border = finalDeclaration(".diff-tool-button", "border");
  const bw = Number(String(border).match(/([\d.]+)px/)[1]);
  assert.equal((26 - 2 * bw - 14) % 2, 0, "and its glyph is centred on a whole pixel");
});

test("the tree's two glyphs are one size, and the sidebar has one left inset", () => {
  const file = declarationIn(ruleDeclaring(".file-link .ftype", "width"), "width");
  const folder = declarationIn(ruleDeclaring(".folder-icon .folder-ic", "width"), "width");
  assert.equal(file, folder, "a file glyph and a folder glyph in the same column are the same size");
  assert.equal(Number(String(file).match(/([\d.]+)/)[1]) % 2, 0, "and an even one, so it centres whole in an even row");

  const insets = [".sidebar-brand", ".sidebar-scroll", ".sidebar-tools"].map((selector) => {
    const padding = finalDeclaration(selector, "padding");
    return edgeFromShorthand(padding, "left");
  });
  assert.deepEqual(new Set(insets).size, 1,
    "every band down the sidebar starts at the same x: " + insets.join(" / "));
});
