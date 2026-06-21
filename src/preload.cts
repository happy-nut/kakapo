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

// Phase 2 lazy-LOAD: fetch a single file's diff body from the main process on demand, so the initial
// HTML can omit the embedded diff bodies (tens of MB on big repos) and stay small.
contextBridge.exposeInMainWorld("monacoriFile", {
  get: (index: number, kind: string): Promise<string> => ipcRenderer.invoke("monacori:get-file", { index, kind }),
  getSourceData: (): Promise<string> => ipcRenderer.invoke("monacori:get-source-data"),
});
