type RepaintableWindow = {
  isDestroyed(): boolean;
  on(event: "resize" | "maximize" | "unmaximize" | "enter-full-screen" | "leave-full-screen", listener: () => void): unknown;
  webContents: {
    isDestroyed(): boolean;
    invalidate(): void;
  };
};

// macOS grows the native hiddenInset window before Chromium has necessarily painted the new content
// bounds. A large diff can keep the renderer busy while that happens, leaving a strip of the BrowserWindow
// background visible at the right edge. Coalesce native resize events and request one full-surface repaint
// after the final bounds have settled. This does no DOM work and therefore stays cheap during live resize.
export function installWindowSurfaceRecovery(window: RepaintableWindow, delayMs = 180): () => void {
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  const schedule = (): void => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.invalidate();
      }
    }, delayMs);
  };
  (["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const)
    .forEach((event) => window.on(event, schedule));
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}
