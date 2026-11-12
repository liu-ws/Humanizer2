import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { probeCodex } from "../src/integration/probe-codex.ts";

async function fixture(
  t: TestContext,
  options: {
    loaded?: boolean;
    paginate?: boolean;
    wrongThread?: boolean;
    closeOnRead?: boolean;
    silent?: boolean;
    rpcError?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "h2-probe-"));
  const socketPath = join(dir, "server.sock");
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const methods: string[] = [];
  wss.on("connection", (ws) =>
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      methods.push(message.method);
      if (message.method === "initialized" || options.silent) return;
      if (message.method === "thread/read" && options.closeOnRead) {
        ws.close();
        return;
      }
      if (options.rpcError) {
        ws.send(
          JSON.stringify({
            id: message.id,
            error: { code: -32601, message: "Unsupported method" },
          }),
        );
        return;
      }
      let result: unknown = {};
      if (message.method === "thread/read")
        result = {
          thread: {
            id: options.wrongThread ? "wrong" : "original",
            cwd: "/example",
            status: { type: options.loaded ? "active" : "notLoaded" },
          },
        };
      if (message.method === "thread/loaded/list")
        result =
          options.paginate && !message.params.cursor
            ? { data: ["unrelated"], nextCursor: "next" }
            : { data: options.loaded ? ["original"] : [], nextCursor: null };
      ws.send(JSON.stringify({ method: "unrelated/notification", params: {} }));
      ws.send(JSON.stringify({ id: message.id, result }));
    }),
  );
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(socketPath, resolve);
  });
  return { socketPath, threadId: "original", timeoutMs: 1000, methods };
}

test("stored history alone blocks the gate and never sends or resumes a turn", async (t) => {
  const connection = await fixture(t);
  const result = await probeCodex(connection);
  assert.equal(result.status, "blocked-not-loaded");
  assert.equal(result.gatePassed, false);
  assert.deepEqual(connection.methods, [
    "initialize",
    "initialized",
    "thread/read",
    "thread/loaded/list",
  ]);
});
test("a loaded original thread is only a candidate, not round-trip proof", async (t) => {
  const result = await probeCodex(
    await fixture(t, { loaded: true, paginate: true }),
  );
  assert.equal(result.loadedOnConnectedServer, true);
  assert.equal(result.status, "live-thread-candidate");
  assert.equal(result.roundTripVerified, false);
  assert.equal(result.gatePassed, false);
});
test("rejects a mismatched chat ID", async (t) => {
  await assert.rejects(
    probeCodex(await fixture(t, { wrongThread: true })),
    /different thread/,
  );
});
test("disconnect rejects pending requests", async (t) => {
  await assert.rejects(
    probeCodex(await fixture(t, { closeOnRead: true })),
    /closed/,
  );
});
test("nonresponding server times out", async (t) => {
  await assert.rejects(
    probeCodex({ ...(await fixture(t, { silent: true })), timeoutMs: 100 }),
    /timeout/,
  );
});
test("unsupported protocols fail explicitly", async (t) => {
  await assert.rejects(
    probeCodex(await fixture(t, { rpcError: true })),
    /Unsupported method/,
  );
});
test("requires explicit original chat identity before connecting", async () => {
  await assert.rejects(
    probeCodex({ socketPath: "/tmp/unused.sock", threadId: "" }),
    /explicit original/,
  );
});
