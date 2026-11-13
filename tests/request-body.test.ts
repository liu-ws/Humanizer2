import { test } from "node:test";
import assert from "node:assert/strict";
import { readJsonBody } from "../src/server/request-body.ts";

async function* chunks(parts: Uint8Array[]) {
  yield* parts;
}

test("JSON decoding preserves Chinese, emoji, CRLF, and nested Markdown across every byte boundary", async () => {
  const document =
    "# 中文\r\n\r\n$\\mathcal C$ 是热损失。🧪\r\n\r\n```python\r\nprint('中文')\r\n```\r\n";
  const payload = {
    name: "reply_to_browser",
    args: {
      answer: JSON.stringify({ units: [{ id: "unit", text: document }] }),
    },
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  for (let i = 1; i < bytes.length; i++) {
    assert.deepEqual(
      await readJsonBody(chunks([bytes.subarray(0, i), bytes.subarray(i)])),
      payload,
      `split at byte ${i}`,
    );
  }
  assert.deepEqual(
    await readJsonBody(chunks(Array.from(bytes, (b) => Buffer.from([b])))),
    payload,
  );
});

test("JSON body keeps the existing character limit, empty-body behavior, and syntax rejection", async () => {
  assert.deepEqual(await readJsonBody(chunks([])), {});
  const bytes = Buffer.from(JSON.stringify("中🧪"));
  assert.equal(await readJsonBody(chunks([bytes]), 5), "中🧪");
  await assert.rejects(readJsonBody(chunks([bytes]), 4), /请求过大/);
  await assert.rejects(readJsonBody(chunks([Buffer.from("{")])), SyntaxError);
});
