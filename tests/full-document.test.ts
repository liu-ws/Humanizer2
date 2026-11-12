import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { sourceSelection } from "../src/ui/selection.ts";
const thread = "11111111-1111-4111-8111-111111111111";
function fixture(t: any) {
  const store = new Store(":memory:");
  const engine = new Engine(store, { zh: "zh rules", en: "en rules" });
  engine.bind(thread);
  t.after(() => store.close());
  return { store, engine };
}
function full(s: Store, text: string, name = "test.md") {
  return s.import(name, text, "md");
}
test("whole-document polish uses a single continuous text, loads both languages and retains protected content", (t) => {
  const { store: s, engine: e } = fixture(t);
  const d = full(
    s,
    "# Test\n\n冗长的句子。 English sentence.\n\n```js\nconst x = 1;\n```\n",
  );
  const r = e.submit({
    id: randomUUID(),
    kind: "polish",
    documentId: d.id,
    revision: d.revision,
    question: "polish",
  });
  e.poll();
  const c = e.context(r.id) as any;
  assert.ok(c.rules.zh && c.rules.en);
  assert.match(c.instructions, /连续全文/);
  const answer = {
    units: [
      {
        id: d.units[0].id,
        text: d.units[0].text.replace("冗长的句子", "简洁的句子"),
      },
    ],
  };
  assert.throws(() =>
    e.reply(
      r.id,
      thread,
      JSON.stringify({
        units: [{ id: d.units[0].id, text: "Lost protected code" }],
      }),
    ),
  );
  e.reply(r.id, thread, JSON.stringify(answer));
  const out = s.document(d.id);
  assert.equal(out.units.length, 1);
  assert.equal(out.stage, "reviewing");
  assert.equal(out.original, d.original);
  assert.doesNotMatch(s.polished(out), /Humanizer² 模块/);
});
test("session preference sync skips source, drafts, editing leases, closed docs and active polish; deduplicates", (t) => {
  const { store: s, engine: e } = fixture(t);
  const source = full(s, "Source."),
    target = full(s, "Target."),
    dirty = full(s, "Draft."),
    editing = full(s, "Typing."),
    closed = full(s, "Closed."),
    busy = full(s, "Busy.");
  s.confirm(source.id, source.units[0].id, 0, [
    {
      rule: "Use concise wording",
      language: "all",
      genre: "通用",
      manual: true,
    },
  ]);
  s.edit(dirty.id, dirty.units[0].id, "Human draft.", 0);
  s.meta("editing:" + editing.units[0].id, String(Date.now() + 45000));
  s.detachDocument(closed.id);
  e.submit({
    id: randomUUID(),
    kind: "polish",
    documentId: busy.id,
    revision: busy.revision,
    question: "polish",
  });
  const queued = e.syncSessionPreferences(source.id).queued;
  assert.equal(queued.length, 1);
  assert.equal(s.get<any>("requests", queued[0]).documentId, target.id);
  assert.deepEqual(e.syncSessionPreferences(source.id).queued, []);
  e.poll();
  e.poll();
  e.context(queued[0]);
  s.edit(target.id, target.units[0].id, "New human text.", 0);
  const r = e.reply(
    queued[0],
    thread,
    JSON.stringify({
      units: [{ id: target.units[0].id, text: "AI replacement." }],
    }),
  );
  assert.equal(r.applied, undefined);
  assert.equal(s.document(target.id).units[0].text, "New human text.");
});
test("selection identifies the second repeated passage and rejects changed ranges or stale revision", (t) => {
  const { store: s, engine: e } = fixture(t);
  const d = full(s, "First phrase. First phrase.");
  const input = {
    id: randomUUID(),
    documentId: d.id,
    unitId: d.units[0].id,
    revision: d.revision,
    question: "Explain this",
    selection: "First phrase",
    selectionRange: { from: 14, to: 26 },
  };
  const r = e.submit(input);
  e.poll();
  const c = e.context(r.id) as any;
  assert.equal(c.selectionContext.from, 14);
  assert.equal(c.selectionContext.before, "First phrase. ");
  assert.match(c.instructions, /专门针对该选中文字/);
  assert.throws(() =>
    e.submit({ ...input, selectionRange: { from: 0, to: 12 } }),
  );
  assert.throws(() =>
    e.submit({
      ...input,
      id: randomUUID(),
      selectionRange: { from: 1, to: 13 },
    }),
  );
  s.edit(d.id, d.units[0].id, "Changed text.", 0);
  assert.throws(() => e.submit({ ...input, id: randomUUID() }));
  assert.equal((e.context(r.id) as any).selectionContext.stale, true);
});
test("rendered selection maps formatting and repeated occurrences to source offsets", () => {
  const source = "**First phrase**. First phrase.";
  const rendered = "First phrase. First phrase.";
  const range = sourceSelection(source, rendered, 14, 26)!;
  assert.equal(source.slice(range.from, range.to), "First phrase");
  assert.equal(range.from, 18);
  assert.equal(sourceSelection(source, rendered, 0, 0), null);
});

test("cross-paragraph rendered selection retains exact Markdown offsets", () => {
  const source =
    "# Heading\n\nFirst **bold** passage.\n\nSecond passage with $x^2$.";
  const rendered = "Heading\n\nFirst bold passage.\n\nSecond passage with x^2.";
  const from = rendered.indexOf("bold"),
    to = rendered.indexOf(" with");
  const range = sourceSelection(source, rendered, from, to)!;
  assert.equal(
    source.slice(range.from, range.to),
    "bold** passage.\n\nSecond passage",
  );
});
test("human editing supports tables and code while AI still cannot rewrite protected content", (t) => {
  const { store: s, engine: e } = fixture(t);
  let d = s.import(
    "table.md",
    "| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nlet n=1;\n```",
    "md",
  );
  const original = d.original;
  d = s.edit(
    d.id,
    d.units[0].id,
    original.replace("| 1 |", "| 3 |").replace("n=1", "n=2"),
    0,
  );
  assert.equal(d.original, original);
  s.confirm(d.id, d.units[0].id, d.units[0].revision, []);
  const r = e.submit({
    id: randomUUID(),
    kind: "rewrite",
    documentId: d.id,
    unitId: d.units[0].id,
    revision: d.revision,
    question: "rewrite",
  });
  e.poll();
  e.context(r.id);
  assert.throws(() =>
    e.reply(
      r.id,
      thread,
      JSON.stringify({ text: d.units[0].text.replace("n=2", "n=3") }),
    ),
  );
});
