import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, sessionKey } from "../src/server/workspace.ts";
import { CodexCliAdapter } from "../src/hosts/codex-cli/adapter.ts";

const threadId = "11111111-1111-4111-8111-111111111111";
function setup(t: any, queue: (id: string, message: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "h2-cli-"));
  const workspace = new Workspace(dir, { zh: "", en: "", academic: "" }, 0);
  const sessionId = sessionKey(threadId, "codex-cli");
  const engine = workspace.register(sessionId);
  const adapter = new CodexCliAdapter(async (name, args) => {
    if (name === "open_bridge")
      return { sessionId, bridgeKey: workspace.bridgeKey(sessionId) };
    if (name === "bridge_status") return engine.state();
    if (name === "cancel_browser_request") return engine.cancel(args.requestId);
    workspace.verifyBridge(args.sessionId, args.bridgeKey);
    if (name === "bridge_poll") return engine.poll(args.capabilities);
    if (name === "bridge_delivery")
      return engine.delivery(args.requestId, args.status, args.error);
    throw Error(name);
  }, queue);
  t.after(() => {
    adapter.stop();
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { adapter, workspace, engine, sessionId };
}

test("CLI and desktop with identical UUID keep separate documents, routes and lifecycle", async (t) => {
  const f = setup(t, async () => {});
  const desktop = f.workspace.register(threadId);
  const doc = f.engine.store.import("cli.md", "CLI", "md");
  assert.throws(() => desktop.store.document(doc.id));
  const r = f.engine.submit({ id: randomUUID(), question: "hi" });
  assert.equal(f.workspace.locate(r.id, threadId, "codex-cli"), f.engine);
  assert.throws(() => f.workspace.locate(r.id, threadId));
  const missing = new Map<string, number>();
  f.workspace.reconcileHostThreads(new Set([threadId]), missing);
  f.workspace.reconcileHostThreads(new Set(), missing);
  f.workspace.reconcileHostThreads(new Set(), missing);
  assert.deepEqual(
    f.workspace.sessions().map((s) => s.id),
    [f.sessionId],
  );
  assert.throws(() => sessionKey("../bad", "codex-cli"));
});

test("ambiguous CLI delivery and reconnect never resend; cancellation blocks late reply", async (t) => {
  let calls = 0;
  const f = setup(t, async () => {
    calls++;
    throw Error("timeout after queueing");
  });
  await f.adapter.bind(threadId);
  const r = f.engine.submit({ id: randomUUID(), question: "hi" });
  await Promise.all([f.adapter.tick(), f.adapter.tick()]);
  assert.equal(f.engine.state().requests[0].status, "uncertain");
  await f.adapter.bind(threadId);
  await f.adapter.tick();
  assert.equal(calls, 1);
  await f.adapter.cancel(r.id);
  assert.throws(() => f.engine.reply(r.id, threadId, "late"));
  await assert.rejects(f.adapter.bind(randomUUID()));
});

test("stale dispatch claims become uncertain without resend after relay loss", async (t) => {
  let calls = 0;
  const f = setup(t, async () => {
    calls++;
  });
  await f.adapter.bind(threadId);
  f.engine.submit({ id: randomUUID(), question: "hi" });
  const r = f.engine.poll().next!;
  r.dispatchedAt = Date.now() - 61000;
  f.engine.store.put("requests", r);
  await f.adapter.tick();
  assert.equal(f.engine.state().requests[0].status, "uncertain");
  assert.equal(calls, 0);
});

test("CLI notification includes document, selection and question without exposing chat identity", async (t) => {
  let message = "",
    target = "";
  const f = setup(t, async (id, text) => {
    target = id;
    message = text;
  });
  await f.adapter.bind(threadId);
  const d = f.engine.store.import("论文.md", "第一段。第二段。", "md");
  const r = f.engine.submit({
    id: randomUUID(),
    documentId: d.id,
    unitId: d.units[0].id,
    revision: d.revision,
    question: "这句话怎么改？",
    selection: "第二段。",
    selectionRange: { from: 4, to: 8 },
  });
  await f.adapter.tick();
  assert.equal(target, threadId);
  for (const text of [
    d.name,
    r.id,
    "第二段。",
    "这句话怎么改？",
    "humanizer2_cli",
    "read_request_context",
    "reply_to_browser",
  ])
    assert.ok(message.includes(text));
  assert.ok(!message.includes(threadId));
  assert.doesNotMatch(message, /权限授权|不要新建/);
  assert.equal(f.workspace.locate(r.id, undefined, "codex-cli"), f.engine);
  assert.throws(() => f.workspace.locate(r.id));
});
