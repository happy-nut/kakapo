import type { WebSocketSendRequest, WebSocketSendResult, WebSocketTranscriptEntry } from "./types.js";
import { errorMessage } from "./util.js";

// `WEBSOCKET ws://…` from a .http file, run as the script it is: send the messages the file lists, in
// order, waiting for the server where the file says to, and hand back the transcript.
//
// No dependency: Node 22 ships a WebSocket client, which is the whole reason this is portable at all —
// kakapo's CLI carries no runtime dependencies it does not have a review reason for (AGENTS.md), and a
// protocol stack would be exactly that. (gRPC stays out for the same reason: it needs protobuf.)
//
// What this is NOT is IntelliJ's interactive console, where you keep typing messages into a live socket.
// A request in a reviewed file is a script with an end, and the end is what a reviewer reads.

const DEFAULT_IDLE_MS = 3_000;
const DEFAULT_TOTAL_MS = 30_000;
const MAX_TRANSCRIPT = 500;
const MAX_MESSAGE_CHARS = 64 * 1024;

/** Only ws(s) — a .http file's WEBSOCKET line names a socket, and anything else is a different request. */
function socketUrl(value: string): URL | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  return url.protocol === "ws:" || url.protocol === "wss:" ? url : undefined;
}

const clip = (text: string): string =>
  text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}… (truncated)` : text;

export async function performWebSocketRequest(request: WebSocketSendRequest): Promise<WebSocketSendResult> {
  const startedAt = Date.now();
  const url = socketUrl(request.url);
  if (!url) {
    return {
      ok: false,
      transcript: [],
      durationMs: 0,
      error: `unsupported WebSocket URL scheme: ${request.url?.split(":")[0] || "(unparseable)"}`,
    };
  }
  const transcript: WebSocketTranscriptEntry[] = [];
  const record = (entry: WebSocketTranscriptEntry): void => {
    if (transcript.length < MAX_TRANSCRIPT) transcript.push(entry);
  };
  const totalMs = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : DEFAULT_TOTAL_MS;
  const idleMs = Number(request.idleMs) > 0 ? Number(request.idleMs) : DEFAULT_IDLE_MS;

  return await new Promise<WebSocketSendResult>((resolve) => {
    let socket: WebSocket;
    try {
      // Headers cannot be set on a browser-shaped WebSocket; the subprotocol can, and that is what a .http
      // file's `Sec-WebSocket-Protocol` is for. Anything else it lists is reported as not sent rather than
      // dropped silently.
      socket = new WebSocket(url.href, request.protocols ?? []);
    } catch (error) {
      resolve({ ok: false, transcript, durationMs: Date.now() - startedAt, error: errorMessage(error) });
      return;
    }
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let waitingForServer: (() => void) | undefined;
    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      try { socket.close(); } catch { /* already closing */ }
      resolve({ ok: !error, transcript, durationMs: Date.now() - startedAt, error });
    };
    const totalTimer = setTimeout(() => finish(`timed out after ${totalMs} ms`), totalMs);
    totalTimer.unref?.();
    // Nothing more arriving is how a request-shaped WebSocket exchange ends: the file has sent everything
    // it had to send, and the server has gone quiet.
    const restartIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), idleMs);
      idleTimer.unref?.();
    };

    socket.addEventListener("message", (event: MessageEvent) => {
      const data = typeof event.data === "string" ? event.data : "(binary frame)";
      record({ direction: "in", text: clip(data), at: Date.now() - startedAt });
      const waiter = waitingForServer;
      waitingForServer = undefined;
      if (waiter) waiter();
      restartIdle();
    });
    socket.addEventListener("error", () => finish("the WebSocket connection failed"));
    socket.addEventListener("close", (event: CloseEvent) => {
      record({ direction: "close", text: `${event.code}${event.reason ? ` ${event.reason}` : ""}`, at: Date.now() - startedAt });
      finish();
    });
    socket.addEventListener("open", () => {
      record({ direction: "open", text: url.href, at: Date.now() - startedAt });
      void (async () => {
        for (const message of request.messages ?? []) {
          if (settled) return;
          if (message.waitForServer) {
            // `=== wait-for-server`: hold here until the server says something (or the whole request
            // times out), so a protocol with a handshake can be written down in the order it happens.
            await new Promise<void>((continueAfterServer) => { waitingForServer = continueAfterServer; });
            if (settled) return;
          }
          if (typeof message.text !== "string" || !message.text.length) continue;
          try {
            socket.send(message.text);
            record({ direction: "out", text: clip(message.text), at: Date.now() - startedAt });
          } catch (error) {
            finish(errorMessage(error));
            return;
          }
        }
        restartIdle();
      })();
    });
  });
}
