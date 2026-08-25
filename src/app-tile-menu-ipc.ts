import { BrowserWindow, screen, type IpcMain } from "electron";
import { tileMenuHtml } from "./shell-pages.js";

// The workspace rail's tile context menu: a frameless popup window sized to its reported content, positioned
// at the cursor, and dismissed on choose / blur / Escape / click-outside. Only one is open at a time, so its
// state lives in this closure. Extracted from app-main to keep the god-file's window orchestration focused; it
// needs only the shell window (its parent + the tile-action target) and the current theme.
type TileMenuDeps = {
  getShellWindow: () => BrowserWindow | undefined;
  isLightTheme: () => boolean;
  // Translator bound to the current locale; read at open time so the popup always renders in the active language.
  getTranslate: () => (key: string, vars?: Record<string, string | number>) => string;
};

export function registerTileMenuIpc(ipc: IpcMain, deps: TileMenuDeps): void {
  let tileMenuWindow: BrowserWindow | undefined;
  let tileMenuTarget: { id: number; name: string; path: string } | undefined;
  let tileMenuAnchor: { x: number; y: number } | undefined;
  let tileMenuShown = false;
  const close = (): void => {
    const win = tileMenuWindow;
    tileMenuWindow = undefined; tileMenuTarget = undefined; tileMenuAnchor = undefined; tileMenuShown = false;
    if (win && !win.isDestroyed()) win.close();
  };

  ipc.on("kakapo:tile-menu", (_event, info: { id?: unknown; name?: unknown; resume?: unknown; kind?: unknown; path?: unknown; closed?: unknown }) => {
    const shellWindow = deps.getShellWindow();
    if (!shellWindow || shellWindow.isDestroyed()) return;
    const id = Number(info?.id);
    if (!Number.isFinite(id)) return;
    close();
    tileMenuTarget = { id, name: typeof info?.name === "string" ? info.name : "", path: typeof info?.path === "string" ? info.path : "" };
    tileMenuAnchor = screen.getCursorScreenPoint();
    const win = new BrowserWindow({
      width: 248, height: 220, show: false, frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
      parent: shellWindow, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    tileMenuWindow = win;
    win.on("blur", () => { if (tileMenuWindow === win && tileMenuShown) close(); });
    win.on("closed", () => { if (tileMenuWindow === win) { tileMenuWindow = undefined; tileMenuTarget = undefined; tileMenuAnchor = undefined; tileMenuShown = false; } });
    void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(tileMenuHtml(Boolean(info?.resume), info?.kind !== "main", deps.isLightTheme(), deps.getTranslate(), Boolean(info?.closed))));
  });

  ipc.on("kakapo:menu-size", (event, size: { w?: unknown; h?: unknown }) => {
    const win = tileMenuWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents || !tileMenuAnchor) return;
    const w = Math.max(80, Math.min(640, Math.ceil(Number(size?.w) || 248)));
    const h = Math.max(48, Math.min(900, Math.ceil(Number(size?.h) || 220)));
    const wa = screen.getDisplayNearestPoint(tileMenuAnchor).workArea;
    let x = tileMenuAnchor.x - 14, y = tileMenuAnchor.y - 14;
    if (x + w > wa.x + wa.width) x = wa.x + wa.width - w;
    if (y + h > wa.y + wa.height) y = wa.y + wa.height - h;
    x = Math.max(wa.x, x); y = Math.max(wa.y, y);
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
    if (!tileMenuShown) { tileMenuShown = true; win.show(); win.focus(); }
  });

  ipc.on("kakapo:menu-choose", (event, action: unknown) => {
    const win = tileMenuWindow;
    if (!win || event.sender !== win.webContents) return;
    const target = tileMenuTarget;
    close();
    const shellWindow = deps.getShellWindow();
    if (target && shellWindow && !shellWindow.isDestroyed() && typeof action === "string")
      shellWindow.webContents.send("kakapo:tile-action", { id: target.id, action, name: target.name, path: target.path });
  });

  ipc.on("kakapo:menu-close", (event) => {
    if (tileMenuWindow && event.sender === tileMenuWindow.webContents) close();
  });
}
