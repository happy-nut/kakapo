import { contextBridge, ipcRenderer } from "electron";

// Bridges the sandboxed renderer to the main process so .http requests can be
// executed without CORS or sandbox restrictions. Kept intentionally tiny: the
// renderer only ever asks main to perform a single fetch and return the result.
contextBridge.exposeInMainWorld("monacoriHttp", {
  send: (request: unknown): Promise<unknown> => ipcRenderer.invoke("monacori:http-send", request),
});

// Lets the Review menu's Cmd/Ctrl+Shift+/ and +. accelerators open the merged comment views in
// the renderer (the keys macOS would otherwise reserve for its Help search).
contextBridge.exposeInMainWorld("monacoriMenu", {
  onMergedView: (cb: (kind: string) => void): void => {
    ipcRenderer.on("monacori:merged-view", (_event, kind: string) => cb(kind));
  },
});

// Writes the full review prompt to .monacori/review-prompt.md so an agent can just read the file.
contextBridge.exposeInMainWorld("monacoriReview", {
  savePrompt: (markdown: string): Promise<string> => ipcRenderer.invoke("monacori:save-prompt", markdown),
});
