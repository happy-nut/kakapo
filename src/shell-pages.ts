// Browser-facing HTML for the main-process "chrome" windows: the workspace-rail shell page (hubHtml) and the
// tile context-menu popup (tileMenuHtml). Extracted from app-main.ts to keep that file focused on main-process
// orchestration. Pure string builders with no Electron imports, so they render/diff in isolation.
import { HUB_WIDTH, HUB_EXPANDED, TITLEBAR_H } from "./constants.js";

// Translator handed in by the main process (makeTranslator(locale)); shell pages stay pure string builders
// with no Electron/i18n imports of their own, so the caller owns which locale renders.
type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function tileMenuHtml(resume: boolean, canDelete: boolean, light: boolean, t: Translate): string {
  const bg = light ? "#ffffff" : "#242529", line = light ? "#e3e3e6" : "#3a3d44", fg = light ? "#242424" : "#e6e8ec";
  const hl = "#4d86d9", danger = light ? "#cf3b38" : "#e5615e", dangerHl = "#d63d3d";
  const item = (action: string, label: string, cls = ""): string => `<div class="mi ${cls}" data-action="${action}">${label}</div>`;
  return `<!doctype html><meta charset="utf-8"><style>
:root{color-scheme:${light ? "light" : "dark"}}
*{box-sizing:border-box;margin:0}
html,body{background:transparent;overflow:hidden}
body{padding:14px;-webkit-user-select:none;user-select:none;cursor:default;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.menu{background:${bg};border:1px solid ${line};border-radius:11px;padding:5px;min-width:216px;box-shadow:0 14px 40px #0007,0 3px 12px #0005}
.mi{display:flex;align-items:center;height:31px;padding:0 12px;border-radius:7px;color:${fg};white-space:nowrap;font-size:13px}
.mi.hl{background:${hl};color:#fff}
.mi.danger{color:${danger}}
.mi.danger.hl{background:${dangerHl};color:#fff}
.sep{height:1px;background:${line};margin:5px 9px}
</style>
<div class="menu">
${item("activate", t("tile.switch"), "hl")}
${resume ? item("resume", t("tile.resume")) : ""}
<div class="sep"></div>
${item("rename", t("tile.rename"))}
${item("memo", t("tile.editMemo"))}
${item("detach", t("tile.openNewWindow"))}
<div class="sep"></div>
${item("close", t("tile.close"))}
${canDelete ? item("delete", t("tile.delete"), "danger") : ""}
</div>
<script>
const {ipcRenderer}=require('electron');
const items=[...document.querySelectorAll('.mi')];
let hl=0;
function paint(){items.forEach((el,i)=>el.classList.toggle('hl',i===hl));}
function move(d){if(items.length){hl=(hl+d+items.length)%items.length;paint();}}
paint();
items.forEach((el,i)=>{el.addEventListener('mouseenter',()=>{hl=i;paint();});el.addEventListener('click',()=>ipcRenderer.send('kakapo:menu-choose',el.dataset.action));});
document.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'){e.preventDefault();move(1);}
  else if(e.key==='ArrowUp'){e.preventDefault();move(-1);}
  else if(e.key==='Enter'){e.preventDefault();const el=items[hl];if(el)ipcRenderer.send('kakapo:menu-choose',el.dataset.action);}
  else if(e.key==='Escape'){e.preventDefault();ipcRenderer.send('kakapo:menu-close');}
});
document.addEventListener('mousedown',e=>{if(!e.target.closest('.menu'))ipcRenderer.send('kakapo:menu-close');});
function report(){const m=document.querySelector('.menu').getBoundingClientRect();ipcRenderer.send('kakapo:menu-size',{w:Math.ceil(m.width)+28,h:Math.ceil(m.height)+28});}
report();requestAnimationFrame(report);
</script>`;
}

export function hubHtml(light: boolean, appVersion: string, t: Translate): string {
  const bg = light ? "#f4f4f4" : "#252526", fg = light ? "#242424" : "#ddd", line = light ? "#d0d0d0" : "#454545";
  // Strings the hub's client script builds at runtime from live workspace data (status tips, the delete-confirm
  // flow, the "Workspaces" heading). Injected as one JSON object so they localize without a data-i18n pass.
  const T = {
    uSession: t("usage.session"), uWeekly: t("usage.weekly"), uLeft: t("usage.left"),
    uResets: t("usage.resets"), uAsOf: t("usage.asOf"), uTokensToday: t("usage.tokensToday"),
    uNow: t("usage.now"), uD: t("usage.unit.d"), uH: t("usage.unit.h"), uM: t("usage.unit.m"),
    workspaces: t("hub.workspaces"), mainWorktree: t("hub.mainWorktree"),
    running: t("hub.status.running"), resumable: t("hub.status.resumable"), disconnected: t("hub.status.disconnected"),
    changed: t("hub.tip.changed"),
    ahead: t("hub.tip.ahead"),
    agoNow: t("hub.ago.now"), agoM: t("hub.ago.m"), agoH: t("hub.ago.h"), agoD: t("hub.ago.d"),
    delTitle: t("hubdel.title"), delTitleNamed: t("hubdel.titleNamed"), delMessage: t("hubdel.message"),
    delCheckbox: t("hubdel.checkbox"), cancel: t("hubdel.cancel"), del: t("hubdel.delete"),
    anywayTitle: t("hubdel.anywayTitle"), hasWork: t("hubdel.hasWork"), dirty: t("hubdel.dirty"),
    unpushed: t("hubdel.unpushed"), runningProc: t("hubdel.runningProc"), anyway: t("hubdel.anyway"),
    failedTitle: t("hubdel.failedTitle"), failedMsg: t("hubdel.failedMsg"), ok: t("dialog.ok"),
  };
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:${bg};color:${fg};font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{display:flex;flex-direction:column}
#titlebar{position:relative;height:${TITLEBAR_H}px;flex:none;-webkit-app-region:drag;display:flex;align-items:center;gap:8px;padding:0 12px 0 84px;border-bottom:1px solid ${line};background:${light ? "#ececec" : "#1b1e25"}}
#wsname{-webkit-app-region:no-drag;display:flex;align-items:center;gap:7px;max-width:72%;font-weight:600;color:${fg};font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#wsname .wsdot{width:6px;height:6px;border-radius:50%;background:#4d9a51;flex:none}#wsname .rp{color:${light ? "#888" : "#7d828c"};font-weight:400}
/* The name you gave this workspace is the window's title, so it sits where a document window's title does —
   centred on the WINDOW, not on what is left over between the project name and the tools. Absolute, so
   neither side can push it off centre; the left cluster keeps identity (project · branch). */
#wstitle{position:absolute;left:50%;transform:translateX(-50%);max-width:38%;font-weight:600;color:${fg};font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.tb-spacer{flex:1;align-self:stretch}
/* A new version is worth exactly one always-visible word. It lives in the title bar rather than in the
   review's sidebar footer, which is where it used to be — behind a collapsible panel, in a window the user
   may not have open. Clicking it goes where the update actually happens: Settings. */
#update-chip{-webkit-app-region:no-drag;border:1px solid ${light ? "#b5d0f5" : "#3c5a86"};border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:600;color:#4d86d9;background:transparent;cursor:pointer;white-space:nowrap}
#update-chip:hover{background:${light ? "#e8f0fd" : "#22303f"}}
#tools{-webkit-app-region:no-drag;display:flex;align-items:center;gap:2px;flex:none}
#tools .tb-sep{width:1px;height:16px;background:${line};margin:0 5px}
#tools button.tb{width:28px;height:26px;border:0;border-radius:6px;color:${light ? "#5f6470" : "#9aa0ab"};display:grid;place-items:center;padding:0;background:transparent}
#tools button.tb:hover{background:${light ? "#dfe7f5" : "#373d49"};color:${fg}}
#tools button.tb.active{color:#4d86d9;background:${light ? "#dfe7f5" : "#2a3446"}}
#tools button.tb.hidden{display:none!important}
#tools button.tb svg{width:17px;height:17px}
/* Custom hover tooltip for the top toolbar buttons — a styled bubble with the keyboard shortcut in a <kbd>,
   matching the rest of the app (the review view's mc-button-hint). Replaces the plain native title tooltip,
   which shows inconsistently in this child view and doesn't read as a shortcut hint. */
#tt{position:fixed;z-index:100;display:none;align-items:center;gap:8px;padding:4px 7px 4px 9px;background:${light ? "#ffffff" : "#2c2d31"};color:${fg};border:1px solid ${line};border-radius:7px;box-shadow:0 8px 24px #0006;font-size:11.5px;font-weight:500;white-space:nowrap;pointer-events:none}
#tt kbd{font:10.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:${light ? "#eceff3" : "#3a4048"};color:${light ? "#55606e" : "#c2c7d0"};border-radius:4px;padding:1px 5px}
#tt.show{display:flex}
#hub{width:${HUB_WIDTH}px;flex:1;min-height:0;border-right:1px solid ${line};display:flex;flex-direction:column;align-items:center;gap:2px;overflow:hidden;transition:width 180ms cubic-bezier(.2,.8,.2,1)}
body.rail-exp #hub{width:${HUB_EXPANDED}px;align-items:stretch}
button{border:1px solid ${line};background:transparent;color:inherit;border-radius:6px;padding:4px 8px}
#list{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;width:100%}
.wt{position:relative;cursor:pointer;border:0;background:transparent;padding:0;font:inherit;color:inherit;text-align:left}
/* ---------- collapsed rail: one rounded block per project — a prominent avatar header (identity, shown once)
   over small 24px worktree initial badges, so the grouping reads and the avatar isn't repeated per worktree. --- */
.cv{flex:1;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;align-items:center;gap:12px;padding:10px 0;width:100%}
body.rail-exp .cv{display:none}
.grp{display:flex;flex-direction:column;align-items:center;gap:6px;width:40px;padding:6px 2px 8px;background:${light ? "#eaecef" : "#212327"};border-radius:12px}
.phav{position:relative;width:28px;height:28px;border-radius:8px;overflow:hidden;flex:none;cursor:pointer;display:grid;place-items:center;font-weight:700;font-size:12px;color:#0e1116}
.phav img{width:100%;height:100%;object-fit:cover;display:block}
.wts{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:2px}
.cv .wt{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;font-weight:700;font-size:10.5px;color:${light ? "#3a3f47" : "#c9cdd4"};background:${light ? "#d7dbe1" : "#2c2f35"}}
.cv .wt.act{color:#dfe8fb;background:${light ? "#c5d4ee" : "#33456a"};box-shadow:0 0 0 2px #4d86d9}
.cv .wt.disc{opacity:.45}
.cv .wt .rdot{position:absolute;top:-2px;right:-2px;width:8px;height:8px;border-radius:50%;background:#4cc38a;border:2px solid ${light ? "#eaecef" : "#212327"};display:none}
.cv .wt.running:not(.busy) .rdot{display:block}
.cv .wt .udot{position:absolute;top:-2px;left:-2px;width:8px;height:8px;border-radius:50%;background:#e5484d;border:2px solid ${light ? "#eaecef" : "#212327"};display:none}
.cv .wt.attn .udot{display:block}
/* The project's main checkout (kind:main) wears a small home badge so the root worktree reads apart from
   its task worktrees at a glance. Rendered only for main, so no state class gates it. Bottom-right corner
   keeps it clear of the running (top-right) and attention (top-left) status dots. */
.cv .wt .mdot{position:absolute;bottom:-3px;right:-3px;width:12px;height:12px;border-radius:50%;background:${light ? "#c9862a" : "#d99a3a"};border:2px solid ${light ? "#eaecef" : "#212327"};display:grid;place-items:center;color:#fff}
.cv .wt .mdot svg{width:7px;height:7px;display:block}
.wt-home{width:13px;height:13px;flex:none;color:${light ? "#c9862a" : "#d99a3a"};display:grid;place-items:center}
.wt-home svg{width:13px;height:13px;display:block}
/* Agent working: a breathing ring around the badge — scales + fades in place rather than rotating, so several
   working worktrees don't make the rail spin. pointer-events:none keeps the badge clickable through it. */
.cv .wt.busy::after{content:"";position:absolute;inset:-2px;border-radius:9px;border:2px solid #4d86d9;animation:wsbreathe 1.3s ease-in-out infinite;pointer-events:none}
@keyframes wsbreathe{0%,100%{opacity:.25;transform:scale(.94)}50%{opacity:.9;transform:scale(1.09)}}
@media (prefers-reduced-motion:reduce){.cv .wt.busy::after{animation:none;opacity:.7}}
/* Being deleted (markDeleting): dimmed, inert, and SAYING so. \`git worktree remove\` is not instant, and a
   tile that stays fully lit and clickable until it abruptly disappears reads as "the click did nothing" —
   then as "something vanished". Declared after .busy so a worktree whose agent was mid-run gets the danger
   ring rather than the working one. Same breathing keyframes, so this is one visual language, not two. */
.wt.deleting{opacity:.42;pointer-events:none}
.ev .wt.deleting .wt-name::after{content:" · ${t("hubdel.deleting")}";font-weight:400;font-size:11px}
.cv .wt.deleting::after{content:"";position:absolute;inset:-2px;border-radius:9px;border:2px solid #e5484d;animation:wsbreathe 1.3s ease-in-out infinite;pointer-events:none}
@media (prefers-reduced-motion:reduce){.cv .wt.deleting::after{animation:none;opacity:.8}}
/* ---------- expanded rail (⌘⇧E): Orca-style card panel — project header (avatar + name + count + chevron,
   click collapses the group) then a worktree card each (status dot + name + change tag + branch). ---------- */
/* Fixed width (not 100%) so the expanded content is laid out at full width from frame one and the #hub width
   animation just REVEALS it (overflow:hidden clips) instead of reflowing "Workspaces"/rows every frame. */
.ev{display:none;flex:1;min-height:0;flex-direction:column;width:${HUB_EXPANDED}px}
body.rail-exp .ev{display:flex}
.plist{flex:1;overflow-y:auto;overflow-x:hidden;padding:6px 6px 8px}
.proj{margin-top:5px}
.proj:first-child{margin-top:0}
.prow{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:8px;cursor:pointer}
.prow:hover{background:${light ? "#e4eaf6" : "#25272c"}}
.pav{width:28px;height:28px;border-radius:8px;flex:none;display:grid;place-items:center;font-weight:700;font-size:12px;color:#0e1116;overflow:hidden}
.pav img{width:100%;height:100%;object-fit:cover;display:block}
.pname{font-weight:650;font-size:12.5px;color:${fg};flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pcount{font-size:11px;color:${light ? "#9aa0aa" : "#666b73"};font-variant-numeric:tabular-nums}
.chev{width:14px;height:14px;color:${light ? "#9aa0aa" : "#666b73"};transition:transform .15s;flex:none}
.proj.collapsed .chev{transform:rotate(-90deg)}
.proj.collapsed .ewts{display:none}
.ewts{padding:2px 0 2px 9px;display:flex;flex-direction:column;gap:2px}
.ev .wt{padding:7px 9px 7px 11px;border-radius:9px}
.ev .wt:hover{background:${light ? "#e4eaf6" : "#25272c"}}
.ev .wt.kbd-sel{background:${light ? "#dbe6f8" : "#2c333f"};box-shadow:inset 0 0 0 1.5px ${light ? "#4d86d9" : "#5f92df"}}
.ev .wt.act{background:${light ? "#dfe7f5" : "#2a3446"}}
.ev .wt.disc{opacity:.5}
.wt-top{display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:${light ? "#b7bcc4" : "#5b616b"}}
.ev .wt.running .dot{background:#4cc38a;box-shadow:0 0 0 3px #4cc38a22}
/* Working right now: the dot becomes a spinner in place. A pulsing dot said "alive", which is what the steady
   green already says — it never read as WORK being done. A ring that turns does, and it costs the same 8px
   slot: border-box keeps the disc's footprint, so nothing beside it moves when a turn starts or ends. */
.ev .wt.busy .dot{
  background:transparent;box-sizing:border-box;
  border:1.5px solid #4cc38a44;border-top-color:#4cc38a;box-shadow:none;
  animation:wtspin .8s linear infinite;
}
@keyframes wtspin{to{transform:rotate(360deg)}}
/* Something is waiting for you there — an agent finished a turn, or answered a review comment — so the dot
   goes red, the same #e5484d the collapsed strip's .udot uses. Last, and deliberately: green means "running,
   nothing to do", and a workspace that has both is the one you should be looking at. Reading it as merely
   alive was the whole problem. Cleared when you open that workspace (activateWorkspace). */
.ev .wt.attn .dot{background:#e5484d;box-shadow:0 0 0 3px #e5484d33;border:0;animation:none}
/* Reduced motion: keep the ring (it still reads as "in progress" beside a solid disc), just stop it turning. */
@media (prefers-reduced-motion:reduce){.ev .wt.busy .dot{animation:none}}
.wt-name{font-weight:600;font-size:12.5px;color:${fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.ev .wt.act .wt-name{color:#79a6ea}
/* Agent badge on an expanded tile. Sized to sit with .wt-home rather than with the 14px usage-footer icons
   it borrows its markup from, and it keeps its brand colour (.usage-ico-claude/-codex) at every tile state. */
.wt-agent{flex:none;display:grid;place-items:center;opacity:.9}
.wt-agent .usage-ico{width:12px;height:12px}
.wt-ahead{color:${light ? "#2f7d32" : "#98cb80"};border-color:${light ? "#bcd9bd" : "#3d6045"}}
.wt-tag{font-size:9.5px;font-weight:700;color:${light ? "#9aa0aa" : "#8b909a"};border:1px solid ${line};border-radius:5px;padding:1px 5px;flex:none;font-variant-numeric:tabular-nums}
.wt-branch{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:${light ? "#9aa0aa" : "#666b73"};margin:3px 0 0 16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* Agent quota (Claude + Codex), moved here from the review's sidebar footer: it is per-account, not
   per-workspace, so the rail is the one place that is always on screen and never duplicated per window.
   Collapsed the rail is 46px, so only the battery survives; the expanded rail shows the full row. */
.usage-foot{display:flex;flex-direction:column;align-items:stretch;gap:10px;width:100%;padding:8px 10px;border-top:1px solid ${line};flex:none}
.usage-foot:empty{display:none}
.usage-ico{width:14px;height:14px;flex:none;display:block}
.usage-ico-claude{color:#d97757}.usage-ico-codex{color:#10a37f}
/* Expanded: one block per provider — a header naming it and summarizing its tightest window, then a row per
   window whose meter is the row's own background, so the bar never competes with the number for a column. */
.usage-head{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11.5px;color:${fg}}
.usage-head-name{font-weight:600}
.usage-head-sum{margin-left:auto;font-size:10.5px;font-variant-numeric:tabular-nums;color:${light ? "#6b7280" : "#8a8f99"}}
.usage-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;
  padding:3px 6px;border-radius:4px;overflow:hidden;font-size:11px;cursor:default;
  background:${light ? "#f0f0f2" : "#2b2d33"};color:${light ? "#6b7280" : "#8a8f99"}}
.usage-row+.usage-row{margin-top:3px}
.usage-fill{position:absolute;left:0;top:0;bottom:0;opacity:${light ? ".26" : ".16"};border-right:1.5px solid currentColor;transition:width .4s ease,background .4s ease}
.usage-label,.usage-pct,.usage-reset{position:relative}
.usage-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.usage-pct{font-weight:650;color:${fg};font-variant-numeric:tabular-nums}
.usage-pct-tokens{font-weight:600;color:${light ? "#6b7280" : "#8a8f99"}}
.usage-reset{min-width:40px;text-align:right;font-size:10px;font-variant-numeric:tabular-nums;color:${light ? "#9aa0aa" : "#6c717a"}}
/* Collapsed (46px): one ring per provider — its tightest window — with the mark inside and the number under
   it. The old stack of bare batteries fitted, but said nothing about WHICH agent or window was running out. */
.usage-cell{display:flex;flex-direction:column;align-items:center;gap:2px;cursor:default}
/* Fixed 26x26 (the ring SVG's own size) so the wrap still reserves its footprint when there is no ring to
   size it — the token-count fallback (no percentage window, so uGroup skips the ring) leaves only the
   absolutely-positioned icon in flow, which doesn't establish a size and let the icon collapse onto the
   number below it. */
.usage-ring-wrap{position:relative;display:grid;place-items:center;width:26px;height:26px;flex:none}
.usage-ring-ico{position:absolute;display:flex}
.usage-ring-ico .usage-ico{width:11px;height:11px}
.usage-ring-track{fill:none;stroke:${line};stroke-width:2.4}
.usage-ring-fill{fill:none;stroke-width:2.4;stroke-linecap:round;transition:stroke-dasharray .4s ease,stroke .4s ease}
.usage-cell-num{font-size:9.5px;font-variant-numeric:tabular-nums;color:${light ? "#6b7280" : "#8a8f99"}}
body:not(.rail-exp) .usage-foot{align-items:center;gap:10px;padding:9px 4px}
/* The rail opens and closes from its TOP: the control belongs next to what it names, and expanded it sits
   on the same line as the Workspaces title rather than at the far end of the list. "New workspace" joins it
   there — it makes a workspace, so it belongs with the workspaces, not parked next to Settings at the far
   bottom of the rail. Collapsed the head is a column (46px fits one 34px button per row). */
#railhead{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;width:100%;padding:6px 4px;border-bottom:1px solid ${line};flex:none}
body.rail-exp #railhead{flex-direction:row;gap:8px;justify-content:space-between;padding:6px 6px 6px 12px}
#railtitle{display:none;font-size:12px;font-weight:600;color:${fg}}
body.rail-exp #railtitle{display:block;flex:1}
#railfoot{display:flex;flex-direction:column;align-items:center;gap:5px;padding:7px 0;border-top:1px solid ${line};width:100%;flex:none}
body.rail-exp #railfoot{flex-direction:row;justify-content:flex-end;padding:7px 6px;gap:4px}
#railfoot button,#railhead button{width:34px;height:32px;border:0;border-radius:8px;font-size:17px;color:${light ? "#666" : "#999"};display:grid;place-items:center;padding:0}
#railfoot button:hover,#railhead button:hover{background:${light ? "#dfe7f5" : "#373d49"};color:${fg}}
/* Only the chevrons turn around; the button keeps the same colour open or shut, because the direction it
   points is already the whole message and a second, colour-coded one just reads as a stray highlight. */
#pin svg{width:16px;height:16px;transition:transform 180ms cubic-bezier(.2,.8,.2,1)}
body.rail-exp #pin svg{transform:rotate(180deg)}
#railhead #new{border:1px dashed ${line}}
.context-menu{position:fixed;z-index:20;width:172px;padding:5px;background:${bg};border:1px solid ${line};border-radius:8px;box-shadow:0 12px 30px #0008}
.context-menu button{display:block;width:100%;border:0;text-align:left;padding:7px 9px}.context-menu button:hover{background:${light ? "#dfe7f5" : "#373d49"}}.context-menu .danger{color:#df6868}.hidden{display:none!important}</style>
<div id="titlebar"><span id="wsname"></span><span id="wstitle"></span><span class="tb-spacer"></span><button id="update-chip" class="hidden" title="${t("settings.updateAvailable")}">${t("sidebar.updateAvailable")}</button><div id="tools"><button class="tb" data-act="changes" data-tip="${t("tab.changes")}" data-key="⌘0" aria-label="${t("tab.changes")} (⌘0)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><line x1="3.5" y1="12" x2="8.8" y2="12"/><line x1="15.2" y1="12" x2="20.5" y2="12"/></svg></button><button class="tb" data-act="files" data-tip="${t("tab.files")}" data-key="⌘1" aria-label="${t("tab.files")} (⌘1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5C4 6.7 4.7 6 5.5 6h3.2c.5 0 .9.2 1.2.6L11 8h7.3c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5h-13C4.7 19 4 18.3 4 17.5z"/></svg></button><span class="tb-sep"></span><button class="tb hidden" data-act="terminal" data-tip="${t("terminal.title")}" data-key="⌃\`" aria-label="${t("terminal.title")} (⌃\`)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7l4 5-4 5"/><path d="M13 17h6"/></svg></button><button class="tb" data-act="history" data-tip="${t("rail.history")}" data-key="⌘9" aria-label="${t("rail.history")} (⌘9)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.3"/><path d="M12 7.4v5l3.2 1.9"/></svg></button></div></div><main id="hub"><div id="railhead"><span id="railtitle">${t("hub.workspaces")}</span><button id="new" title="${t("hub.newWorkspace.title")}">＋</button><button id="pin" title="${t("hub.expandRail.title")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6l6 6-6 6"/><path d="M13 6l6 6-6 6"/></svg></button></div><section id="list"></section><div id="usage-foot" class="usage-foot" aria-label="Agent usage"></div><div id="railfoot"><button id="settings" title="${t("hub.settings.title", { v: appVersion })}">⚙</button></div></main><div id="tt"></div>
<script>
const T=${JSON.stringify(T)};
const APP_VERSION=${JSON.stringify(appVersion)};
const list=document.querySelector("#list"),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Workspaces whose removal is in flight. \`git worktree remove\` takes as long as it takes, and until this
// existed the tile sat there looking clickable and then simply vanished — no sign that the click had landed,
// and a second click in the meantime would try to activate a workspace being destroyed. Held as ids rather
// than as a class on the node so a rail re-render mid-delete (wcls) paints the state back on.
const deletingIds=new Set();
function markDeleting(id,on){on?deletingIds.add(id):deletingIds.delete(id);for(const el of document.querySelectorAll('.wt[data-id="'+id+'"]'))el.classList.toggle('deleting',on);}
const newModal=prefill=>window.kakapoHub.openModal('new',prefill&&prefill.path?{path:prefill.path,name:prefill.name}:curRepo?{path:curRepo.path,name:curRepo.name}:undefined);
document.querySelector("#new").onclick=()=>newModal();
document.querySelector("#settings").onclick=()=>window.kakapoHub.settings();
// One version check per launch, against the same GitHub release the review's settings panel reads. The chip is
// only ever a pointer: the install itself lives behind the Update button in Settings, which knows whether
// this is the packaged bundle (release DMG) or the global CLI (npm).
// On a timer, not once at startup: this window is left running for days with workspaces open, so a release
// published after launch was invisible until something reloaded the page. The label is rebuilt from a base
// caption each time — appending to the chip's own text would grow it by a version on every check.
(()=>{const chip=document.querySelector("#update-chip");if(!chip||typeof fetch!=="function")return;
const base=chip.textContent;
chip.onclick=()=>window.kakapoHub.settings();
const newer=(a,b)=>{const p=v=>String(v).replace(/^v/,"").split(".").map(n=>parseInt(n,10)||0),x=p(a),y=p(b);
  for(let i=0;i<Math.max(x.length,y.length);i++){const l=x[i]||0,r=y[i]||0;if(l!==r)return l>r;}return false;};
const check=()=>fetch("https://api.github.com/repos/happy-nut/kakapo/releases/latest",{cache:"no-store",headers:{accept:"application/vnd.github+json"}})
  .then(r=>r&&r.ok?r.json():null)
  .then(d=>{const v=d&&d.tag_name?String(d.tag_name).replace(/^v/,""):"";
    if(v&&newer(v,APP_VERSION)){chip.textContent=base+" v"+v;chip.classList.remove("hidden");}})
  .catch(()=>{});
check();
setInterval(check,6*60*60*1000);})();
const tools=document.getElementById('tools');
tools.addEventListener('click',e=>{const b=e.target.closest('button.tb');if(!b)return;window.kakapoHub.railAction(b.dataset.act)});
// Custom hover tooltip (label + shortcut kbd) for the top toolbar buttons — styled like the review view's, and
// works reliably in this child view where the native title tooltip is flaky. Content is built with textContent.
const tt=document.getElementById('tt');
function showTip(b){const tip=b.dataset.tip;if(!tip){tt.classList.remove('show');return;}tt.textContent='';const lab=document.createElement('span');lab.textContent=tip;tt.appendChild(lab);if(b.dataset.key){const k=document.createElement('kbd');k.textContent=b.dataset.key;tt.appendChild(k);}tt.classList.add('show');const r=b.getBoundingClientRect(),bb=tt.getBoundingClientRect();
// Under the button is where a tooltip belongs and the one place this page cannot draw: the review view is
// laid out from the title bar's bottom edge down (TITLEBAR_H) and covers everything below it, so the bubble
// was rendering into a strip nobody can see. It lives IN the bar instead, right-aligned to the tools group —
// so it never sits under the pointer, and never jumps as you sweep across the icons.
tt.style.left=Math.max(6,tools.getBoundingClientRect().left-bb.width-8)+'px';tt.style.top=Math.max(2,r.top+r.height/2-bb.height/2)+'px';}
tools.addEventListener('mouseover',e=>{const b=e.target.closest('button.tb');if(b)showTip(b);});
tools.addEventListener('mouseout',e=>{const b=e.target.closest('button.tb');if(b&&(!e.relatedTarget||!b.contains(e.relatedTarget)))tt.classList.remove('show');});
tools.addEventListener('click',()=>tt.classList.remove('show'));
window.kakapoHub.onRailState(s=>{s=s||{};const active=s.active||[];for(const b of tools.querySelectorAll('button.tb')){const a=b.dataset.act;if(a==='terminal'){b.classList.toggle('hidden',!s.terminal);}b.classList.toggle('active',active.indexOf(a)>=0);}});
window.kakapoHub.onToggle(open=>document.body.classList.toggle('closed',!open));window.kakapoHub.onNew(prefill=>newModal(prefill));
// ---- Agent quota, moved here from the review's sidebar footer. One row per limit window that can actually
// stop work — Claude's 5h session, its weekly caps, then Codex's — each a battery of the quota still LEFT
// plus how long until that window resets. Marks are the official Claude / OpenAI logos (simple-icons, CC0).
const CLAUDE_ICO='<svg class="usage-ico usage-ico-claude" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>';
const CODEX_ICO='<svg class="usage-ico usage-ico-codex" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>';
const uTokens=n=>{n=n||0;if(n>=1e6)return (n/1e6).toFixed(n>=1e7?0:1)+'M';if(n>=1e3)return Math.round(n/1e3)+'k';return String(n)};
const uSpan=d=>{const h=Math.floor(d/3600000),days=Math.floor(h/24),rh=h%24,m=Math.floor((d%3600000)/60000);
  if(days>0)return days+T.uD+' '+rh+T.uH; if(h>0)return h+T.uH+' '+m+T.uM; return m+T.uM;};
const uReset=ms=>{const d=ms-Date.now();return (!ms||d<=0)?T.uNow:uSpan(d)};
// Everything is the quota still LEFT, never the amount used. Amber under a quarter, red under a tenth, so a
// nearly-flat window is obvious without reading the number.
const uTone=(p,color)=>p<=10?'#e5484d':p<=25?'#f5a524':color;
// A window's row: label, % left, reset — with the meter as the row's background rather than a column of its own.
const uRow=(w,color)=>{const p=Math.max(0,Math.min(100,w.left));
  const el=document.createElement('span');
  el.className='usage-row'; el.title=w.tip;
  el.innerHTML='<i class="usage-fill" style="width:'+p.toFixed(1)+'%;background:'+uTone(p,color)+'"></i>'
    +'<span class="usage-label">'+esc(w.name)+'</span>'
    +'<span class="usage-pct">'+Math.round(p)+'%</span>'
    +'<span class="usage-reset">'+esc(uReset(w.resetsAt))+'</span>';
  return el;};
// Collapsed: the provider's mark inside a ring of its tightest window. 26px is the largest circle that keeps
// its 2.4px stroke crisp inside the 46px rail.
const uRing=(p,color)=>{const r=11,c=2*Math.PI*r,v=Math.max(0,Math.min(100,p));
  return '<svg viewBox="0 0 26 26" width="26" height="26" aria-hidden="true">'
    +'<circle class="usage-ring-track" cx="13" cy="13" r="'+r+'"/>'
    +'<circle class="usage-ring-fill" cx="13" cy="13" r="'+r+'" stroke="'+uTone(v,color)+'"'
    +' stroke-dasharray="'+(c*v/100).toFixed(2)+' '+c.toFixed(2)+'" transform="rotate(-90 13 13)"/></svg>';};
// One provider = one block expanded, one ring collapsed. Its windows are worst-first; the note replaces
// the summary when there is no percentage to show at all (Claude's token-count fallback).
const uGroup=(g)=>{const exp=document.body.classList.contains('rail-exp');
  const worst=g.windows.length?g.windows.reduce((a,b)=>a.left<=b.left?a:b):null;
  const el=document.createElement('div');
  if(!exp){
    el.className='usage-cell'; el.title=g.tip;
    el.innerHTML='<span class="usage-ring-wrap">'+(worst?uRing(worst.left,g.color):'')
      +'<span class="usage-ring-ico">'+g.ico+'</span></span>'
      +'<span class="usage-cell-num">'+esc(worst?Math.round(worst.left):g.note||'')+'</span>';
    return el;
  }
  el.className='usage-group';
  const head=document.createElement('div');
  head.className='usage-head'; head.title=g.tip;
  const warn=worst&&worst.left<=25?uTone(worst.left,''):'';
  head.innerHTML=g.ico+'<span class="usage-head-name">'+esc(g.name)+'</span>'
    +'<span class="usage-head-sum"'+(warn?' style="color:'+warn+'"':'')+'>'
    +esc(worst?Math.round(worst.left)+'% '+T.uLeft:g.note||'')+'</span>';
  el.appendChild(head);
  g.windows.forEach(w=>el.appendChild(uRow(w,g.color)));
  return el;};
const uName=l=>l.label||(l.kind==='session'?T.uSession:T.uWeekly);
const uTip=(provider,name,pct,resetsAt)=>provider+' · '+name+'\\n'+Math.round(pct)+'% '+T.uLeft+' · '+T.uResets+' '+uReset(resetsAt);
// The rail's two states need different markup (blocks vs rings), so keep the last snapshot and repaint from
// it when the rail toggles — re-reading the agent logs just to change layout would be wasteful.
let uSnap=null;
function paintUsage(){
  const el=document.getElementById('usage-foot');
  if(!el)return;
  el.textContent='';
  const s=uSnap; if(!s)return;
  const groups=[];
  if(s.claude){
    const c=s.claude, lims=c.limits||[];
    // A quota kept through a rate-limited refresh still answers "how much is left" — say how old it is.
    const age=c.quotaAt&&Date.now()-c.quotaAt>120000?'\\n'+T.uAsOf.replace('{age}',uSpan(Date.now()-c.quotaAt)):'';
    // Worst-first from main: the window closest to its cap decides when work stops.
    const windows=lims.map(l=>{const name=uName(l),left=100-l.usedPercent;
      return {name:name,left:left,resetsAt:l.resetsAt,tip:uTip('Claude',name,left,l.resetsAt)+age};});
    if(windows.length)groups.push({name:'Claude',ico:CLAUDE_ICO,color:'#d97757',windows:windows,tip:'Claude'+age});
    else if(c.tokensToday)groups.push({name:'Claude',ico:CLAUDE_ICO,color:'#d97757',windows:[],
      note:uTokens(c.tokensToday),tip:'Claude\\n'+uTokens(c.tokensToday)+' '+T.uTokensToday});
  }
  if(s.codex&&s.codex.primary){
    const plan='Codex'+(s.codex.planType?' ('+s.codex.planType+')':'');
    // Codex reports its own window lengths, so name each from windowMinutes rather than assuming an order.
    const windows=[s.codex.primary,s.codex.secondary].filter(Boolean).map(w=>{
      const name=w.windowMinutes>=1440?T.uWeekly:T.uSession,left=100-w.usedPercent;
      return {name:name,left:left,resetsAt:w.resetsAt,tip:uTip(plan,name,left,w.resetsAt)};});
    groups.push({name:'Codex',ico:CODEX_ICO,color:'#10a37f',windows:windows,tip:plan});
  }
  groups.forEach(g=>el.appendChild(uGroup(g)));
}
function renderUsage(){
  if(!window.kakapoHub||typeof window.kakapoHub.usage!=='function')return;
  Promise.resolve(window.kakapoHub.usage()).then(s=>{uSnap=s;paintUsage();}).catch(()=>{});
}
renderUsage();
setInterval(renderUsage,60000);
// Rail expand: ⌘⇧E or the » button toggles it open; main then pushes the review views right (they render over
// the shell page, so the rail can't overlay them) and collapses the active view's file tree to make room.
let railExp=false;const pinBtn=document.getElementById('pin');
// Visual state only. Main owns keyboard focus: it focuses the rail while expanded (so arrows/Enter navigate
// workspaces) and returns focus to the review view when it collapses.
function paintRail(){document.body.classList.toggle('rail-exp',railExp);paintUsage();}
// User action (⌘⇧E / the » pin): flip and tell main, which animates the view push, collapses the file tree, and
// moves focus onto the rail.
function toggleRail(){railExp=!railExp;paintRail();window.kakapoHub.setHubExpanded(railExp);if(railExp){initRailSel();railDropChromeFocus();}else railClearSel();}
// Once the rail is open, ↑/↓/Enter belong to the workspace tiles — but the button you CLICKED to open it still
// holds keyboard focus in Chromium, so Enter re-activated the collapse arrow and the panel shut instead of
// entering the workspace under the selection. Nothing in the rail head is meant to be operated by Enter while
// the rail is open, so it gives the keyboard back.
function railDropChromeFocus(){const a=document.activeElement;if(a&&a.closest&&a.closest('#railhead')&&a.blur)a.blur();}
// While the expanded rail holds focus, ↑/↓ move a selection through the workspace tiles and Enter opens it.
let railSel=-1;
// Disconnected tiles ARE keyboard-navigable — Enter/⌫ on one routes to the reconnect/forget dialog, same as a
// click. (They used to be excluded here, so a dead workspace could be neither selected nor recovered by keyboard.)
function railTiles(){return [...document.querySelectorAll('.ev .proj:not(.collapsed) .wt')];}
function railSelect(i){const t=railTiles();if(!t.length){railSel=-1;return;}railSel=Math.max(0,Math.min(t.length-1,i));t.forEach((el,j)=>el.classList.toggle('kbd-sel',j===railSel));const el=t[railSel];if(el&&el.scrollIntoView)el.scrollIntoView({block:'nearest'});}
function railClearSel(){railSel=-1;document.querySelectorAll('.ev .wt.kbd-sel').forEach(el=>el.classList.remove('kbd-sel'));}
function initRailSel(){const t=railTiles();const ai=t.findIndex(el=>el.classList.contains('act'));railSelect(ai>=0?ai:0);}
document.addEventListener('keydown',e=>{
  if(!railExp||document.querySelector('dialog[open]'))return; // only when the rail is expanded and no dialog owns keys
  const a=document.activeElement;if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'))return;
  // The expanded rail is a peek, so Esc backs out of it the way it backs out of everything else. toggleRail
  // routes through main's hub-expanded handler, which animates the collapse and hands focus back to the review
  // view — the same path as clicking into the view or pressing ⌘⇧E again.
  if(e.key==='Escape'){e.preventDefault();toggleRail();return;}
  // While expanded the shell holds keyboard focus, so review shortcuts (Changes/Files/History/Terminal) never reach the review view.
  // Collapse the rail (which returns focus to the review) and forward the tool action, so e.g. ⌘1 still opens Files.
  let fwd=null;
  if(e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey&&e.key==='0')fwd='changes';
  else if(e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey&&e.key==='1')fwd='files';
  else if(e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey&&e.key==='9')fwd='history';
  else if(e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey&&e.code==='Backquote')fwd='terminal';
  if(fwd){e.preventDefault();toggleRail();window.kakapoHub.railAction(fwd+':open');return;}
  // ⌘, is the same story as the tools above — Settings lives in the review view, so while the rail holds the
  // keyboard the standard Preferences accelerator did nothing at all. It carries no ':open': Settings is a
  // modal you toggle, not a view the rail can reveal.
  if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&(e.key===','||e.code==='Comma')){
    e.preventDefault();toggleRail();window.kakapoHub.railAction('settings');return;
  }
  // F7/⇧F7 step through changes, which is a review action, not a rail one — collapse and forward it too so
  // the panel gets out of the way instead of swallowing the key.
  if(e.key==='F7'&&!e.metaKey&&!e.ctrlKey&&!e.altKey){
    e.preventDefault();toggleRail();
    window.kakapoHub.railAction(e.shiftKey?'prevChange':'nextChange');
    return;
  }
  if(e.key==='ArrowDown'){e.preventDefault();railSelect(railSel<0?0:railSel+1);}
  else if(e.key==='ArrowUp'){e.preventDefault();railSelect(railSel<0?0:railSel-1);}
  // Always swallowed while the rail is open, even with nothing selected (a collapsed project group has no
  // tiles at all). Otherwise Enter falls through to whatever chrome button happens to hold focus, which is how
  // "open another workspace" became "close the panel".
  else if(e.key==='Enter'){const t=railTiles();e.preventDefault();if(railSel>=0&&t[railSel])t[railSel].click();}
  // Rename (E) / delete (⌫). Match on e.code (the physical key) not e.key: under a Korean/other IME the 'e' key
  // emits a composed jamo rather than 'e', so an e.key==='e' test never fired with Hangul input active.
  else if(e.code==='KeyE'&&!e.metaKey&&!e.ctrlKey&&!e.altKey){const t=railTiles();const el=railSel>=0?t[railSel]:null;if(el&&el.dataset.disconnected!=='true'&&el.dataset.closed!=='true'){e.preventDefault();window.kakapoHub.openModal('rename',{id:Number(el.dataset.id),name:el.dataset.name||''});}}
  // ⌫/Delete opens the same delete-confirm flow as the tile menu's "Delete worktree…". A disconnected tile has no
  // worktree to remove, so it routes to the reconnect/forget dialog; the main checkout can't be deleted (the
  // context menu hides Delete for it), so leave it alone.
  else if(e.key==='Backspace'||e.key==='Delete'){const t=railTiles();const el=railSel>=0?t[railSel]:null;if(el){e.preventDefault();if(el.dataset.disconnected==='true')window.kakapoHub.openModal('disconnected',{path:decodeURIComponent(el.dataset.path)});else if(el.dataset.kind!=='main')removeWorkspace(Number(el.dataset.id),el.dataset.name||'');}}
});
pinBtn.onclick=toggleRail;
window.kakapoHub.onToggleExpand(toggleRail);
// Main collapses the rail (visual only, no echo) when focus returns to the review view — clicking back into the
// "main window" dismisses the peek.
window.kakapoHub.onSetExpanded(open=>{railExp=!!open;paintRail();if(!railExp)railClearSel();else railDropChromeFocus();});
const ago=value=>{const seconds=Math.max(0,Math.floor((Date.now()-Number(value||Date.now()))/1000));return seconds<60?T.agoNow:seconds<3600?T.agoM.replace('{n}',Math.floor(seconds/60)):seconds<86400?T.agoH.replace('{n}',Math.floor(seconds/3600)):T.agoD.replace('{n}',Math.floor(seconds/86400))};
let curRepo=null; // active workspace's project, used to prefill the New-workspace dialog
window.kakapoHub.onState(items=>{const groups=new Map;for(const w of items){if(!groups.has(w.repoName))groups.set(w.repoName,[]);groups.get(w.repoName).push(w)}
// Left: which checkout this is — project and the branch it is on, the two things you cannot rename away.
// Centre: the alias, the title you CAN edit (blank when you never gave it one; the pair on the left already
// says what this workspace is, and repeating the branch in the middle would say it twice).
const _a=items.find(w=>w.active);const _wn=document.getElementById('wsname');if(_wn)_wn.innerHTML=_a?'<span class="wsdot"></span>'+esc(_a.repoName)+' <span class="rp">· '+esc(_a.branch)+'</span>':'';
const _wt=document.getElementById('wstitle');if(_wt)_wt.textContent=_a&&_a.alias&&_a.alias!==_a.branch?_a.alias:'';
// Remember the active workspace's project so ⌘N can prefill it — a new task almost always belongs to the repo
// you are looking at.
curRepo=_a&&_a.repoRoot?{path:_a.repoRoot,name:_a.repoName}:curRepo;
// Badge initials. Split on separators only (NOT on every non-Latin char) so Korean/CJK names keep their
// letters instead of collapsing to "?". Latin → uppercased two-word/two-letter initials; CJK → the first one
// or two characters as-is (Hangul has no case).
const initials=w=>{var s=String(w.alias||(w.kind==='main'?w.repoName:0)||w.branch||w.repoName||'?').replace(/^(feature|fix|chore|bugfix|hotfix|release)[\\/_-]/i,'').trim();if(!s)return'?';var parts=s.split(/[\\s._/-]+/).filter(Boolean);var a=parts[0]||s,ac=Array.from(a),latin=/^[A-Za-z0-9]/.test(a),r;if(parts.length>1){var bc=Array.from(parts[1]);r=(ac[0]||'')+(bc[0]||'');}else{r=ac.slice(0,2).join('');}return latin?r.toUpperCase():r;};
// Proper nouns, so the same two labels in every locale — they name the agent, they don't describe it.
const AGENT_NAME={claude:'Claude',codex:'Codex'};
const AGENT_ICO={claude:CLAUDE_ICO,codex:CODEX_ICO};
// The badge is omitted, not blanked, for a workspace whose agent is unknown: a worktree you have only ever
// run plain shell commands in has no agent, which is different from having one we failed to name.
const agentIco=w=>AGENT_ICO[w.agent]?'<span class="wt-agent" role="img" aria-label="'+esc(AGENT_NAME[w.agent])+'">'+AGENT_ICO[w.agent]+'</span>':'';
const tip=w=>(w.alias||w.branch)+' · '+w.repoName+' · '+w.path+(AGENT_NAME[w.agent]?' · '+AGENT_NAME[w.agent]:'')+(w.dirtyCount?' · '+T.changed.replace('{n}',w.dirtyCount):'')+(w.ahead?' · '+T.ahead.replace('{n}',w.ahead):'')+(w.running?' · ● '+T.running:w.resume?' · '+T.resumable:w.disconnected?' · '+T.disconnected:'');
// Stable per-project hue (all worktrees share it) — tints the collapsed group's accent bar + avatar
// placeholder and the expanded panel's project badge, so projects read apart at a glance.
const projHue=n=>{let h=0;const s=String(n||'');for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return h%360;};
// Shared per-worktree bits: state classes and the data-* every click/activate/context-menu handler reads.
const wcls=w=>(w.active?' act':'')+(w.disconnected?' disc':'')+(w.busy?' busy':'')+(w.running?' running':'')+(w.unread?' attn':'')+(deletingIds.has(w.id)?' deleting':'');
const wattr=w=>' data-id="'+w.id+'" data-path="'+encodeURIComponent(w.path)+'" data-name="'+esc(w.alias||w.branch)+'" data-disconnected="'+!!w.disconnected+'" data-closed="'+!!w.closed+'" data-resume="'+(w.resume&&!w.running?'1':'')+'" data-kind="'+esc(w.kind||'')+'" title="'+esc(tip(w))+'"';
const grpAvatar=ws=>{for(const w of ws)if(w.avatar)return w.avatar;return null;};
const projMark=repo=>{const a=Array.from(String(repo||'?').trim());const c=a[0]||'?';return /[A-Za-z0-9]/.test(c)?c.toUpperCase():c;};
const avInner=(ws,repo)=>{const av=grpAvatar(ws);return av?'<img src="'+av+'" alt="">':esc(projMark(repo));};
const avStyle=(ws,repo)=>grpAvatar(ws)?'':' style="background:hsl('+projHue(repo)+',44%,60%)"';
const chev='<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>';
const homeIco='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.1 3.3 10a.6.6 0 0 0 .38 1.06H5v8.4c0 .3.24.54.54.54H9.6v-5.2h4.8v5.2h4.06c.3 0 .54-.24.54-.54v-8.4h1.32A.6.6 0 0 0 20.7 10z"/></svg>';
const isMain=w=>w.kind==='main';
const cv='<div class="cv">'+[...groups].map(([repo,ws])=>'<div class="grp"><div class="phav" data-repo="'+esc(repo)+'" title="'+esc(repo)+'"'+avStyle(ws,repo)+'>'+avInner(ws,repo)+'</div><div class="wts">'+ws.map(w=>'<button class="wt'+wcls(w)+'"'+wattr(w)+'>'+esc(initials(w))+'<span class="rdot"></span><span class="udot"></span>'+(isMain(w)?'<span class="mdot" title="'+esc(T.mainWorktree)+'">'+homeIco+'</span>':'')+'</button>').join('')+'</div></div>').join('')+'</div>';
// No heading here: the rail header above the list already names this (#railtitle), and two "Workspaces"
// stacked on top of each other was just the same word twice.
const ev='<div class="ev"><div class="plist">'+[...groups].map(([repo,ws])=>'<div class="proj"><div class="prow" data-repo="'+esc(repo)+'"><span class="pav"'+avStyle(ws,repo)+'>'+avInner(ws,repo)+'</span><span class="pname">'+esc(repo)+'</span><span class="pcount">'+ws.length+'</span>'+chev+'</div><div class="ewts">'+ws.map(w=>{
// The main checkout is named for what it IS, not for whatever branch it happens to sit on: labelling it by
// branch made a project whose main was on a feature branch look like it had no main at all. The branch line
// below still shows the real branch.
const nm=esc(w.alias||(isMain(w)?T.mainWorktree:0)||w.branch);const showBr=w.branch&&w.branch!==(w.alias||(isMain(w)?T.mainWorktree:0));const brLine=showBr?'<div class="wt-branch">'+esc(w.branch)+'</div>':'';const tag=w.dirtyCount?'<span class="wt-tag">'+w.dirtyCount+'</span>':'';
// Uncommitted changes and unsent commits are different questions — "have I finished?" and "have I sent it?" —
// so they are two pills, not one number. The arrow is what tells them apart at a glance; absent means zero,
// which is the answer for most workspaces most of the time and deserves no ink.
const aheadTag=w.ahead?'<span class="wt-tag wt-ahead" title="'+esc(T.ahead.replace('{n}',w.ahead))+'">↑'+w.ahead+'</span>':'';const home=isMain(w)?'<span class="wt-home" title="'+esc(T.mainWorktree)+'">'+homeIco+'</span>':'';
// Which agent this worktree is running, in its own brand colour. The terminal records it the moment you
// type claude/codex (agent-resume.ts), so a workspace shows its badge while the agent is live and keeps it
// afterwards — the same fact the resume action is offered from. Only the expanded rail: the collapsed strip
// is 46px of initials and a status dot, with no room for a second glyph.
const agent=agentIco(w);
return '<button class="wt'+wcls(w)+'"'+wattr(w)+'><div class="wt-top"><span class="dot"></span><span class="wt-name">'+nm+'</span>'+home+agent+aheadTag+tag+'</div>'+brLine+'</button>';}).join('')+'</div></div>').join('')+'</div></div>';
list.innerHTML=cv+ev;
// Worktree click → activate (or reconnect/forget a disconnected one). Collapsed badges and expanded cards are
// both .wt with the same data-*, so one handler covers both views.
for(const el of list.querySelectorAll('.wt')){el.onclick=()=>{const id=Number(el.dataset.id),path=decodeURIComponent(el.dataset.path);if(el.dataset.disconnected==='true'){window.kakapoHub.openModal('disconnected',{path});return}if(el.dataset.closed==='true'){window.kakapoHub.openPath(path);return}window.kakapoHub.activate(id)};}
// Collapsed project avatar → jump to that project's active (or first) worktree.
for(const el of list.querySelectorAll('.phav')){el.onclick=()=>{const ws=groups.get(el.dataset.repo)||[];const t=ws.find(w=>w.active&&!w.disconnected)||ws.find(w=>!w.disconnected)||ws[0];if(!t)return;if(t.closed)window.kakapoHub.openPath(t.path);else if(t.disconnected)window.kakapoHub.openModal('disconnected',{path:t.path});else window.kakapoHub.activate(t.id);};}
// Expanded project header → collapse/expand its worktree list (chevron rotates).
for(const el of list.querySelectorAll('.prow')){el.onclick=()=>el.parentElement.classList.toggle('collapsed');}
if(railExp)railSelect(railSel<0?0:railSel); // re-apply the keyboard selection after a re-render
});
// Lightweight agent-activity ticks (spinner / attention dot) that toggle classes on existing tiles without a
// full re-render, so a streaming agent doesn't rebuild the rail DOM and drop hover/focus state.
window.kakapoHub.onActivity(list=>{for(const a of list){for(const el of document.querySelectorAll('.wt[data-id="'+a.id+'"]')){el.classList.toggle('busy',!!a.busy);el.classList.toggle('running',!!a.running);el.classList.toggle('attn',!!a.unread);}}});
window.kakapoHub.onTileAction(d=>{const id=d.id,name=d.name||'';const action=d.action;if(action==='rename'){window.kakapoHub.openModal('rename',{id,name});}else if(action==='memo'){window.kakapoHub.openModal('memo',{id,name});}else if(action==='activate')window.kakapoHub.activate(id);else if(action==='resume')window.kakapoHub.resume(id);else if(action==='detach')window.kakapoHub.detach(id);else if(action==='close')window.kakapoHub.remove(id,'close');else if(action==='delete')removeWorkspace(id,name);});
async function removeWorkspace(id,name){const r0=await window.kakapoHub.confirm({title:name?T.delTitleNamed.replace('{name}',name):T.delTitle,message:T.delMessage,checkbox:T.delCheckbox,checked:true,buttons:[T.cancel,T.del],danger:true,defaultId:0});if(r0.index!==1)return;const delBranch=r0.checked;let r;
// Main answers a failed removal with {ok:false,error}, but an invoke can still reject outright (a thrown
// handler crosses the bridge as a rejection). Unguarded, that rejection skipped the failure dialog below and
// the delete reported nothing at all — the loudest possible silence for the one action that destroys work.
// Dimmed + "deleting…" for exactly as long as main is actually working, and NOT while a confirm dialog is
// up in between — the tile marks itself before each call and clears in finally, so the risk-check round trip
// and the real removal both show, and a cancelled second dialog leaves the tile untouched.
const rm=async(...a)=>{markDeleting(id,true);try{return await window.kakapoHub.remove(id,'delete',...a)}finally{markDeleting(id,false)}};
try{r=await rm(false,delBranch);if(r.needsConfirmation){const x=r.risk;const detail=[x.dirty&&T.dirty,x.unpushed&&T.unpushed.replace('{n}',x.unpushed).replace('{s}',x.unpushed===1?'':'s'),x.runningProcesses&&T.runningProc].filter(Boolean).join('\\n');const r2=await window.kakapoHub.confirm({title:T.anywayTitle,message:T.hasWork,detail,buttons:[T.cancel,T.anyway],danger:true,defaultId:0});if(r2.index!==1)return;r=await rm(true,delBranch);}}catch(err){r={ok:false,error:(err&&err.message)||String(err)};}
if(!r.ok)await window.kakapoHub.confirm({title:T.failedTitle,message:r.error||T.failedMsg,buttons:[T.ok]});}
document.addEventListener('contextmenu',e=>{const card=e.target.closest&&e.target.closest('.wt');if(card){e.preventDefault();if(card.dataset.closed==='true')return;if(card.dataset.disconnected==='true'){window.kakapoHub.openModal('disconnected',{path:decodeURIComponent(card.dataset.path)});return}window.kakapoHub.tileMenu({id:Number(card.dataset.id),name:card.dataset.name||'',resume:card.dataset.resume==='1',kind:card.dataset.kind||''});}});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.altKey&&/^[1-9]$/.test(e.key)){e.preventDefault();window.kakapoHub.activateIndex(Number(e.key)-1)}});
document.addEventListener('click',e=>{if(!railExp&&!e.target.closest('button,input,textarea,dialog,#wsname'))window.kakapoHub.refocusReview()});
window.kakapoHub.requestState();
</script>`;
}

// The New-workspace / rename / memo dialogs, rendered in a transparent WebContentsView that main layers ABOVE
// the review view. Because the page background is transparent and the dialog's ::backdrop is a translucent
// dim, the live review content shows through dimmed rather than blanking — no snapshot/capturePage needed.
// The rail (hubHtml) asks main to show this via openModal(); main tells this page which dialog to open via
// onModalOpen(); closing any dialog asks main to hide the overlay again via closeModal().
export function modalOverlayHtml(light: boolean, t: Translate): string {
  const fg = light ? "#242424" : "#ddd", line = light ? "#d0d0d0" : "#454545";
  const dim = "rgba(0,0,0,.45)";
  // Strings the overlay's client script sets at runtime (reset labels, the create-flow button states, the
  // rename/memo prompt titles). Static dialog chrome below is localized inline with ${t(...)}.
  const T = {
    selectProject: t("newws.selectProject"), browse: t("newws.browse"), chooseFirst: t("newws.chooseFirst"),
    creating: t("newws.creating"), create: t("newws.create"), createFailed: t("newws.createFailed"),
    opening: t("newws.opening"), open: t("newws.open"),
    renameTitle: t("newws.renameTitle"), memoTitle: t("newws.memoTitle"),
  };
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:transparent;color:${fg};font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button{border:1px solid ${line};background:transparent;color:inherit;border-radius:6px;padding:4px 8px}
.hidden{display:none!important}
dialog#create{border:1px solid ${line};border-radius:14px;background:${light ? "#fbfbfc" : "#242529"};color:${fg};width:456px;max-width:calc(100vw - 40px);padding:0;box-shadow:0 30px 90px #000a}
dialog#create::backdrop{background:${dim}}
#create .dh{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 2px}
#create .dh b{font-size:15.5px;font-weight:650}
#create .dx{width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:${light ? "#888" : "#8a8f99"};font-size:14px;display:grid;place-items:center;padding:0}
#create .dx:hover{background:${light ? "#eaeaea" : "#33383f"};color:${fg}}
#create .db{padding:6px 20px 20px}
#create label{display:block;margin:15px 0 7px;color:${light ? "#6b7280" : "#8a8f99"};font-size:11.5px;font-weight:600;letter-spacing:.02em}
#create .field{width:100%;display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid ${line};border-radius:10px;background:${light ? "#fff" : "#2c2d31"};color:inherit;text-align:left;font-size:13.5px}
#create .field:hover{border-color:#4d86d9}
#create .field .fi{flex:none;color:${light ? "#9aa0ab" : "#8a8f99"};display:grid;place-items:center}
#create .field .fv{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#create .field .fv.ph{color:${light ? "#9aa0ab" : "#71767f"}}
#create .field-wrap{position:relative}
#create .field .fc{flex:none;margin-left:auto;color:${light ? "#9aa0ab" : "#8a8f99"};display:grid;place-items:center;transition:transform .15s}
#create .field[aria-expanded="true"]{border-color:#4d86d9}
#create .field[aria-expanded="true"] .fc{transform:rotate(180deg)}
#create .pmenu{position:absolute;top:calc(100% + 5px);left:0;right:0;z-index:20;background:${light ? "#fff" : "#2c2d31"};border:1px solid ${line};border-radius:10px;box-shadow:0 16px 40px #0007;padding:5px;max-height:232px;overflow-y:auto}
#create .pmenu.hidden{display:none}
#create .pmenu button{width:100%;display:flex;align-items:center;gap:9px;padding:8px 9px;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;font-size:13px}
#create .pmenu button:hover,#create .pmenu button:focus{background:${light ? "#eef1f6" : "#33383f"};outline:none}
#create .pmenu .pm-ic{flex:none;color:${light ? "#9aa0ab" : "#8a8f99"};display:grid;place-items:center}
#create .pmenu .pm-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#create .pmenu .pm-path{flex:none;max-width:44%;color:${light ? "#9aa0ab" : "#71767f"};font-size:10.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:right}
#create .pmenu .pm-sep{height:1px;background:${line};margin:5px 3px}
#create .pmenu .pm-browse{color:#4d86d9;font-weight:550}
dialog#prompt{border:1px solid ${line};border-radius:14px;background:${light ? "#fbfbfc" : "#242529"};color:${fg};width:400px;max-width:calc(100vw - 40px);padding:0;box-shadow:0 30px 90px #000a}
dialog#prompt::backdrop{background:${dim}}
#prompt .dh{padding:18px 20px 2px}#prompt .dh b{font-size:15px;font-weight:650}
#prompt .db{padding:6px 20px 20px}
#prompt input.tin{width:100%;margin-top:12px;padding:11px 12px;border:1px solid ${line};border-radius:10px;background:${light ? "#fff" : "#2c2d31"};color:inherit;font-size:13.5px}
#prompt input.tin:focus{outline:none;border-color:#4d86d9}
#prompt .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
#prompt .dbtn{border:1px solid ${line};background:transparent;color:inherit;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:550}
#prompt .dbtn:hover{background:${light ? "#eee" : "#33383f"}}
#prompt .dbtn.pri{background:${light ? "#1a1a1a" : "#f0f0f2"};color:${light ? "#fff" : "#1a1a1a"};border-color:transparent}
#prompt .dbtn.pri:hover{opacity:.9}
#create input.tin{width:100%;padding:11px 12px;border:1px solid ${line};border-radius:10px;background:${light ? "#fff" : "#2c2d31"};color:inherit;font-size:13.5px}
#create input.tin:focus{outline:none;border-color:#4d86d9}
#create input.tin::placeholder{color:${light ? "#9aa0ab" : "#71767f"}}
#create #preview{margin-top:11px;font-size:11px;color:${light ? "#6b7280" : "#8a8f99"};line-height:1.65;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
/* "Create a new worktree" toggle: the dialog used to always add one with no way to tell, so the choice and its
   consequence (new branch+folder vs. just opening the checkout) are both spelled out here. */
#create .wt-opt{display:flex;align-items:center;gap:8px;margin-top:16px;font-size:13px;font-weight:550;cursor:pointer}
#create .wt-opt input{accent-color:#4d86d9;width:14px;height:14px;margin:0}
#create .wt-hint{margin:4px 0 2px 22px;font-size:11.5px;color:${light ? "#6b7280" : "#8a8f99"}}
#create #labelRow.hidden{display:none}
#create .error{color:#e0736b;min-height:15px;margin-top:11px;font-size:12px}
#create .actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:20px}
#create .dbtn{border:1px solid ${line};background:transparent;color:inherit;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:550}
#create .dbtn:hover{background:${light ? "#eee" : "#33383f"}}
#create .dbtn.pri{background:${light ? "#1a1a1a" : "#f0f0f2"};color:${light ? "#fff" : "#1a1a1a"};border-color:transparent;display:inline-flex;align-items:center;gap:8px}
#create .dbtn.pri:hover{opacity:.9}#create .dbtn.pri:disabled{opacity:.5}
#create .dbtn.pri kbd{font:11px ui-monospace,monospace;background:#00000022;border-radius:5px;padding:1px 5px;opacity:.8}
/* Disconnected-workspace dialog (folder gone) — a custom design-system component replacing the OS message box. */
dialog#disc{border:1px solid ${line};border-radius:16px;background:${light ? "#fbfbfc" : "#242529"};color:${fg};width:340px;max-width:calc(100vw - 40px);padding:26px 24px 18px;box-shadow:0 30px 90px #000a;text-align:center}
dialog#disc::backdrop{background:${dim}}
#disc .disc-ic{width:52px;height:52px;margin:0 auto 16px;color:${light ? "#d99a2b" : "#e0a53a"}}
#disc .disc-ic svg{width:52px;height:52px;display:block}
#disc .disc-msg{font-size:15px;font-weight:650;line-height:1.35;margin-bottom:9px}
#disc .disc-path{font-size:12px;color:${light ? "#6b7280" : "#8a8f99"};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;line-height:1.5;margin-bottom:20px}
#disc .disc-actions{display:flex;flex-direction:column;gap:8px}
#disc .disc-btn{border:1px solid ${line};background:${light ? "#ececec" : "#33383f"};color:inherit;border-radius:10px;padding:11px 14px;font-size:13.5px;font-weight:600}
#disc .disc-btn:hover{filter:brightness(1.06)}
#disc .disc-btn.pri{background:#3b7ff0;color:#fff;border-color:transparent}
#disc .disc-btn:focus-visible{outline:none;box-shadow:0 0 0 3px #4d86d955}
/* Generic confirm / alert dialog — a custom design-system component replacing native message boxes (quit
   warning, delete-worktree confirm, not-a-repo error). Built dynamically from a spec: title, message, detail,
   optional checkbox, and a button row (last button is the primary/danger action). */
dialog#confirm{border:1px solid ${line};border-radius:14px;background:${light ? "#fbfbfc" : "#242529"};color:${fg};width:380px;max-width:calc(100vw - 40px);padding:22px 22px 18px;box-shadow:0 30px 90px #000a}
dialog#confirm::backdrop{background:${dim}}
#confirm .cf-ic{width:38px;height:38px;margin:0 0 13px;color:${light ? "#d99a2b" : "#e0a53a"}}
#confirm .cf-ic svg{width:38px;height:38px;display:block}
#confirm .cf-title{font-size:15px;font-weight:650;line-height:1.35;margin-bottom:8px}
#confirm .cf-msg{font-size:13px;color:${light ? "#4b5563" : "#b7bcc6"};line-height:1.5}
#confirm .cf-detail{font-size:12px;color:${light ? "#6b7280" : "#8a8f99"};line-height:1.6;margin-top:9px;white-space:pre-line;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
#confirm .cf-check{display:flex;align-items:center;gap:8px;margin-top:15px;font-size:13px;cursor:pointer;user-select:none}
#confirm .cf-check input{width:15px;height:15px;accent-color:#3b7ff0;margin:0}
#confirm .cf-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
#confirm .cf-btn{border:1px solid ${line};background:transparent;color:inherit;border-radius:9px;padding:8px 15px;font-size:13px;font-weight:550}
#confirm .cf-btn:hover{background:${light ? "#eee" : "#33383f"}}
#confirm .cf-btn.pri{background:#3b7ff0;color:#fff;border-color:transparent}
#confirm .cf-btn.danger{background:#d9463e;color:#fff;border-color:transparent}
#confirm .cf-btn.pri:hover,#confirm .cf-btn.danger:hover{filter:brightness(1.07)}
#confirm .cf-btn:focus-visible{outline:none;box-shadow:0 0 0 3px #4d86d955}</style>
<dialog id="create"><div class="dh"><b>${t("newws.title")}</b><button class="dx" id="dlgClose" aria-label="${t("newws.close")}">✕</button></div><div class="db"><label>${t("newws.project")}</label><div class="field-wrap"><button id="choose" class="field" aria-haspopup="listbox" aria-expanded="false"><span class="fi"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5C4 6.7 4.7 6 5.5 6h3.2c.5 0 .9.2 1.2.6L11 8h7.3c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5h-13C4.7 19 4 18.3 4 17.5z"/></svg></span><span id="repoName" class="fv ph">${t("newws.selectProject")}</span><span class="fc"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span></button><div id="projectMenu" class="pmenu hidden" role="listbox"></div></div><input type="hidden" id="repo"><label class="wt-opt"><input type="checkbox" id="wtNew" checked><span>${t("newws.newWorktree")}</span></label><div class="wt-hint">${t("newws.newWorktree.hint")}</div><div id="labelRow"><label>${t("newws.taskName")}</label><input id="label" class="tin" placeholder="${t("newws.taskPlaceholder")}" autocomplete="off" spellcheck="false"></div><div id="baseRow"><label>${t("newws.base")}</label><input id="base" class="tin" autocomplete="off" spellcheck="false"><div class="wt-hint">${t("newws.base.hint")}</div></div><div id="preview"></div><div class="error" id="createError"></div><div class="actions"><button id="cancelCreate" class="dbtn">${t("newws.cancel")}</button><button id="doCreate" class="dbtn pri"><span class="dcl">${t("newws.create")}</span><kbd>⌘↵</kbd></button></div></div></dialog>
<dialog id="prompt"><div class="dh"><b id="promptTitle"></b></div><div class="db"><input id="promptInput" class="tin" autocomplete="off" spellcheck="false"><div class="actions"><button id="promptCancel" class="dbtn">${t("newws.cancel")}</button><button id="promptOk" class="dbtn pri">${t("newws.ok")}</button></div></div></dialog>
<dialog id="disc"><div class="disc-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></div><div class="disc-msg">${t("disc.message")}</div><div id="discPath" class="disc-path"></div><div class="disc-actions"><button id="discReconnect" class="disc-btn pri">${t("disc.reconnect")}</button><button id="discRemove" class="disc-btn">${t("disc.remove")}</button><button id="discCancel" class="disc-btn">${t("disc.cancel")}</button></div></dialog>
<dialog id="confirm"><div class="cf-ic hidden" id="cfIcon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></div><div class="cf-title" id="cfTitle"></div><div class="cf-msg" id="cfMsg"></div><div class="cf-detail hidden" id="cfDetail"></div><label class="cf-check hidden" id="cfCheckWrap"><input type="checkbox" id="cfCheck"><span id="cfCheckLabel"></span></label><div class="cf-actions" id="cfActions"></div></dialog><script>
const T=${JSON.stringify(T)};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dlg=document.querySelector("#create");let creating=false;
// Each open starts clean (the overlay page persists across opens, so stale repo/label would otherwise linger).
// repo/name prefill the project from the rail's active workspace (see the openModal('new',…) call sites) —
// a new task nearly always belongs to the project you are looking at.
function openCreate(repo,name){document.querySelector("#repo").value='';const n=document.querySelector("#repoName");n.textContent=T.selectProject;n.classList.add('ph');document.querySelector("#label").value='';document.querySelector("#base").value='';document.querySelector("#preview").innerHTML='';document.querySelector("#createError").textContent='';document.querySelector("#wtNew").checked=true;paintWorktreeMode();loadProjects();closeProjectMenu();dlg.showModal();
if(repo)pickProject(repo,name);else setTimeout(()=>document.querySelector("#choose").focus(),0);}
// Any close of the create dialog (cancel / ✕ / Esc / success) tells main to hide the overlay.
dlg.addEventListener('close',()=>window.kakapoHub.closeModal());
document.querySelector("#cancelCreate").onclick=()=>{if(creating)window.kakapoHub.cancelCreate();else dlg.close()};
const wtNew=document.querySelector("#wtNew");
// Unchecked = open the project's existing checkout as-is: no new branch, no new folder, so the task-name field
// (which only names a worktree) is irrelevant and hides.
function paintWorktreeMode(){document.querySelector("#labelRow").classList.toggle('hidden',!wtNew.checked);document.querySelector("#baseRow").classList.toggle('hidden',!wtNew.checked);document.querySelector("#doCreate").querySelector('.dcl').textContent=wtNew.checked?T.create:T.open;}
wtNew.onchange=()=>{paintWorktreeMode();document.querySelector("#createError").textContent='';if(document.querySelector("#repo").value)preview();else document.querySelector("#preview").innerHTML='';};
// The base is no longer PRINTED in the preview: it is the value of an editable field two rows up, and a
// preview that repeats an input the reader is looking at spends a line saying nothing. Filling that field is
// this function's job instead — but only while it is still empty, or typing a task name would overwrite the
// ref the reviewer just chose (preview() runs on every keystroke).
async function preview(){const r=await window.kakapoHub.preview(document.querySelector("#repo").value,document.querySelector("#label").value,wtNew.checked);const b=document.querySelector("#base");if(r.ok&&r.worktree&&r.base&&!b.value)b.value=r.base;document.querySelector("#preview").innerHTML=r.ok?(r.worktree?'slug: '+esc(r.slug)+'<br>branch: '+esc(r.branch)+'<br>':'branch: '+esc(r.branch)+'<br>')+esc(r.path):''}
const projectMenu=document.querySelector("#projectMenu"),chooseBtn=document.querySelector("#choose");
function closeProjectMenu(){projectMenu.classList.add('hidden');chooseBtn.setAttribute('aria-expanded','false');}
function pickProject(path,name){document.querySelector("#repo").value=path;document.querySelector("#base").value='';const n=document.querySelector("#repoName");n.textContent=name||(path.split('/').filter(Boolean).pop()||path);n.classList.remove('ph');closeProjectMenu();preview();document.querySelector("#label").focus();}
async function browseForRepo(){closeProjectMenu();const r=await window.kakapoHub.chooseRepo();if(r.ok)pickProject(r.repo);}
const _pmFolder='<span class="pm-ic"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5C4 6.7 4.7 6 5.5 6h3.2c.5 0 .9.2 1.2.6L11 8h7.3c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5h-13C4.7 19 4 18.3 4 17.5z"/></svg></span>';
async function loadProjects(){let ps=[];try{ps=await window.kakapoHub.listProjects();}catch(e){}if(!Array.isArray(ps))ps=[];let html='';for(const p of ps)html+='<button type="button" role="option" data-path="'+esc(p.path)+'" data-name="'+esc(p.name)+'">'+_pmFolder+'<span class="pm-name">'+esc(p.name)+'</span><span class="pm-path">'+esc(p.path)+'</span></button>';if(ps.length)html+='<div class="pm-sep"></div>';html+='<button type="button" id="pmBrowse" class="pm-browse"><span class="pm-ic"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span><span class="pm-name">'+esc(T.browse)+'</span></button>';projectMenu.innerHTML=html;}
projectMenu.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='pmBrowse'){browseForRepo();return;}if(b.dataset.path)pickProject(b.dataset.path,b.dataset.name);});
function openProjectMenu(){projectMenu.classList.remove('hidden');chooseBtn.setAttribute('aria-expanded','true');}
chooseBtn.onclick=()=>{if(projectMenu.classList.contains('hidden'))openProjectMenu();else closeProjectMenu();};
dlg.addEventListener('mousedown',e=>{if(!e.target.closest('.field-wrap'))closeProjectMenu();});
// Keyboard on the project picker: ↑/↓ walk the options (opening the menu first when it's closed), Enter is the
// button's own default, Esc closes just the menu instead of the whole dialog. Focus IS the selection — the menu
// buttons highlight on :focus, so no separate index to keep in sync.
function moveProject(dir){const bs=[...projectMenu.querySelectorAll('button')];if(!bs.length)return;const i=bs.indexOf(document.activeElement);bs[i<0?(dir>0?0:bs.length-1):(i+dir+bs.length)%bs.length].focus();}
function projectKeys(e){if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;e.preventDefault();if(projectMenu.classList.contains('hidden'))openProjectMenu();moveProject(e.key==='ArrowDown'?1:-1);}
chooseBtn.addEventListener('keydown',projectKeys);projectMenu.addEventListener('keydown',projectKeys);
dlg.addEventListener('cancel',e=>{if(!projectMenu.classList.contains('hidden')){e.preventDefault();closeProjectMenu();chooseBtn.focus();}});
document.querySelector("#label").oninput=preview;
document.querySelector("#dlgClose").onclick=()=>{if(!creating)dlg.close()};
dlg.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();document.querySelector("#doCreate").click();}});
document.querySelector("#doCreate").onclick=async()=>{const btn=document.querySelector("#doCreate"),lbl=btn.querySelector('.dcl'),err=document.querySelector("#createError");if(creating)return;if(!document.querySelector("#repo").value){err.textContent=T.chooseFirst;return;}const wt=wtNew.checked;creating=true;btn.disabled=true;lbl.textContent=wt?T.creating:T.opening;err.textContent="";
const r=await window.kakapoHub.create(document.querySelector("#repo").value,document.querySelector("#label").value,wt,document.querySelector("#base").value);creating=false;btn.disabled=false;lbl.textContent=wt?T.create:T.open;if(r.ok)dlg.close();else err.textContent=r.error||T.createFailed};
const promptDlg=document.querySelector("#prompt"),promptInput=document.querySelector("#promptInput"),promptTitle=document.querySelector("#promptTitle");
function showPrompt(title,initial){return new Promise(resolve=>{promptTitle.textContent=title;promptInput.value=initial||'';const onClose=()=>{promptDlg.removeEventListener('close',onClose);resolve(promptDlg.returnValue==='ok'?promptInput.value:null);};promptDlg.addEventListener('close',onClose);promptDlg.showModal();setTimeout(()=>{promptInput.focus();promptInput.select();},0);});}
document.querySelector("#promptOk").onclick=()=>promptDlg.close('ok');
document.querySelector("#promptCancel").onclick=()=>promptDlg.close('cancel');
promptInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();promptDlg.close('ok');}else if(e.key==='Escape'){e.preventDefault();promptDlg.close('cancel');}});
// Disconnected-workspace dialog (folder gone) — a custom component. Reconnect runs the native folder picker in
// main (only it can); Remove forgets the saved entry; any close hides the overlay.
const discDlg=document.querySelector("#disc");let discPath='';
function showDisconnected(path){discPath=path||'';document.querySelector("#discPath").textContent=discPath;discDlg.showModal();setTimeout(()=>document.querySelector("#discReconnect").focus(),0);}
discDlg.addEventListener('close',()=>window.kakapoHub.closeModal());
document.querySelector("#discReconnect").onclick=async()=>{const p=discPath;discDlg.close();await window.kakapoHub.reconnectPick(p);};
document.querySelector("#discRemove").onclick=()=>{window.kakapoHub.forget(discPath);discDlg.close();};
document.querySelector("#discCancel").onclick=()=>discDlg.close();
// Generic confirm/alert built from a spec (title/message/detail/checkbox + button row). The last button is the
// primary/danger action; index 0 is the safe choice that Esc/backdrop resolves to. Every dismissal reports the
// chosen index (+ checkbox state) back to main via confirmResult exactly once; main hides the overlay + resolves.
const confirmDlg=document.querySelector("#confirm");let cfSent=false;
function showConfirm(spec){spec=spec||{};cfSent=false;
  const buttons=Array.isArray(spec.buttons)&&spec.buttons.length?spec.buttons:['OK'];
  const danger=spec.danger===true,defaultId=typeof spec.defaultId==='number'?spec.defaultId:0;
  document.querySelector("#cfTitle").textContent=spec.title||'';
  const msg=document.querySelector("#cfMsg");msg.textContent=spec.message||'';msg.classList.toggle('hidden',!spec.message);
  const det=document.querySelector("#cfDetail");det.textContent=spec.detail||'';det.classList.toggle('hidden',!spec.detail);
  document.querySelector("#cfIcon").classList.toggle('hidden',!danger);
  const ci=document.querySelector("#cfCheck");document.querySelector("#cfCheckWrap").classList.toggle('hidden',!spec.checkbox);ci.checked=spec.checked===true;document.querySelector("#cfCheckLabel").textContent=spec.checkbox||'';
  const acts=document.querySelector("#cfActions");acts.innerHTML='';
  buttons.forEach((label,i)=>{const b=document.createElement('button');b.className='cf-btn'+(i===buttons.length-1?(danger?' danger':' pri'):'');b.textContent=label;b.onclick=()=>{cfSent=true;window.kakapoHub.confirmResult({index:i,checked:ci.checked});confirmDlg.close();};acts.appendChild(b);});
  confirmDlg.showModal();setTimeout(()=>{const bs=acts.querySelectorAll('button');(bs[defaultId]||bs[0]).focus();},0);}
confirmDlg.addEventListener('close',()=>{if(!cfSent){cfSent=true;window.kakapoHub.confirmResult({index:0,checked:false});}});
// Main tells this overlay which dialog to open. Rename/memo resolve to a value, apply it, then hide the overlay.
window.kakapoHub.onModalOpen(d=>{d=d||{};
  if(d.type==='rename'){showPrompt(T.renameTitle,d.name||'').then(alias=>{if(alias!==null)window.kakapoHub.rename(d.id,alias);window.kakapoHub.closeModal();});}
  else if(d.type==='memo'){showPrompt(T.memoTitle,'').then(memo=>{if(memo!==null)window.kakapoHub.rename(d.id,undefined,memo);window.kakapoHub.closeModal();});}
  else if(d.type==='disconnected'){showDisconnected(d.path);}
  else if(d.type==='confirm'){showConfirm(d);}
  else openCreate(d.path,d.name);});
// Esc with no dialog open (e.g. the brief frame before showModal) still dismisses the overlay.
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.querySelector('dialog[open]'))window.kakapoHub.closeModal();});
</script>`;
}
