import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Workspace } from "../src/server/workspace.ts";
import { Store } from "../src/core/store.ts";
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "h2-workspace-"));
  const w = new Workspace(dir, { zh: "zh", en: "en", academic: "academic" }, 0);
  t.after(() => {
    w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return w;
}
test("session documents and queues are isolated; confirmed preferences are shared", (t) => {
  const w = fixture(t);
  const a = w.register(A, "论文"),
    b = w.register(B, "报告");
  let doc = a.store.import("a.md", "原文。", "md");
  assert.throws(() => b.store.document(doc.id));
  doc = a.store.edit(doc.id, doc.units[0].id, "更直接的表达。", 0);
  const q = a.submit({
    id: randomUUID(),
    kind: "learn",
    documentId: doc.id,
    unitId: doc.units[0].id,
    revision: doc.revision,
    question: "提炼经验",
  });
  assert.equal(b.poll().next, null);
  a.poll();
  a.context(q.id);
  const candidate = { rule: "直接表达", language: "zh", genre: "通用" };
  a.reply(q.id, A, JSON.stringify({ candidates: [candidate] }));
  a.store.confirm(doc.id, doc.units[0].id, 1, [candidate], q.id);
  const other = b.store.import("b.md", "新中文文档。", "md");
  assert.equal(b.store.applicable(other).length, 1);
  assert.equal(b.state().requests.length, 0);
  assert.throws(() => w.verifyBridge(B, w.bridgeKey(A)));
  assert.throws(() => w.locate(q.id, B));
});
test("human editing can add and change formulas without changing immutable original", () => {
  const s = new Store(":memory:");
  try {
    let d = s.import("math.md", "Energy is conserved.", "md");
    d = s.edit(d.id, d.units[0].id, "Energy: $E=mc^2$.", 0);
    d = s.edit(d.id, d.units[0].id, "Energy: $E=mc^{2}$.", 1);
    assert.equal(d.original, "Energy is conserved.");
    assert.match(d.units[0].text, /mc\^\{2\}/);
  } finally {
    s.close();
  }
});

test("host deletion reconciliation requires two complete absent snapshots after presence", (t) => {
  const w = fixture(t);
  w.register(A);
  w.register(B);
  const missing = new Map<string, number>();
  w.reconcileHostThreads(new Set(), missing);
  assert.equal(
    w.sessions().length,
    2,
    "unknown host never deletes unverified sessions",
  );
  w.reconcileHostThreads(new Set([A, B]), missing);
  w.reconcileHostThreads(new Set([B]), missing);
  assert.equal(w.sessions().length, 2);
  w.reconcileHostThreads(new Set([A, B]), missing);
  w.reconcileHostThreads(new Set([B]), missing);
  assert.equal(w.sessions().length, 2, "presence resets missing counter");
  w.reconcileHostThreads(new Set([B]), missing);
  assert.deepEqual(
    w.sessions().map((s) => s.id),
    [B],
  );
  assert.throws(() => w.engine(A));
});

test("session and document tab order is persisted and rejects missing targets", (t) => {
  const w = fixture(t);
  const a = w.register(A);
  w.register(B);
  w.reorderSessions(B, A);
  assert.deepEqual(
    w.sessions().map((s) => s.id),
    [B, A],
  );
  const first = a.store.import("one.md", "一。", "md"),
    second = a.store.import("two.md", "二。", "md");
  a.store.reorderDocuments(second.id, first.id);
  assert.deepEqual(
    a.store.orderedDocuments().map((d) => d.id),
    [second.id, first.id],
  );
  const reopened = new Store(w.path(A));
  assert.deepEqual(
    reopened.orderedDocuments().map((d) => d.id),
    [second.id, first.id],
  );
  reopened.close();
  assert.throws(() => w.reorderSessions(A, "missing"));
  assert.throws(() => a.store.reorderDocuments(first.id, "missing"));
});
test("disconnect keeps data and history reopens the same edited document", (t) => {
  const w = fixture(t),
    e = w.register(A);
  let d = e.store.importOrOpen("source.md", "原文。", "md");
  d = e.store.edit(d.id, d.units[0].id, "修改后的表达。", 0);
  e.store.detachDocument(d.id);
  assert.equal(e.store.openDocuments().length, 0);
  assert.equal(e.store.orderedDocuments().length, 1);
  const again = e.store.importOrOpen("renamed.md", "原文。", "md");
  assert.equal(again.id, d.id);
  assert.equal(again.units[0].text, "修改后的表达。");
  assert.equal(e.store.openDocuments().length, 1);
  assert.equal(e.store.attachDocument(d.id).id, d.id);
  const academic = e.store.importOrOpen(
    "source.md",
    "原文。",
    "md",
    "通用",
    "academic",
  );
  assert.notEqual(academic.id, d.id);
  w.disconnect(A);
  assert.equal(w.sessions().length, 0);
  assert.equal(w.isDisconnected(A), true);
  assert.equal(w.engine(A).store.document(d.id).id, d.id);
  assert.equal(w.engine(A).paused, true);
  w.register(A);
  assert.equal(w.sessions().length, 1);
  assert.equal(w.isDisconnected(A), false);
  assert.equal(w.engine(A).paused, false);
});
