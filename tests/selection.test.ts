import { strict as assert } from "node:assert";
import test from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { sourceSelection, textareaSelection } from "../src/ui/selection.ts";

test("textarea selection retains original offsets across mixed line endings and emoji", () => {
  const source = "甲\r\n🧪\r\n乙\r丙\n丁";
  const value = "甲\n🧪\n乙\n丙\n丁";
  for (const [from, to] of [
    [0, 2],
    [2, 6],
    [6, value.length],
  ]) {
    const range = textareaSelection(source, value, from, to)!;
    assert.equal(
      source.slice(range.from, range.to).replace(/\r\n?/g, "\n"),
      value.slice(from, to),
    );
  }
  assert.deepEqual(textareaSelection(source, value, 1, 2), { from: 1, to: 3 });
  assert.equal(textareaSelection(source, value + "!", 0, 1), null);
});

test("long formatted documents map repeated text and UTF-16 offsets without parsing", () => {
  const block = "**实验🧪**：[数据](https://example.org/data)。";
  const visible = "实验🧪：数据。";
  const source = Array(2200).fill(block).join("\n\n");
  const rendered = Array(2200).fill(visible).join("\n\n");
  const secondLast = rendered.lastIndexOf(
    visible,
    rendered.length - visible.length - 1,
  );
  const start = source.lastIndexOf(block, source.length - block.length - 1);
  const from = secondLast + visible.indexOf("🧪");
  const to = rendered.lastIndexOf("数据") + "数据".length;
  assert.deepEqual(
    sourceSelection(source, rendered, from, to, () =>
      assert.fail("unexpected parse"),
    ),
    {
      from: start + block.indexOf("🧪"),
      to: source.lastIndexOf("数据") + "数据".length,
    },
  );
});

test("a repeated word in a link's hidden URL still maps to the visible occurrence", () => {
  const source = Array(450).fill("[x](tag) **tag**").join("\n\n");
  const rendered = Array(450).fill("x tag").join("\n\n");
  const from = rendered.lastIndexOf("tag");
  const start = source.lastIndexOf("tag");
  assert.deepEqual(
    sourceSelection(source, rendered, from, from + 3, fromMarkdown),
    { from: start, to: start + 3 },
  );
});

test("virtual newlines between list items keep the source markers inside a cross-item quote", () => {
  const source = "- **甲**\r\n- 乙🧪";
  const rendered = "甲\n\n乙🧪";
  assert.deepEqual(
    sourceSelection(source, rendered, 0, rendered.length, fromMarkdown),
    {
      from: source.indexOf("甲"),
      to: source.length,
    },
  );
});

test("syntax offsets exclude a matching code-fence language", () => {
  const source = "~~~sh\nsh\n~~~";
  assert.deepEqual(sourceSelection(source, "sh", 0, 2, fromMarkdown), {
    from: 6,
    to: 8,
  });
});

test("quotes that end in whitespace retain the selected space", () => {
  const source = "Alpha **beta** gamma.";
  const rendered = "Alpha beta gamma.";
  const range = sourceSelection(source, rendered, 6, 11, fromMarkdown);
  assert.ok(range);
  assert.equal(source.slice(range.from, range.to), "beta** ");
});

test("decoded link labels and plain entities quote their exact source expression", () => {
  for (const [source, rendered, selected, spelling] of [
    ["[&#65;](A)", "A", "A", "&#65;"],
    ["&#65; [home](A)", "A home", "A", "&#65;"],
    ["![&#65;](A)", "A", "A", "&#65;"],
    ["&#x1F9EA; &lt; &amp;", "🧪 < &", "🧪", "&#x1F9EA;"],
    ["&#x1F9EA; &lt; &amp;", "🧪 < &", "&", "&amp;"],
    ["Alpha \\* beta", "Alpha * beta", "*", "\\*"],
  ]) {
    const from = rendered.indexOf(selected);
    const start = source.indexOf(spelling);
    assert.deepEqual(
      sourceSelection(source, rendered, from, from + selected.length),
      {
        from: start,
        to: start + spelling.length,
      },
      source,
    );
  }
});

test("quotes beginning or ending on a virtual block separator use the source line ending", () => {
  const source = "- **甲**\r\n- 乙",
    rendered = "甲\n\n乙";
  assert.deepEqual(sourceSelection(source, rendered, 0, 2), { from: 4, to: 9 });
  assert.deepEqual(sourceSelection(source, rendered, 2, 4), {
    from: 7,
    to: 12,
  });
});

test("unrecognized transformed text is not assigned to an unrelated source range", () => {
  assert.equal(
    sourceSelection("[&#65;](unused)", "decoded differently", 0, 7),
    null,
  );
});
