import WebSocket from "ws";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Workspace } from "../../server/workspace.ts";

// Persistence-only reader. Never resumes chats, sends turns, or deletes host data.
export async function readHostThreads(
  socketPath: string,
): Promise<Set<string>> {
  const ws = new WebSocket(`ws+unix://${socketPath}:/`, {
    handshakeTimeout: 5000,
  });
  const pending = new Map<
    number,
    { resolve: (x: any) => void; reject: (e: Error) => void }
  >();
  let sequence = 0;
  const abort = (e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  ws.on("error", abort);
  ws.on("close", () => abort(Error("Host disconnected")));
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
      }
    } catch {
      abort(Error("Invalid host response"));
    }
  });
  const deadline = setTimeout(() => {
    abort(Error("Host snapshot timed out"));
    ws.terminate();
  }, 15000);
  const request = (method: string, params: any): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("close", () => reject(Error("Host disconnected")));
    });
    await request("initialize", {
      clientInfo: { name: "humanizer2_lifecycle", version: "0.1.3" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    ws.send(JSON.stringify({ method: "initialized" }));
    const ids = new Set<string>();
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const page = await request("thread/list", {
          archived,
          cursor,
          limit: 100,
          modelProviders: [],
          sourceKinds: [
            "cli",
            "vscode",
            "exec",
            "appServer",
            "subAgent",
            "subAgentReview",
            "subAgentCompact",
            "subAgentThreadSpawn",
            "subAgentOther",
            "unknown",
          ],
        });
        if (
          !Array.isArray(page.data) ||
          !(page.nextCursor === null || typeof page.nextCursor === "string")
        )
          throw Error("Incomplete host snapshot");
        for (const t of page.data) {
          if (typeof t.id !== "string") throw Error("Invalid host thread");
          ids.add(t.id);
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw Error("Repeated host cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    return ids;
  } finally {
    clearTimeout(deadline);
    ws.terminate();
  }
}
export function startLifecycleSync(workspace: Workspace) {
  let busy = false;
  const missing = new Map<string, number>();
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      workspace.reconcileHostThreads(
        await readHostThreads(
          process.env.HUMANIZER2_CODEX_SOCKET ||
            join(
              process.env.CODEX_HOME || join(homedir(), ".codex"),
              "app-server-control/app-server-control.sock",
            ),
        ),
        missing,
      );
    } catch {
      missing.clear(); /* An unavailable host is never evidence of deletion. */
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 15000);
  void tick();
  return () => clearInterval(timer);
}
