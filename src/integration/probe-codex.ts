import WebSocket from "ws";
import { isAbsolute } from "node:path";

type Thread = { id: string; cwd?: string; status: { type: string } };
type LoadedPage = { data: string[]; nextCursor: string | null };
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Reads metadata from an existing server. Never creates or resumes a thread. */
export async function probeCodex(options: {
  socketPath: string;
  threadId: string;
  timeoutMs?: number;
}) {
  const { socketPath, threadId, timeoutMs = 10000 } = options;
  if (!threadId.trim())
    throw new Error("An explicit original thread ID is required.");
  if (!isAbsolute(socketPath) || /[:?#]/.test(socketPath))
    throw new Error(
      "An absolute Unix socket path without URL delimiters is required.",
    );
  const ws = new WebSocket(`ws+unix://${socketPath}:/`, {
    maxPayload: 1024 * 1024,
    handshakeTimeout: timeoutMs,
  });
  let nextId = 0;
  let failure: Error | undefined;
  const pending = new Map<number, Pending>();
  const fail = (error: Error) => {
    failure = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  ws.on("error", fail);
  ws.on("close", () => fail(new Error("Codex connection closed.")));
  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error)
        item.reject(
          new Error(`${message.error.code}: ${message.error.message}`),
        );
      else item.resolve(message.result);
    } catch {
      fail(new Error("Malformed Codex protocol response."));
      ws.terminate();
    }
  });
  const request = <T>(method: string, params: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: timeout`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) fail(error);
      });
    });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("close", () =>
        reject(new Error("Codex closed before handshake.")),
      );
    });
    await request("initialize", {
      clientInfo: { name: "humanizer2_probe", version: "0.0.1" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    ws.send(JSON.stringify({ method: "initialized" }));
    const { thread } = await request<{ thread: Thread }>("thread/read", {
      threadId,
    });
    if (thread.id !== threadId)
      throw new Error("Server returned a different thread.");
    let loaded = false;
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page: LoadedPage = await request("thread/loaded/list", {
        cursor,
        limit: 100,
      });
      loaded = page.data.includes(threadId);
      cursor = page.nextCursor;
      if (loaded || !cursor) break;
      if (cursors.has(cursor)) throw new Error("Repeated pagination cursor.");
      cursors.add(cursor);
      if (pageNumber === 99)
        throw new Error("Loaded-thread pagination limit reached.");
    }
    return {
      status: loaded ? "live-thread-candidate" : "blocked-not-loaded",
      transport: "existing-app-server-unix-websocket",
      sameStoredThread: true,
      loadedOnConnectedServer: loaded,
      cwd: thread.cwd,
      runtimeStatus: thread.status,
      readOnly: true,
      roundTripVerified: false,
      gatePassed: false,
    };
  } finally {
    fail(new Error("Probe finished."));
    ws.terminate();
  }
}
