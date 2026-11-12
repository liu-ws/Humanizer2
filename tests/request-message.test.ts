import { test } from "node:test";
import assert from "node:assert/strict";
import { requestMessage } from "../src/hosts/request-message.ts";
test("both hosts display the same document question and selection and allow optional context reads", () => {
  for (const host of ["codex-desktop", "codex-cli"] as const) {
    const text = requestMessage(
      {
        id: "request-1",
        documentName: "文章.md",
        selection: "选中的文字",
        question: "解释这句话",
      },
      host,
    );
    assert.match(text, /文档：文章.md/);
    assert.match(text, /选中文字：\n选中的文字/);
    assert.match(text, /用户问题：\n解释这句话/);
    assert.match(text, /按需调用/);
    assert.doesNotMatch(text, /请先调用|必须读取/);
    assert.doesNotMatch(text, /threadId|绑定原聊天|权限授权|不要新建/);
  }
  assert.match(
    requestMessage({ id: "1", question: "全文问题" }, "codex-desktop"),
    /未选择文字/,
  );
});

test("notifications show readable quoted text while source offsets stay in request context", () => {
  const message = requestMessage(
    {
      id: "r",
      documentName: "d.md",
      question: "解释",
      selection: "bold** text",
      selectionText: "bold text",
    },
    "codex-desktop",
  );
  assert.match(message, /选中文字：\nbold text/);
  assert.doesNotMatch(message, /bold\*\*/);
});
