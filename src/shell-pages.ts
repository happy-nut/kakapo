// Browser-facing HTML for the main-process "chrome" windows: the workspace-rail shell page (hubHtml) and the
// tile context-menu popup (tileMenuHtml). Extracted from app-main.ts to keep that file focused on main-process
// orchestration. Pure string builders with no Electron imports, so they render/diff in isolation.
import { HUB_WIDTH, HUB_EXPANDED, TITLEBAR_H } from "./constants.js";

export function tileMenuHtml(resume: boolean, canDelete: boolean, light: boolean): string {
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
${item("activate", "Switch", "hl")}
${resume ? item("resume", "Resume session") : ""}
<div class="sep"></div>
${item("rename", "Rename…")}
${item("memo", "Edit memo…")}
${item("detach", "Open in new window")}
<div class="sep"></div>
${item("close", "Close workspace")}
${canDelete ? item("delete", "Delete worktree…", "danger") : ""}
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

export function hubHtml(light: boolean, appVersion: string): string {
  const bg = light ? "#f4f4f4" : "#252526", fg = light ? "#242424" : "#ddd", line = light ? "#d0d0d0" : "#454545";
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:${bg};color:${fg};font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{display:flex;flex-direction:column}
#titlebar{height:${TITLEBAR_H}px;flex:none;-webkit-app-region:drag;display:flex;align-items:center;gap:8px;padding:0 12px 0 84px;border-bottom:1px solid ${line};background:${light ? "#ececec" : "#1b1e25"}}
#wsname{-webkit-app-region:no-drag;display:flex;align-items:center;gap:7px;max-width:72%;font-weight:600;color:${fg};font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#wsname .wsdot{width:6px;height:6px;border-radius:50%;background:#4d9a51;flex:none}#wsname .rp{color:${light ? "#888" : "#7d828c"};font-weight:400}
.tb-spacer{flex:1;align-self:stretch}
#tools{-webkit-app-region:no-drag;display:flex;align-items:center;gap:2px;flex:none}
#tools .tb-sep{width:1px;height:16px;background:${line};margin:0 5px}
#tools button.tb{width:28px;height:26px;border:0;border-radius:6px;color:${light ? "#5f6470" : "#9aa0ab"};display:grid;place-items:center;padding:0;background:transparent}
#tools button.tb:hover{background:${light ? "#dfe7f5" : "#373d49"};color:${fg}}
#tools button.tb.active{color:#4d86d9;background:${light ? "#dfe7f5" : "#2a3446"}}
#tools button.tb.hidden{display:none!important}
#tools button.tb svg{width:17px;height:17px}
#hub{width:${HUB_WIDTH}px;flex:1;min-height:0;border-right:1px solid ${line};display:flex;flex-direction:column;align-items:center;gap:2px;overflow:hidden;transition:width 180ms cubic-bezier(.2,.8,.2,1)}
body.rail-exp #hub{width:${HUB_EXPANDED}px;align-items:stretch}
button{border:1px solid ${line};background:transparent;color:inherit;border-radius:6px;padding:4px 8px}
#list{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;width:100%}
.wt{position:relative;cursor:pointer;border:0;background:transparent;padding:0;font:inherit;color:inherit;text-align:left}
/* ---------- collapsed rail: one rounded block per project — a prominent avatar header (identity, shown once)
   over small 24px worktree initial badges, so the grouping reads and the avatar isn't repeated per worktree. --- */
.cv{flex:1;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 0;width:100%}
body.rail-exp .cv{display:none}
.grp{display:flex;flex-direction:column;align-items:center;gap:3px;width:44px;padding:5px 3px 6px;background:${light ? "#eaecef" : "#212327"};border-radius:12px}
.phav{position:relative;width:28px;height:28px;border-radius:8px;overflow:hidden;flex:none;cursor:pointer;display:grid;place-items:center;font-weight:700;font-size:12px;color:#0e1116}
.phav img{width:100%;height:100%;object-fit:cover;display:block}
.wts{display:flex;flex-direction:column;align-items:center;gap:3px;margin-top:1px}
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
/* ---------- expanded rail (⌘⇧E): Orca-style card panel — project header (avatar + name + count + chevron,
   click collapses the group) then a worktree card each (status dot + name + change tag + branch). ---------- */
/* Fixed width (not 100%) so the expanded content is laid out at full width from frame one and the #hub width
   animation just REVEALS it (overflow:hidden clips) instead of reflowing "Workspaces"/rows every frame. */
.ev{display:none;flex:1;min-height:0;flex-direction:column;width:${HUB_EXPANDED}px}
body.rail-exp .ev{display:flex}
.phead{display:flex;align-items:center;padding:5px 12px 7px;flex:none}
.phead .t{font-weight:650;font-size:12.5px;color:${fg};letter-spacing:.01em}
.plist{flex:1;overflow-y:auto;overflow-x:hidden;padding:0 6px 8px}
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
.ev .wt.running .dot,.ev .wt.busy .dot{background:#4cc38a;box-shadow:0 0 0 3px #4cc38a22}
.ev .wt.busy .dot{animation:dotpulse 1.3s ease-in-out infinite}
@keyframes dotpulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.ev .wt.busy .dot{animation:none}}
.wt-name{font-weight:600;font-size:12.5px;color:${fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.ev .wt.act .wt-name{color:#79a6ea}
.wt-tag{font-size:9.5px;font-weight:700;color:${light ? "#9aa0aa" : "#8b909a"};border:1px solid ${line};border-radius:5px;padding:1px 5px;flex:none;font-variant-numeric:tabular-nums}
.wt-branch{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:${light ? "#9aa0aa" : "#666b73"};margin:3px 0 0 16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#railfoot{display:flex;flex-direction:column;align-items:center;gap:5px;padding:7px 0;border-top:1px solid ${line};width:100%;flex:none}
body.rail-exp #railfoot{flex-direction:row;justify-content:flex-end;padding:7px 6px;gap:4px}
#railfoot button{width:34px;height:32px;border:0;border-radius:8px;font-size:17px;color:${light ? "#666" : "#999"};display:grid;place-items:center;padding:0}
#railfoot button:hover{background:${light ? "#dfe7f5" : "#373d49"};color:${fg}}
#pin svg{width:16px;height:16px;transition:transform 180ms cubic-bezier(.2,.8,.2,1)}
body.rail-exp #pin svg{transform:rotate(180deg)}
body.rail-exp #pin{color:#4d86d9}
#railfoot #new{border:1px dashed ${line}}
.context-menu{position:fixed;z-index:20;width:172px;padding:5px;background:${bg};border:1px solid ${line};border-radius:8px;box-shadow:0 12px 30px #0008}
.context-menu button{display:block;width:100%;border:0;text-align:left;padding:7px 9px}.context-menu button:hover{background:${light ? "#dfe7f5" : "#373d49"}}.context-menu .danger{color:#df6868}.hidden{display:none!important}</style>
<div id="titlebar"><span id="wsname"></span><span class="tb-spacer"></span><div id="tools"><button class="tb" data-act="changes" title="Changes (⌘0)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><line x1="3.5" y1="12" x2="8.8" y2="12"/><line x1="15.2" y1="12" x2="20.5" y2="12"/></svg></button><button class="tb" data-act="files" title="Files (⌘1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5C4 6.7 4.7 6 5.5 6h3.2c.5 0 .9.2 1.2.6L11 8h7.3c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5h-13C4.7 19 4 18.3 4 17.5z"/></svg></button><span class="tb-sep"></span><button class="tb hidden" data-act="terminal" title="Terminal (⌃\`)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7l4 5-4 5"/><path d="M13 17h6"/></svg></button><button class="tb" data-act="history" title="History (⌘9)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.3"/><path d="M12 7.4v5l3.2 1.9"/></svg></button><button class="tb" data-act="more" title="More review tools"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></button></div></div><main id="hub"><section id="list"></section><div id="railfoot"><button id="pin" title="Expand workspace rail (⌘⇧E)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6l6 6-6 6"/><path d="M13 6l6 6-6 6"/></svg></button><button id="new" title="New workspace (⌘N)">＋</button><button id="settings" title="Settings — v${appVersion}">⚙</button></div></main>
<script>
const list=document.querySelector("#list"),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
document.querySelector("#new").onclick=()=>window.kakapoHub.openModal('new');
document.querySelector("#settings").onclick=()=>window.kakapoHub.settings();
const tools=document.getElementById('tools');
tools.addEventListener('click',e=>{const b=e.target.closest('button.tb');if(!b)return;window.kakapoHub.railAction(b.dataset.act)});
window.kakapoHub.onRailState(s=>{s=s||{};const active=s.active||[];for(const b of tools.querySelectorAll('button.tb')){const a=b.dataset.act;if(a==='terminal'){b.classList.toggle('hidden',!s.terminal);}b.classList.toggle('active',active.indexOf(a)>=0);}});
window.kakapoHub.onToggle(open=>document.body.classList.toggle('closed',!open));window.kakapoHub.onNew(()=>window.kakapoHub.openModal('new'));
// Rail expand: ⌘⇧E or the » button toggles it open; main then pushes the review views right (they render over
// the shell page, so the rail can't overlay them) and collapses the active view's file tree to make room.
let railExp=false;const pinBtn=document.getElementById('pin');
// Visual state only. Main owns keyboard focus: it focuses the rail while expanded (so arrows/Enter navigate
// workspaces) and returns focus to the review view when it collapses.
function paintRail(){document.body.classList.toggle('rail-exp',railExp);}
// User action (⌘⇧E / the » pin): flip and tell main, which animates the view push, collapses the file tree, and
// moves focus onto the rail.
function toggleRail(){railExp=!railExp;paintRail();window.kakapoHub.setHubExpanded(railExp);if(railExp)initRailSel();else railClearSel();}
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
  // While expanded the shell holds keyboard focus, so review shortcuts (Changes/Files/History/Terminal) never reach the review view.
  // Collapse the rail (which returns focus to the review) and forward the tool action, so e.g. ⌘1 still opens Files.
  let fwd=null;
  if(e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey&&e.key==='0')fwd='changes';
  else if(e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey&&e.key==='1')fwd='files';
  else if(e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey&&e.key==='9')fwd='history';
  else if(e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey&&e.code==='Backquote')fwd='terminal';
  if(fwd){e.preventDefault();toggleRail();window.kakapoHub.railAction(fwd+':open');return;}
  if(e.key==='ArrowDown'){e.preventDefault();railSelect(railSel<0?0:railSel+1);}
  else if(e.key==='ArrowUp'){e.preventDefault();railSelect(railSel<0?0:railSel-1);}
  else if(e.key==='Enter'){const t=railTiles();if(railSel>=0&&t[railSel]){e.preventDefault();t[railSel].click();}}
  // Rename (E) / delete (⌫). Match on e.code (the physical key) not e.key: under a Korean/other IME the 'e' key
  // emits a composed jamo rather than 'e', so an e.key==='e' test never fired with Hangul input active.
  else if(e.code==='KeyE'&&!e.metaKey&&!e.ctrlKey&&!e.altKey){const t=railTiles();const el=railSel>=0?t[railSel]:null;if(el&&el.dataset.disconnected!=='true'&&el.dataset.closed!=='true'){e.preventDefault();window.kakapoHub.openModal('rename',{id:Number(el.dataset.id),name:el.dataset.name||''});}}
  // ⌫/Delete opens the same delete-confirm flow as the tile menu's "Delete worktree…". A disconnected tile has no
  // worktree to remove, so it routes to the reconnect/forget dialog; the main checkout can't be deleted (the
  // context menu hides Delete for it), so leave it alone.
  else if(e.key==='Backspace'||e.key==='Delete'){const t=railTiles();const el=railSel>=0?t[railSel]:null;if(el){e.preventDefault();if(el.dataset.disconnected==='true')window.kakapoHub.openModal('disconnected',{path:decodeURIComponent(el.dataset.path)});else if(el.dataset.kind!=='main')removeWorkspace(Number(el.dataset.id));}}
});
pinBtn.onclick=toggleRail;
window.kakapoHub.onToggleExpand(toggleRail);
// Main collapses the rail (visual only, no echo) when focus returns to the review view — clicking back into the
// "main window" dismisses the peek.
window.kakapoHub.onSetExpanded(open=>{railExp=!!open;paintRail();if(!railExp)railClearSel();});
const ago=value=>{const seconds=Math.max(0,Math.floor((Date.now()-Number(value||Date.now()))/1000));return seconds<60?'now':seconds<3600?Math.floor(seconds/60)+'m ago':seconds<86400?Math.floor(seconds/3600)+'h ago':Math.floor(seconds/86400)+'d ago'};
window.kakapoHub.onState(items=>{const groups=new Map;for(const w of items){if(!groups.has(w.repoName))groups.set(w.repoName,[]);groups.get(w.repoName).push(w)}
const _a=items.find(w=>w.active);const _wn=document.getElementById('wsname');if(_wn)_wn.innerHTML=_a?'<span class="wsdot"></span>'+esc(_a.alias||_a.branch)+' <span class="rp">· '+esc(_a.repoName)+'</span>':'';
// Badge initials. Split on separators only (NOT on every non-Latin char) so Korean/CJK names keep their
// letters instead of collapsing to "?". Latin → uppercased two-word/two-letter initials; CJK → the first one
// or two characters as-is (Hangul has no case).
const initials=w=>{var s=String(w.alias||w.branch||w.repoName||'?').replace(/^(feature|fix|chore|bugfix|hotfix|release)[\\/_-]/i,'').trim();if(!s)return'?';var parts=s.split(/[\\s._/-]+/).filter(Boolean);var a=parts[0]||s,ac=Array.from(a),latin=/^[A-Za-z0-9]/.test(a),r;if(parts.length>1){var bc=Array.from(parts[1]);r=(ac[0]||'')+(bc[0]||'');}else{r=ac.slice(0,2).join('');}return latin?r.toUpperCase():r;};
const tip=w=>(w.alias||w.branch)+' · '+w.repoName+(w.dirtyCount?' · '+w.dirtyCount+' changed':'')+(w.running?' · ● running':w.resume?' · resumable':w.disconnected?' · disconnected':'');
// Stable per-project hue (all worktrees share it) — tints the collapsed group's accent bar + avatar
// placeholder and the expanded panel's project badge, so projects read apart at a glance.
const projHue=n=>{let h=0;const s=String(n||'');for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return h%360;};
// Shared per-worktree bits: state classes and the data-* every click/activate/context-menu handler reads.
const wcls=w=>(w.active?' act':'')+(w.disconnected?' disc':'')+(w.busy?' busy':'')+(w.running?' running':'')+(w.unread?' attn':'');
const wattr=w=>' data-id="'+w.id+'" data-path="'+encodeURIComponent(w.path)+'" data-name="'+esc(w.alias||w.branch)+'" data-disconnected="'+!!w.disconnected+'" data-closed="'+!!w.closed+'" data-resume="'+(w.resume&&!w.running?'1':'')+'" data-kind="'+esc(w.kind||'')+'" title="'+esc(tip(w))+'"';
const grpAvatar=ws=>{for(const w of ws)if(w.avatar)return w.avatar;return null;};
const projMark=repo=>{const a=Array.from(String(repo||'?').trim());const c=a[0]||'?';return /[A-Za-z0-9]/.test(c)?c.toUpperCase():c;};
const avInner=(ws,repo)=>{const av=grpAvatar(ws);return av?'<img src="'+av+'" alt="">':esc(projMark(repo));};
const avStyle=(ws,repo)=>grpAvatar(ws)?'':' style="background:hsl('+projHue(repo)+',44%,60%)"';
const chev='<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>';
const homeIco='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.1 3.3 10a.6.6 0 0 0 .38 1.06H5v8.4c0 .3.24.54.54.54H9.6v-5.2h4.8v5.2h4.06c.3 0 .54-.24.54-.54v-8.4h1.32A.6.6 0 0 0 20.7 10z"/></svg>';
const isMain=w=>w.kind==='main';
const cv='<div class="cv">'+[...groups].map(([repo,ws])=>'<div class="grp"><div class="phav" data-repo="'+esc(repo)+'" title="'+esc(repo)+'"'+avStyle(ws,repo)+'>'+avInner(ws,repo)+'</div><div class="wts">'+ws.map(w=>'<button class="wt'+wcls(w)+'"'+wattr(w)+'>'+esc(initials(w))+'<span class="rdot"></span><span class="udot"></span>'+(isMain(w)?'<span class="mdot" title="Main worktree">'+homeIco+'</span>':'')+'</button>').join('')+'</div></div>').join('')+'</div>';
const ev='<div class="ev"><div class="phead"><span class="t">Workspaces</span></div><div class="plist">'+[...groups].map(([repo,ws])=>'<div class="proj"><div class="prow" data-repo="'+esc(repo)+'"><span class="pav"'+avStyle(ws,repo)+'>'+avInner(ws,repo)+'</span><span class="pname">'+esc(repo)+'</span><span class="pcount">'+ws.length+'</span>'+chev+'</div><div class="ewts">'+ws.map(w=>{const nm=esc(w.alias||w.branch);const showBr=w.branch&&(!w.alias||w.branch!==w.alias);const brLine=showBr?'<div class="wt-branch">'+esc(w.branch)+'</div>':'';const tag=w.dirtyCount?'<span class="wt-tag">'+w.dirtyCount+'</span>':'';const home=isMain(w)?'<span class="wt-home" title="Main worktree">'+homeIco+'</span>':'';return '<button class="wt'+wcls(w)+'"'+wattr(w)+'><div class="wt-top"><span class="dot"></span><span class="wt-name">'+nm+'</span>'+home+tag+'</div>'+brLine+'</button>';}).join('')+'</div></div>').join('')+'</div></div>';
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
window.kakapoHub.onTileAction(d=>{const id=d.id,name=d.name||'';const action=d.action;if(action==='rename'){window.kakapoHub.openModal('rename',{id,name});}else if(action==='memo'){window.kakapoHub.openModal('memo',{id,name});}else if(action==='activate')window.kakapoHub.activate(id);else if(action==='resume')window.kakapoHub.resume(id);else if(action==='detach')window.kakapoHub.detach(id);else if(action==='close')window.kakapoHub.remove(id,'close');else if(action==='delete')removeWorkspace(id);});
async function removeWorkspace(id){const delBranch=confirm('Also delete the local branch?\\nOK deletes it; Cancel keeps it.');let r=await window.kakapoHub.remove(id,'delete',false,delBranch);if(r.needsConfirmation){const x=r.risk;if(confirm('Delete worktree?'+(x.dirty?'\\n• uncommitted changes':'')+(x.unpushed?'\\n• '+x.unpushed+' unpushed commits':'')+(x.runningProcesses?'\\n• running terminal/agent':'')+'\\n\\nThis cannot be undone.'))r=await window.kakapoHub.remove(id,'delete',true,delBranch)}if(!r.ok&&!r.needsConfirmation)alert(r.error||'Delete failed')}
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
export function modalOverlayHtml(light: boolean): string {
  const fg = light ? "#242424" : "#ddd", line = light ? "#d0d0d0" : "#454545";
  const dim = "rgba(0,0,0,.45)";
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
#create .pmenu button:hover,#create .pmenu button.on{background:${light ? "#eef1f6" : "#33383f"}}
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
#disc .disc-btn:focus-visible{outline:none;box-shadow:0 0 0 3px #4d86d955}</style>
<dialog id="create"><div class="dh"><b>New workspace</b><button class="dx" id="dlgClose" aria-label="Close">✕</button></div><div class="db"><label>Project</label><div class="field-wrap"><button id="choose" class="field" aria-haspopup="listbox" aria-expanded="false"><span class="fi"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5C4 6.7 4.7 6 5.5 6h3.2c.5 0 .9.2 1.2.6L11 8h7.3c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5h-13C4.7 19 4 18.3 4 17.5z"/></svg></span><span id="repoName" class="fv ph">Select a project…</span><span class="fc"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span></button><div id="projectMenu" class="pmenu hidden" role="listbox"></div></div><input type="hidden" id="repo"><label>Task name</label><input id="label" class="tin" placeholder="e.g. fix-login-crash" autocomplete="off" spellcheck="false"><div id="preview"></div><div class="error" id="createError"></div><div class="actions"><button id="cancelCreate" class="dbtn">Cancel</button><button id="doCreate" class="dbtn pri"><span class="dcl">Fetch &amp; create</span><kbd>⌘↵</kbd></button></div></div></dialog>
<dialog id="prompt"><div class="dh"><b id="promptTitle"></b></div><div class="db"><input id="promptInput" class="tin" autocomplete="off" spellcheck="false"><div class="actions"><button id="promptCancel" class="dbtn">Cancel</button><button id="promptOk" class="dbtn pri">OK</button></div></div></dialog>
<dialog id="disc"><div class="disc-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></div><div class="disc-msg">This workspace's folder is no longer on disk.</div><div id="discPath" class="disc-path"></div><div class="disc-actions"><button id="discReconnect" class="disc-btn pri">Reconnect…</button><button id="discRemove" class="disc-btn">Remove from List</button><button id="discCancel" class="disc-btn">Cancel</button></div></dialog><script>
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dlg=document.querySelector("#create");let creating=false;
// Each open starts clean (the overlay page persists across opens, so stale repo/label would otherwise linger).
function openCreate(){document.querySelector("#repo").value='';const n=document.querySelector("#repoName");n.textContent='Select a project…';n.classList.add('ph');document.querySelector("#label").value='';document.querySelector("#preview").innerHTML='';document.querySelector("#createError").textContent='';loadProjects();closeProjectMenu();dlg.showModal();setTimeout(()=>document.querySelector("#choose").focus(),0);}
// Any close of the create dialog (cancel / ✕ / Esc / success) tells main to hide the overlay.
dlg.addEventListener('close',()=>window.kakapoHub.closeModal());
document.querySelector("#cancelCreate").onclick=()=>{if(creating)window.kakapoHub.cancelCreate();else dlg.close()};
async function preview(){const r=await window.kakapoHub.preview(document.querySelector("#repo").value,document.querySelector("#label").value);document.querySelector("#preview").innerHTML=r.ok?'slug: '+esc(r.slug)+'<br>base: '+esc(r.base)+'<br>branch: '+esc(r.branch)+'<br>'+esc(r.path):''}
const projectMenu=document.querySelector("#projectMenu"),chooseBtn=document.querySelector("#choose");
function closeProjectMenu(){projectMenu.classList.add('hidden');chooseBtn.setAttribute('aria-expanded','false');}
function pickProject(path,name){document.querySelector("#repo").value=path;const n=document.querySelector("#repoName");n.textContent=name||(path.split('/').filter(Boolean).pop()||path);n.classList.remove('ph');closeProjectMenu();preview();document.querySelector("#label").focus();}
async function browseForRepo(){closeProjectMenu();const r=await window.kakapoHub.chooseRepo();if(r.ok)pickProject(r.repo);}
const _pmFolder='<span class="pm-ic"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5C4 6.7 4.7 6 5.5 6h3.2c.5 0 .9.2 1.2.6L11 8h7.3c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5h-13C4.7 19 4 18.3 4 17.5z"/></svg></span>';
async function loadProjects(){let ps=[];try{ps=await window.kakapoHub.listProjects();}catch(e){}if(!Array.isArray(ps))ps=[];let html='';for(const p of ps)html+='<button type="button" role="option" data-path="'+esc(p.path)+'" data-name="'+esc(p.name)+'">'+_pmFolder+'<span class="pm-name">'+esc(p.name)+'</span><span class="pm-path">'+esc(p.path)+'</span></button>';if(ps.length)html+='<div class="pm-sep"></div>';html+='<button type="button" id="pmBrowse" class="pm-browse"><span class="pm-ic"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span><span class="pm-name">Browse for a folder…</span></button>';projectMenu.innerHTML=html;}
projectMenu.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='pmBrowse'){browseForRepo();return;}if(b.dataset.path)pickProject(b.dataset.path,b.dataset.name);});
chooseBtn.onclick=()=>{const willOpen=projectMenu.classList.contains('hidden');projectMenu.classList.toggle('hidden',!willOpen);chooseBtn.setAttribute('aria-expanded',String(willOpen));};
dlg.addEventListener('mousedown',e=>{if(!e.target.closest('.field-wrap'))closeProjectMenu();});
document.querySelector("#label").oninput=preview;
document.querySelector("#dlgClose").onclick=()=>{if(!creating)dlg.close()};
dlg.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();document.querySelector("#doCreate").click();}});
document.querySelector("#doCreate").onclick=async()=>{const btn=document.querySelector("#doCreate"),lbl=btn.querySelector('.dcl'),err=document.querySelector("#createError");if(creating)return;if(!document.querySelector("#repo").value){err.textContent="Choose a repository first.";return;}creating=true;btn.disabled=true;lbl.textContent="Fetching base…";err.textContent="";
const r=await window.kakapoHub.create(document.querySelector("#repo").value,document.querySelector("#label").value);creating=false;btn.disabled=false;lbl.textContent="Fetch & create";if(r.ok)dlg.close();else err.textContent=r.error||"Could not create workspace"};
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
// Main tells this overlay which dialog to open. Rename/memo resolve to a value, apply it, then hide the overlay.
window.kakapoHub.onModalOpen(d=>{d=d||{};
  if(d.type==='rename'){showPrompt('Rename workspace',d.name||'').then(alias=>{if(alias!==null)window.kakapoHub.rename(d.id,alias);window.kakapoHub.closeModal();});}
  else if(d.type==='memo'){showPrompt('One-line memo','').then(memo=>{if(memo!==null)window.kakapoHub.rename(d.id,undefined,memo);window.kakapoHub.closeModal();});}
  else if(d.type==='disconnected'){showDisconnected(d.path);}
  else openCreate();});
// Esc with no dialog open (e.g. the brief frame before showModal) still dismisses the overlay.
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.querySelector('dialog[open]'))window.kakapoHub.closeModal();});
</script>`;
}
