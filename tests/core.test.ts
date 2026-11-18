import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { validateEdit } from "../src/core/documents.ts";
const thread = "11111111-1111-4111-8111-111111111111";
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "h2-core-"));
  const path = join(dir, "db.sqlite");
  let store = new Store(path);
  let engine = new Engine(store, { zh: "中文规则", en: "English rules" });
  engine.bind(thread);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    get engine() {
      return engine;
    },
    restart() {
      store.close();
      store = new Store(path);
      engine = new Engine(store, { zh: "中文规则", en: "English rules" });
    },
  };
}
function request(f: any, d: any, kind: string, unitId?: string) {
  return f.engine.submit({
    id: randomUUID(),
    kind,
    documentId: d.id,
    revision: d.revision,
    unitId,
    question: "测试",
  });
}
test("full-text validation protects code and link targets", () => {
  assert.throws(() => validateEdit("[a](https://a)", "[a](https://b)", "md"));
  assert.throws(() => validateEdit("text `x`", "text `y`", "md"));
  validateEdit("hello **world**", "greetings **world**", "md");
});
test("restart retains documents, baselines, preferences and queue; ambiguous claims never resend", (t) => {
  const f = fixture(t);
  let d = f.store.import("a.txt", "原始句子。", "txt");
  d = f.store.edit(d.id, d.units[0].id, "修改后的句子。", 0);
  const queued = request(f, d, "ask", d.units[0].id);
  const claimed = request(f, d, "ask", d.units[0].id);
  f.engine.poll();
  f.restart();
  assert.equal(f.store.document(d.id).original, "原始句子。");
  assert.equal(f.store.document(d.id).units[0].baseline, "原始句子。");
  assert.equal(
    f.engine.state().requests.find((r) => r.id === queued.id)?.status,
    "uncertain",
  );
  assert.equal(f.engine.poll().next?.id, claimed.id);
  assert.equal(f.engine.poll().next, null);
});
test("pause and reconnect claim queued questions exactly once; duplicate submit is idempotent", (t) => {
  const f = fixture(t);
  const body = { id: randomUUID(), question: "hello" };
  f.engine.paused = true;
  f.engine.submit(body);
  assert.equal(f.engine.poll().next, null);
  f.engine.paused = false;
  assert.equal(f.engine.poll().next?.id, body.id);
  f.engine.submit(body);
  assert.equal(f.engine.poll().next, null);
  assert.equal(f.engine.state().requests.length, 1);
  assert.throws(() => f.engine.submit({ ...body, question: "other" }));
});
test("compact relay polls keep queued order and skip syncs awaiting delivery or a reply", (t) => {
  const { store, engine } = fixture(t);
  const doc = store.import("draft.md", "first", "md");
  const sync = () =>
    engine.submit({
      id: randomUUID(),
      kind: "sync",
      question: "sync",
      documentId: doc.id,
      unitIds: [doc.units[0].id],
      revision: 0,
    });
  const first = sync();
  const second = sync();
  const ask = engine.submit({ id: randomUUID(), question: "ask" });
  const poll = () => engine.poll(undefined, true);
  assert.equal(poll().next?.id, first.id);
  assert.equal(poll().next?.id, ask.id);
  for (const status of ["sent", "uncertain"]) {
    engine.delivery(first.id, status);
    assert.deepEqual(poll(), { next: null });
  }
  engine.cancel(first.id);
  assert.equal(poll().next?.id, second.id);
  assert.equal(engine.state().requests.length, 3);
});
test("new context includes both full documents and current language rules, not only the selected unit", (t) => {
  const f = fixture(t);
  const d = f.store.import("a.md", "中文正文。\n\nOther paragraph.", "md");
  const r = request(f, d, "rewrite", d.units[0].id);
  f.engine.poll();
  const c: any = f.engine.context(r.id);
  assert.equal(c.original, d.original);
  assert.equal(c.polished, d.original);
  assert.ok(c.rules.zh && c.rules.en);
  assert.equal(c.units.length, 1);
});
test("AI output cannot overwrite edits made during generation; cancellation ignores late replies", (t) => {
  const f = fixture(t);
  let d = f.store.import("a.txt", "initial", "txt");
  const r = request(f, d, "rewrite", d.units[0].id);
  f.engine.poll();
  f.engine.context(r.id);
  d = f.store.edit(d.id, d.units[0].id, "human edit", 0);
  f.engine.reply(r.id, thread, JSON.stringify({ text: "AI edit" }));
  assert.throws(() => f.engine.apply(r.id), /正文已改变/);
  assert.equal(f.store.polished(f.store.document(d.id)), "human edit");
  const q = request(f, d, "ask", d.units[0].id);
  f.engine.poll();
  f.engine.cancel(q.id);
  assert.throws(() => f.engine.reply(q.id, thread, "late"));
});
test("import → polish → human edit → confirmed preferences → export → next document", (t) => {
  const f = fixture(t);
  let d = f.store.import(
    "a.md",
    "这是一个非常重要的事情。\n\nEnglish paragraph.",
    "md",
  );
  const r = request(f, d, "polish");
  f.engine.poll();
  f.engine.context(r.id);
  f.engine.reply(
    r.id,
    thread,
    JSON.stringify({
      units: d.units
        .filter((u) => u.editable)
        .map((u) => ({
          id: u.id,
          text: u.text.replace("非常重要的事情", "重要的事情"),
        })),
    }),
  );
  d = f.engine.apply(r.id);
  assert.equal(d.original, "这是一个非常重要的事情。\n\nEnglish paragraph.");
  d = f.store.enter(d.id, d.units[0].id);
  d = f.store.edit(
    d.id,
    d.units[0].id,
    "这件事很重要。\n\nEnglish paragraph.",
    d.units[0].revision,
  );
  const learn = request(f, d, "learn", d.units[0].id);
  f.engine.poll();
  f.engine.context(learn.id);
  const candidate = {
    rule: "使用简洁、具体的主语",
    language: "zh",
    genre: "通用",
  };
  f.engine.reply(learn.id, thread, JSON.stringify({ candidates: [candidate] }));
  assert.equal(f.store.applicable(d).length, 0);
  d = f.store.confirm(
    d.id,
    d.units[0].id,
    d.units[0].revision,
    [candidate],
    learn.id,
  );
  assert.equal(d.units[0].baseline, null);
  assert.equal(d.units[0].reviewed, true);
  assert.equal(f.store.polished(d), "这件事很重要。\n\nEnglish paragraph.");
  assert.equal(f.store.get<any>("requests", learn.id).data, null);
  const next = f.store.import("b.md", "新的中文文档。", "md");
  const q = request(f, next, "polish");
  f.engine.poll();
  assert.equal((f.engine.context(q.id) as any).experiences.length, 1);
  const e = f.store.experiences()[0];
  f.store.updateExperience(e.id, { enabled: false });
  assert.equal(f.store.applicable(next).length, 0);
  f.store.updateExperience(e.id, { enabled: true });
  f.store.deleteExperience(e.id);
  assert.equal(f.store.applicable(next).length, 0);
});
test("no-change confirmation requires no AI, rejecting all candidates still completes review", (t) => {
  const f = fixture(t);
  let d = f.store.import("a.txt", "first", "txt");
  assert.throws(() => request(f, d, "learn", d.units[0].id), /没有人工修改/);
  d = f.store.confirm(d.id, d.units[0].id, 0, []);
  assert.equal(d.units[0].reviewed, true);
  d = f.store.edit(d.id, d.units[0].id, "second", 0);
  const r = request(f, d, "learn", d.units[0].id);
  f.engine.poll();
  f.engine.context(r.id);
  f.engine.reply(r.id, thread, JSON.stringify({ candidates: [] }));
  d = f.store.confirm(d.id, d.units[0].id, 1, [], r.id);
  assert.equal(d.units[0].baseline, null);
  d = f.store.edit(d.id, d.units[0].id, "third", 1);
  assert.equal(d.units[0].baseline, "second");
  assert.equal(f.store.experiences().length, 0);
});
test("concurrent editors cannot overwrite newer edits; malformed batch cannot partially apply", (t) => {
  const f = fixture(t);
  let d = f.store.import("a.txt", "first", "txt");
  d = f.store.edit(d.id, d.units[0].id, "second", 0);
  assert.throws(() => f.store.edit(d.id, d.units[0].id, "stale", 0));
  assert.equal(f.store.polished(f.store.document(d.id)), "second");
  assert.throws(() =>
    f.store.confirm(d.id, d.units[0].id, 1, [{ rule: "bad" }]),
  );
  assert.equal(f.store.experiences().length, 0);
});
test("frontmatter and GFM tables are protected and task-list structure is preserved", () => {
  const text =
    "---\ntitle: Do not change\n---\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [ ] Review this paragraph.\n";
  assert.throws(() =>
    validateEdit(text, text.replace("Do not change", "Changed"), "md"),
  );
  assert.throws(() => validateEdit(text, text.replace("| 1 |", "| 9 |"), "md"));
  assert.throws(() => validateEdit(text, text.replace("[ ]", "[x]"), "md"));
});
test("document rewrites require explicit full-context read and AI edits are not learned as human edits", (t) => {
  const f = fixture(t);
  let d = f.store.import("a.txt", "before", "txt");
  const r = request(f, d, "rewrite", d.units[0].id);
  f.engine.poll();
  assert.throws(
    () => f.engine.reply(r.id, thread, JSON.stringify({ text: "after" })),
    /read_request_context/,
  );
  f.engine.context(r.id);
  f.engine.reply(r.id, thread, JSON.stringify({ text: "after" }));
  d = f.engine.apply(r.id);
  assert.equal(d.units[0].baseline, null);
  assert.throws(() => request(f, d, "learn", d.units[0].id), /没有人工修改/);
});

test("document sync is atomic when any target acquires an editing lease", (t) => {
  const f = fixture(t);
  const d = f.store.import("batch.txt", "first\n\nsecond\n\nthird", "txt");
  f.store.put("experiences", {
    id: randomUUID(),
    rule: "Use direct wording",
    language: "en",
    genre: "通用",
    enabled: true,
    confirmed: true,
  });
  f.engine.syncPreferences(d.id);
  const q = f.engine.poll().next!;
  f.engine.context(q.id);
  f.store.meta("editing:" + d.units[0].id, String(Date.now() + 45000));
  f.engine.reply(
    q.id,
    thread,
    JSON.stringify({
      units: q.unitIds!.map((id) => ({ id, text: "Updated." })),
    }),
  );
  assert.deepEqual(
    f.store.document(d.id).units.map((u) => u.text),
    d.units.map((u) => u.text),
  );
  assert.equal(f.store.get<any>("requests", q.id).applied, undefined);
  assert.throws(() => f.engine.apply(q.id), /人工编辑/);
});

test("document conversation treats leading numbers as text rather than retargeting", (t) => {
  const f = fixture(t);
  const d = f.store.import("scope.md", "First.\n\nSecond.", "md");
  const q = f.engine.submit({
    id: randomUUID(),
    kind: "ask",
    documentId: d.id,
    unitId: d.units[0].id,
    revision: d.revision,
    question: "#2 is a literal reference, not a target",
  });
  assert.equal(q.unitId, d.units[0].id);
  f.engine.poll();
  const context = f.engine.context(q.id);
  assert.equal(context.question, "#2 is a literal reference, not a target");
});

test("ordinary save never completes or learns; complete marks reviewed without enabling preferences", (t) => {
  const { store } = fixture(t);
  let d = store.import("x.md", "原来。", "md");
  const id = d.units[0].id;
  d = store.edit(d.id, id, "修改。", 0);
  assert.equal(d.units[0].reviewed, false);
  assert.equal(store.all("requests").length, 0);
  d = store.completeReview(d.id, id, d.units[0].revision);
  assert.equal(d.units[0].reviewed, true);
  assert.equal(store.experiences().length, 0);
  assert.equal(d.units[0].baseline, "原来。");
  d = store.edit(d.id, id, "再次修改。", d.units[0].revision);
  assert.equal(d.units[0].baseline, "修改。");
  assert.equal(d.units[0].reviewed, false);
});
test("explicit manual preference may be confirmed without AI extraction or a text change", (t) => {
  const { store } = fixture(t);
  const d = store.import("x.md", "正文。", "md");
  const rule = {
    rule: "解释术语时先给出中文含义，再给英文缩写。",
    language: "zh",
    genre: "通用",
    manual: true,
  };
  store.confirm(d.id, d.units[0].id, 0, [rule]);
  const entries = store.experiences();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].confirmed, true);
  assert.match(entries[0].source, /manual$/);
  assert.throws(
    () => store.confirm(d.id, d.units[0].id, 0, [{ ...rule, manual: false }]),
    /缺少经验提炼来源/,
  );
  assert.throws(() =>
    store.confirm(d.id, d.units[0].id, 0, [{ ...rule, rule: "" }]),
  );
});

test("one manual confirmation saves multiple rules and source does not enqueue work", (t) => {
  const f = fixture(t);
  const d = f.store.import("manual.txt", "First.\n\nSecond.", "txt");
  const rules = ["Prefer short sentences", "Use direct verbs"].map((rule) => ({
    rule,
    language: "all",
    genre: "通用",
    manual: true,
  }));
  f.store.confirm(d.id, d.units[0].id, d.units[0].revision, rules);
  assert.equal(f.store.experiences().length, 2);
  f.store.enter(d.id, d.units[0].id);
  assert.equal(f.engine.state().requests.length, 0);
  assert.equal(f.store.document(d.id).units[0].reviewed, true);
});

test("batch reply cannot overwrite edits made after full context read", (t) => {
  const f = fixture(t);
  const d = f.store.import("safe.txt", "First.\n\nSecond.\n\nThird.", "txt");
  f.store.put("experiences", {
    id: randomUUID(),
    rule: "Use direct verbs",
    language: "all",
    genre: "通用",
    enabled: true,
    confirmed: true,
  });
  f.engine.syncPreferences(d.id);
  const q = f.engine.poll().next!;
  f.engine.context(q.id);
  f.store.edit(d.id, d.units[0].id, "Human revision.\n\n", d.units[0].revision);
  f.engine.reply(
    q.id,
    thread,
    JSON.stringify({
      units: q.unitIds!.map((id) => ({ id, text: "AI revision." })),
    }),
  );
  assert.equal(f.store.document(d.id).units[0].text, "Human revision.\n\n");
  assert.equal(f.store.get<any>("requests", q.id).applied, undefined);
});
