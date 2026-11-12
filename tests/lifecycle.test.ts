import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { readHostThreads } from "../src/hosts/codex-desktop/lifecycle.ts";
for (const mode of ["complete", "partial", "disconnect"])
  test(`lifecycle snapshot: ${mode}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "h2-lifecycle-"));
    const socket = join(dir, "host.sock");
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const requests: any[] = [];
    wss.on("connection", (ws) =>
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.id === undefined) return;
        requests.push(m);
        let result: any = {};
        if (m.method === "thread/list") {
          if (mode === "disconnect") {
            ws.close();
            return;
          }
          if (mode === "partial" && m.params.archived) {
            ws.send(
              JSON.stringify({ id: m.id, error: { message: "unavailable" } }),
            );
            return;
          }
          result = m.params.archived
            ? { data: [{ id: "archived" }], nextCursor: null }
            : m.params.cursor
              ? { data: [{ id: "second" }], nextCursor: null }
              : { data: [{ id: "first" }], nextCursor: "page2" };
        }
        ws.send(JSON.stringify({ id: m.id, result }));
      }),
    );
    await new Promise<void>((r) => server.listen(socket, r));
    t.after(() => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });
    if (mode === "complete")
      assert.deepEqual(
        [...(await readHostThreads(socket))],
        ["first", "second", "archived"],
      );
    else await assert.rejects(readHostThreads(socket));
    assert.ok(
      requests.every((m) => ["initialize", "thread/list"].includes(m.method)),
    );
    assert.ok(
      requests
        .filter((m) => m.method === "thread/list")
        .every(
          (m) =>
            m.params.sourceKinds.includes("subAgentThreadSpawn") &&
            m.params.modelProviders.length === 0,
        ),
    );
  });
