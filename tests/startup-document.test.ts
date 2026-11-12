import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveStartupDocument,
  importStartupDocument,
} from "../src/server/startup-document.ts";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";

const source = {
  name: "paper.md",
  text: "原文。",
  format: "md" as const,
  genre: "通用",
  writingMode: "academic" as const,
};
function fixture(t: any) {
  const store = new Store(":memory:");
  const engine = new Engine(store, {
    en: "en",
    zh: "zh",
    academic: "academic",
  });
  engine.bind("11111111-1111-4111-8111-111111111111");
  t.after(() => store.close());
  return engine;
}
test("startup import is idempotent, preserves original and mode, and queues one full polish", (t) => {
  const e = fixture(t);
  const first = importStartupDocument(e, source);
  assert.deepEqual(importStartupDocument(e, source), first);
  assert.equal(e.store.all("documents").length, 1);
  assert.equal(e.store.all("requests").length, 1);
  const d = e.store.document(first.documentId);
  assert.equal(d.original, source.text);
  assert.equal(d.writingMode, "academic");
  assert.equal(e.poll().next?.kind, "polish");
  assert.equal(importStartupDocument(e, source).status, "dispatching");
  e.cancel(first.requestId!);
  assert.equal(importStartupDocument(e, source).status, "cancelled");
  assert.equal(e.store.all("requests").length, 1);
});
test("startup never reruns first phase on an edited document and invalid input leaves no documents", (t) => {
  const e = fixture(t);
  const d = e.store.import(
    source.name,
    source.text,
    source.format,
    source.genre,
    source.writingMode,
  );
  e.store.edit(d.id, d.units[0].id, "人工修改。", 0);
  assert.equal(importStartupDocument(e, source).status, "skipped-edited");
  assert.equal(e.store.all("requests").length, 0);
  assert.throws(() =>
    importStartupDocument(e, { ...source, writingMode: "bad" }),
  );
  assert.equal(e.store.all("documents").length, 1);
});
test("local attachment resolution preserves full text and rejects ambiguous, oversized or unsupported inputs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "h2-attachment-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "source.txt");
  const text = "第一段。\r\n\r\nSecond paragraph.\r\n";
  writeFileSync(path, text);
  assert.deepEqual(await resolveStartupDocument({ path }), {
    name: "source.txt",
    text,
    format: "txt",
    genre: "通用",
    writingMode: "general",
  });
  await assert.rejects(resolveStartupDocument({ path, text }));
  await assert.rejects(resolveStartupDocument({ path: "relative.md" }));
  await assert.rejects(resolveStartupDocument({ path: join(dir, "file.pdf") }));
  await assert.rejects(resolveStartupDocument({ text }));
  await assert.rejects(
    resolveStartupDocument({ ...source, text: "x".repeat(200001) }),
  );
  writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(resolveStartupDocument({ path }));
  writeFileSync(path, "x".repeat(800001));
  await assert.rejects(resolveStartupDocument({ path }));
});
