type RepaintableWindow = {
  isDestroyed(): boolean;
  on(event: "resize" | "maximize" | "unmaximize" | "enter-full-screen" | "leave-full-screen", listener: () => void): unknown;
  webContents: {
    isDestroyed(): boolean;
    invalidate(): void;
  };
};

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
