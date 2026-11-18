import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const threadId = "11111111-1111-4111-8111-111111111111";
async function fixture(t: TestContext, cli = false) {
  const dir = mkdtempSync(join(tmpdir(), "h2-test-"));
  const queueLog = join(dir, "queue.jsonl");
  const queueBin = join(dir, "codex-test");
  if (cli)
    writeFileSync(
      queueBin,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(queueLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
      { mode: 0o700 },
    );
  const child = spawn(
    process.execPath,
    [
      `plugins/${cli ? "codex-cli" : "codex-desktop"}/humanizer2/server.mjs`,
      ...(cli ? ["--codex-cli"] : []),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HUMANIZER2_DATA_DIR: dir,
        HUMANIZER2_PORT: "0",
        ...(cli ? { HUMANIZER2_CODEX_BIN: queueBin } : {}),
      },
    },
  );
  const pending = new Map();
  let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const data = JSON.parse(line);
    pending.get(data.id)?.(data);
  });
  let hubPid: number | undefined;
  t.after(async () => {
    child.kill();
    lines.close();
    if (hubPid) {
      try {
        process.kill(hubPid, "SIGTERM");
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 50));
    rmSync(dir, { recursive: true, force: true });
  });
  async function rpc(method: string, params = {}) {
    const currentId = ++id;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(currentId);
        reject(Error("Test RPC timeout"));
      }, 3000);
      pending.set(currentId, (data: any) => {
        clearTimeout(timer);
        pending.delete(currentId);
        data.error ? reject(Error(data.error.message)) : resolve(data.result);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: currentId, method, params }) +
          "\n",
      );
    });
  }
  let bridgeKey = "";
  const tool = (name: string, args: any = {}) =>
    rpc("tools/call", {
      name,
      arguments: ["bridge_poll", "bridge_delivery"].includes(name)
        ? { sessionId: threadId, bridgeKey, ...args }
        : args,
    });
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  const opened = await tool("open_bridge", { threadId });
  bridgeKey = opened.structuredContent.bridgeKey;
  const url = new URL(opened.structuredContent.browserUrl);
  const headers = {
    Authorization:
      "Bearer " + new URLSearchParams(url.hash.slice(1)).get("token"),
    "Content-Type": "application/json",
    "X-Humanizer-Session": opened.structuredContent.sessionId,
  };
  const api = async (path: string, body?: object, extraHeaders = {}) =>
    fetch(url.origin + path, {
      method: body ? "POST" : "GET",
      headers: { ...headers, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
  hubPid = (await (await api("/health")).json()).pid;
  return { rpc, tool, api, url, child, dir, queueLog, headers };
}

test("browser queue → MCP claim → reply → browser state (protocol-only, no real host)", async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  assert.equal(
    (await f.api("/questions", { id, question: "同时读取两份文档有何作用？" }))
      .status,
    200,
  );
  const claimed = (await f.tool("bridge_poll")).structuredContent.next;
  assert.equal(claimed.id, id);
  assert.equal(claimed.threadId, threadId);
  assert.deepEqual(
    (await f.tool("bridge_poll", { compact: true })).structuredContent,
    { next: null },
  );
  await f.tool("bridge_delivery", { requestId: id, status: "sent" });
  const reply = await f.tool("reply_to_browser", {
    requestId: id,
    threadId,
    answer: "原版提供原意，润色版提供最新表达。",
  });
  assert.equal(reply.isError, undefined);
  const state = await (await f.api("/state")).json();
  assert.equal(state.requests[0].status, "answered");
  assert.match(state.requests[0].answer, /原意/);
});
test("duplicate browser request is deduplicated; different content is rejected", async (t) => {
  const f = await fixture(t);
  const body = { id: randomUUID(), question: "问题" };
  await f.api("/questions", body);
  await f.api("/questions", body);
  assert.equal((await (await f.api("/state")).json()).requests.length, 1);
  assert.equal(
    (await f.api("/questions", { ...body, question: "另一问题" })).status,
    400,
  );
});
test("reply from another chat or before dispatch cannot complete request", async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  await f.api("/questions", { id, question: "问题" });
  assert.equal(
    (
      await f.tool("reply_to_browser", {
        requestId: id,
        threadId,
        answer: "premature",
      })
    ).isError,
    true,
  );
  await f.tool("bridge_poll");
  assert.equal(
    (
      await f.tool("reply_to_browser", {
        requestId: id,
        threadId: randomUUID(),
        answer: "wrong chat",
      })
    ).isError,
    true,
  );
});
test("uncertain delivery is not automatically resent", async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  await f.api("/questions", { id, question: "问题" });
  await f.tool("bridge_poll");
  await f.tool("bridge_delivery", { requestId: id, status: "uncertain" });
  assert.equal((await f.tool("bridge_poll")).structuredContent.next, null);
});
test("HTTP API requires capability token and rejects cross-origin requests", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url.origin + "/state")).status, 401);
  assert.equal(
    (await f.api("/state", undefined, { Origin: "https://untrusted.example" }))
      .status,
    403,
  );
});
test("MCP app resource is registered and thread entrypoint rejects missing chat identity", async (t) => {
  const f = await fixture(t);
  const { tools } = await f.rpc("tools/list");
  const open = tools.find((x: any) => x.name === "open_bridge");
  const r = await f.rpc("resources/read", { uri: open._meta.ui.resourceUri });
  assert.equal(r.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.equal((await f.tool("open_bridge")).isError, true);
});
test("HTTP editor and export preserve the immutable source and original newline format", async (t) => {
  const f = await fixture(t);
  const source = "第一段。\r\n\r\nSecond paragraph.\r\n";
  let d = await (
    await f.api("/documents", {
      name: "test.txt",
      format: "txt",
      text: source,
      genre: "通用",
    })
  ).json();
  d = await (
    await f.api("/edit", {
      documentId: d.id,
      unitId: d.units.find((u: any) => u.editable).id,
      revision: 0,
      text: "修改后的第一段。\r\n\r\nSecond paragraph.\r\n",
    })
  ).json();
  const downloaded = await f.api("/export?id=" + d.id);
  assert.equal(
    await downloaded.text(),
    "修改后的第一段。\r\n\r\nSecond paragraph.\r\n",
  );
  assert.match(downloaded.headers.get("Content-Disposition")!, /attachment/);
  assert.equal(
    (await (await f.api("/documents/" + d.id)).json()).original,
    source,
  );
});

test("one URL supports two sessions; each bridge claims only its own requests", async (t) => {
  const f = await fixture(t);
  const second = "22222222-2222-4222-8222-222222222222";
  const b = (
    await f.tool("open_bridge", { threadId: second, title: "Second chat" })
  ).structuredContent;
  assert.equal(new URL(b.browserUrl).origin, f.url.origin);
  const aRequest = randomUUID(),
    bRequest = randomUUID();
  await f.api("/questions", { id: aRequest, question: "for A" });
  await f.api(
    "/questions",
    { id: bRequest, question: "for B" },
    { "X-Humanizer-Session": second },
  );
  const claimB = await f.tool("bridge_poll", {
    sessionId: second,
    bridgeKey: b.bridgeKey,
  });
  assert.equal(claimB.structuredContent.next.id, bRequest);
  const claimA = await f.tool("bridge_poll");
  assert.equal(claimA.structuredContent.next.id, aRequest);
  assert.equal(
    (
      await f.tool("bridge_poll", {
        sessionId: threadId,
        bridgeKey: b.bridgeKey,
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await f.tool("reply_to_browser", {
        requestId: bRequest,
        threadId,
        answer: "wrong",
      })
    ).isError,
    true,
  );
  assert.equal((await (await f.api("/state")).json()).requests.length, 1);
  assert.equal((await (await f.api("/sessions")).json()).sessions.length, 2);
});
test("separate MCP connections reuse one workspace service and closing one does not close the webpage", async (t) => {
  const f = await fixture(t);
  const child = spawn(
    process.execPath,
    ["plugins/codex-desktop/humanizer2/server.mjs"],
    {
      env: { ...process.env, HUMANIZER2_DATA_DIR: f.dir, HUMANIZER2_PORT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill());
  const response = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("peer timeout")), 3000);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      clearTimeout(timer);
      lines.close();
      resolve(JSON.parse(line));
    });
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "open_bridge",
        arguments: { threadId: "33333333-3333-4333-8333-333333333333" },
      },
    }) + "\n",
  );
  const peer = (await response).result.structuredContent;
  assert.equal(new URL(peer.browserUrl).origin, f.url.origin);
  child.kill();
  assert.equal((await f.api("/state")).status, 200);
});

test("embedded workbench API imports, edits and exports without a browser HTTP credential", async (t) => {
  const f = await fixture(t);
  const bound = (await f.tool("open_bridge", { threadId })).structuredContent;
  const call = (path: string, body?: any, key = bound.bridgeKey) =>
    f.tool("workbench_api", {
      bridgeSessionId: threadId,
      bridgeKey: key,
      sessionId: threadId,
      path,
      ...(body === undefined ? {} : { body }),
    });
  const d = (
    await call("/documents", {
      name: "内嵌.md",
      text: "原始段落。",
      format: "md",
      genre: "通用",
    })
  ).structuredContent;
  assert.ok(d.id);
  const edited = await call("/edit", {
    documentId: d.id,
    unitId: d.units[0].id,
    text: "修改后的段落。",
    revision: d.units[0].revision,
  });
  assert.ok(!edited.isError, JSON.stringify(edited));
  const exported = (await call("/export?id=" + d.id)).structuredContent;
  assert.match(exported.text, /修改后的段落/);
  assert.equal((await call("/state", undefined, "bad-key")).isError, true);
  assert.equal((await call("/mcp", {})).isError, true);
  assert.equal((await call("//example.com")).isError, true);
  const tools = (await f.rpc("tools/list")).tools;
  assert.deepEqual(
    tools.find((x: any) => x.name === "workbench_api")._meta.ui.visibility,
    ["app"],
  );
  const page = await f.rpc("resources/read", {
    uri: tools.find((x: any) => x.name === "open_bridge")._meta.ui.resourceUri,
  });
  assert.match(page.contents[0].text, /正在连接当前聊天并加载工作台/);
  assert.doesNotMatch(page.contents[0].text, /<a id="browser"/);
});

test("confirming full-document preferences queues other documents in the same session", async (t) => {
  const f = await fixture(t);
  let d = await (
    await f.api("/documents", {
      name: "sync.txt",
      format: "txt",
      text: "wordy first\n\nwordy second",
      genre: "通用",
    })
  ).json();
  const target = await (
    await f.api("/documents", {
      name: "other.txt",
      format: "txt",
      text: "wordy target",
      genre: "通用",
    })
  ).json();
  d = await (
    await f.api("/edit", {
      documentId: d.id,
      unitId: d.units[0].id,
      text: "first\n\n",
      revision: 0,
    })
  ).json();
  const q = await (
    await f.api("/questions", {
      id: randomUUID(),
      kind: "learn",
      documentId: d.id,
      unitId: d.units[0].id,
      revision: d.revision,
      question: "Learn preference",
    })
  ).json();
  await f.tool("bridge_poll");
  await f.tool("read_request_context", { requestId: q.id, threadId });
  const rule = {
    rule: "Prefer concise wording",
    language: "en",
    genre: "通用",
  };
  await f.tool("reply_to_browser", {
    requestId: q.id,
    threadId,
    answer: JSON.stringify({ candidates: [rule] }),
  });
  const result = await f.api("/confirm", {
    documentId: d.id,
    unitId: d.units[0].id,
    revision: d.units[0].revision,
    candidates: [rule],
    requestId: q.id,
    syncPreferences: true,
  });
  assert.equal(result.status, 200);
  const state = await (await f.api("/state")).json();
  assert.equal(state.experiences.length, 1);
  const sync = state.requests.filter((r: any) => r.kind === "sync");
  assert.equal(sync.length, 1);
  assert.equal(sync[0].documentId, target.id);
  assert.deepEqual(sync[0].unitIds, [target.units[0].id]);
  assert.equal(sync[0].status, "queued");
});

test("CLI package queues to original UUID, returns replies and isolates desktop data (fake CLI)", async (t) => {
  const f = await fixture(t, true);
  const listed = await f.rpc("tools/list");
  assert.ok(listed.tools.every((tool: any) => !tool._meta));
  assert.equal(
    listed.tools.some((tool: any) => tool.name === "bridge_poll"),
    false,
  );
  assert.deepEqual((await f.rpc("resources/list")).resources, []);
  const id = randomUUID();
  await f.api("/questions", { id, question: "private question" });
  for (let i = 0; i < 100; i++) {
    if ((await (await f.api("/state")).json()).requests[0]?.status === "sent")
      break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(
    (await (await f.api("/state")).json()).requests[0].status,
    "sent",
  );
  const queued = readFileSync(f.queueLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].slice(0, 4), [
    "queue",
    "--thread",
    threadId,
    "--message",
  ]);
  assert.match(queued[0][4], new RegExp(id));
  assert.ok(!queued[0].includes("--resume"));
  assert.ok(queued[0][4].includes("private question"));
  assert.ok(!queued[0][4].includes(threadId));
  const context = (
    await f.tool("read_request_context", { threadId, requestId: id })
  ).structuredContent;
  assert.equal(context.threadId, threadId);
  assert.equal(context.question, "private question");
  assert.equal(
    (
      await f.tool("reply_to_browser", {
        threadId,
        requestId: id,
        answer: "answer",
      })
    ).isError,
    undefined,
  );
  assert.equal(
    (await (await f.api("/state")).json()).requests[0].answer,
    "answer",
  );
  assert.equal(
    (await f.api("/state", undefined, { "X-Humanizer-Session": threadId }))
      .status,
    400,
  );
  const second = randomUUID();
  await f.api("/questions", { id: second, question: "cancel me" });
  await f.api("/requests/cancel", { id: second });
  assert.equal(
    (
      await f.tool("reply_to_browser", {
        threadId,
        requestId: second,
        answer: "late",
      })
    ).isError,
    true,
  );
});

for (const cli of [false, true])
  test(`${cli ? "CLI" : "desktop"} startup attachment imports and completes first phase through MCP`, async (t) => {
    const f = await fixture(t, cli);
    const text = "这是原始文字。";
    const path = join(f.dir, "paper.md");
    writeFileSync(path, text);
    const document = cli
      ? { path, writingMode: "academic" }
      : { name: "paper.md", text, writingMode: "academic" };
    const opened = (await f.tool("open_bridge", { threadId, document }))
      .structuredContent;
    const startup = opened.startup;
    assert.ok(startup.requestId);
    assert.equal(
      new URLSearchParams(new URL(opened.browserUrl).hash.slice(1)).get(
        "document",
      ),
      startup.documentId,
    );
    const repeated = (await f.tool("open_bridge", { threadId, document }))
      .structuredContent;
    assert.equal(repeated.startup.requestId, startup.requestId);
    assert.equal((await (await f.api("/state")).json()).requests.length, 1);
    if (cli) {
      for (let i = 0; i < 100; i++) {
        if (
          (await (await f.api("/state")).json()).requests[0].status === "sent"
        )
          break;
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.equal(
        (await (await f.api("/state")).json()).requests[0].status,
        "sent",
      );
    } else
      assert.equal(
        (await f.tool("bridge_poll")).structuredContent.next.id,
        startup.requestId,
      );
    const context = (
      await f.tool("read_request_context", {
        threadId,
        requestId: startup.requestId,
      })
    ).structuredContent;
    assert.equal(context.original, text);
    const d = await (await f.api("/documents/" + startup.documentId)).json();
    const replied = await f.tool("reply_to_browser", {
      threadId,
      requestId: startup.requestId,
      answer: JSON.stringify({
        units: d.units
          .filter((u: any) => u.editable)
          .map((u: any) => ({ id: u.id, text: "修改后的文字。" })),
      }),
    });
    assert.ok(!replied.isError, JSON.stringify(replied));
    const polished = await (await f.api("/documents/" + d.id)).json();
    assert.equal(polished.original, text);
    assert.notEqual(polished.stage, "imported");
    assert.equal(polished.units[0].text, "修改后的文字。");
    await f.tool("open_bridge", { threadId, document });
    assert.equal((await (await f.api("/state")).json()).requests.length, 1);
  });

for (const cli of [false, true])
  test(`${cli ? "CLI" : "desktop"} batch opens five documents and completes each first phase without duplicate requests`, async (t) => {
    const f = await fixture(t, cli);
    const documents = Array.from({ length: 5 }, (_, i) => ({
      name: `${i + 1}.md`,
      text: `第 ${i + 1} 篇原文。`,
    }));
    const opened = (await f.tool("open_bridge", { threadId, documents }))
      .structuredContent;
    assert.equal(opened.startups.length, 5);
    assert.equal(opened.host, cli ? "codex-cli" : "codex-desktop");
    assert.match(opened.deliveryNote, /queued/);
    assert.equal(opened.documentId, opened.startups[0].documentId);
    const repeat = (await f.tool("open_bridge", { threadId, documents }))
      .structuredContent;
    assert.deepEqual(
      repeat.startups.map((s: any) => s.requestId),
      opened.startups.map((s: any) => s.requestId),
    );
    assert.equal((await (await f.api("/state")).json()).documents.length, 5);
    if (cli) {
      for (let i = 0; i < 300; i++) {
        if (
          (await (await f.api("/state")).json()).requests.every(
            (r: any) => r.status === "sent",
          )
        )
          break;
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.ok(
        (await (await f.api("/state")).json()).requests.every(
          (r: any) => r.status === "sent",
        ),
      );
    }
    for (const startup of opened.startups) {
      if (!cli) assert.ok((await f.tool("bridge_poll")).structuredContent.next);
      await f.tool("read_request_context", {
        threadId,
        requestId: startup.requestId,
      });
      const d = await (await f.api("/documents/" + startup.documentId)).json();
      const reply = await f.tool("reply_to_browser", {
        threadId,
        requestId: startup.requestId,
        answer: JSON.stringify({
          units: d.units
            .filter((u: any) => u.editable)
            .map((u: any) => ({ id: u.id, text: u.text + "润色。" })),
        }),
      });
      assert.ok(!reply.isError, JSON.stringify(reply));
    }
    const state = await (await f.api("/state")).json();
    assert.equal(state.requests.length, 5);
    assert.ok(state.requests.every((r: any) => r.status === "answered"));
    assert.ok(state.documents.every((d: any) => d.stage !== "imported"));
  });

test("invalid batch imports nothing and rejects conflicting single/batch arguments", async (t) => {
  const f = await fixture(t);
  const document = { name: "valid.md", text: "Valid text." };
  assert.equal(
    (
      await f.tool("open_bridge", {
        threadId,
        documents: [document, { path: join(f.dir, "missing.md") }],
      })
    ).isError,
    true,
  );
  assert.equal((await (await f.api("/state")).json()).documents.length, 0);
  assert.equal(
    (await f.tool("open_bridge", { threadId, document, documents: [document] }))
      .isError,
    true,
  );
  assert.equal(
    (await f.tool("open_bridge", { threadId, documents: [] })).isError,
    true,
  );
});

test("request ID routes context and reply automatically while preserving explicit mismatch checks", async (t) => {
  const f = await fixture(t);
  const d = await (
    await f.api("/documents", {
      name: "selected.md",
      text: "Selected passage.",
      format: "md",
    })
  ).json();
  const id = randomUUID();
  await f.api("/questions", {
    id,
    documentId: d.id,
    unitId: d.units[0].id,
    revision: d.revision,
    question: "Explain",
    selection: "Selected",
    selectionRange: { from: 0, to: 8 },
  });
  const claim = (await f.tool("bridge_poll")).structuredContent.next;
  assert.equal(claim.documentName, "selected.md");
  const context = await f.tool("read_request_context", { requestId: id });
  assert.equal(context.structuredContent.selection, "Selected");
  assert.equal(
    (
      await f.tool("reply_to_browser", {
        requestId: id,
        threadId: randomUUID(),
        answer: "wrong",
      })
    ).isError,
    true,
  );
  assert.equal(
    (await f.tool("reply_to_browser", { requestId: id, answer: "correct" }))
      .structuredContent.request.status,
    "answered",
  );
});

for (const cli of [false, true]) test(`${cli ? "CLI" : "desktop"} document questions return without reading context and cannot edit text`, async (t) => {
  const f = await fixture(t, cli);
  const d = await (await f.api('/documents',{name:'question.md',format:'md',text:'Original passage.'})).json();
  const id=randomUUID();
  await f.api('/questions',{id,documentId:d.id,unitId:d.units[0].id,revision:d.revision,selection:'Original',selectionRange:{from:0,to:8},question:'Explain the selection'});
  if (!cli) await f.tool('bridge_poll');
  else for(let i=0;i<100;i++) {
    if ((await(await f.api('/state')).json()).requests.find((r:any)=>r.id===id)?.status==='sent') break;
    await new Promise(r=>setTimeout(r,30));
  }
  const answer=JSON.stringify({text:'This is only an answer, not an edit.'});
  const reply=await f.tool('reply_to_browser',{requestId:id,answer});
  assert.equal(reply.structuredContent.request.status,'answered');
  assert.equal(reply.structuredContent.request.contextRead,undefined);
  assert.equal((await(await f.api('/documents/'+d.id)).json()).units[0].text,d.original);
  assert.equal((await f.api('/requests/apply',{id})).status,400);
  const cancelled=randomUUID();
  await f.api('/questions',{id:cancelled,documentId:d.id,unitId:d.units[0].id,revision:d.revision,question:'cancelled'});
  await f.api('/requests/cancel',{id:cancelled});
  assert.equal((await f.tool('reply_to_browser',{requestId:cancelled,answer:'late'})).isError,true);
});

test("UTF-8 chunk boundaries preserve protected Markdown through HTTP and MCP replies", async (t) => {
  const f = await fixture(t);
  const original =
    "Original prose.\n\n```text\n" + "中文🧪\n".repeat(5000) + "```\n";
  for (const transport of ["http", "mcp"]) {
    const source = transport + "\n\n" + original;
    const polished = source.replace("Original prose.", "Revised prose.");
    const opened = (
      await f.tool("open_bridge", {
        threadId,
        document: { name: `utf8-${transport}.md`, text: source },
      })
    ).structuredContent;
    const requestId = opened.startup.requestId;
    await f.tool("bridge_poll");
    const context = (await f.tool("read_request_context", { requestId }))
      .structuredContent;
    const args = {
      requestId,
      answer: JSON.stringify({
        units: [{ id: context.units[0].id, text: polished }],
      }),
    };
    if (transport === "http") {
      const bytes = Buffer.from(
        JSON.stringify({ name: "reply_to_browser", args }),
      );
      const split = bytes.indexOf(Buffer.from("中")) + 1;
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(bytes.subarray(0, split));
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.enqueue(bytes.subarray(split));
          controller.close();
        },
      });
      const response = await fetch(f.url.origin + "/mcp", {
        method: "POST",
        headers: f.headers,
        body,
        duplex: "half",
      } as any);
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.request.applied, true);
    } else {
      const result = await f.tool("reply_to_browser", args);
      assert.ok(!result.isError, JSON.stringify(result));
      assert.equal(result.structuredContent.request.applied, true);
    }
    const d = await (
      await f.api("/documents/" + opened.startup.documentId)
    ).json();
    assert.equal(d.original, source);
    assert.equal(d.units[0].text, polished);
  }
});

for (const cli of [false, true])
  test(`${cli ? "CLI" : "desktop"} last disconnect releases the port, stays stopped under polls, and preserves documents`, async (t) => {
    const f = await fixture(t, cli);
    const opened = (await f.tool("open_bridge", { threadId })).structuredContent;
    const sessionId = opened.sessionId;
    const peerId = randomUUID();
    await f.api("/mcp", { name: "open_bridge", args: { threadId: peerId } });
    const source = "Saved original.\n";
    const d = await (await f.api("/documents", { name: "saved.md", format: "md", text: source })).json();
    await f.api("/edit", { documentId: d.id, unitId: d.units[0].id, revision: 0, text: "Saved revision.\n" });
    const first = await (await f.api("/sessions/disconnect", { id: peerId })).json();
    assert.equal(first.sessions.length, 1);
    assert.equal((await f.api("/health")).status, 200);
    const final = cli
      ? await (await f.api("/sessions/disconnect", { id: sessionId })).json()
      : (await f.tool("workbench_api", {
          bridgeSessionId: sessionId, bridgeKey: opened.bridgeKey,
          sessionId, path: "/sessions/disconnect", body: { id: sessionId },
        })).structuredContent;
    assert.equal(final.ok, true);
    assert.deepEqual(final.sessions, []);
    let stopped = false;
    for (let i = 0; i < 100; i++) {
      try { await f.api("/health"); }
      catch { stopped = true; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(stopped, "last disconnect must stop the listener");
    // Bind the same address to prove that the port has actually been released.
    const { createServer } = await import("node:net");
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(Number(f.url.port), "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await f.tool("bridge_status", { sessionId });
    if (!cli) {
      await f.tool("bridge_poll");
      await f.tool("workbench_api", {
        bridgeSessionId: sessionId, bridgeKey: opened.bridgeKey,
        sessionId, path: "/sessions",
      });
    }
    // Let the CLI's automatic poll run too; it must not restart the hub.
    await new Promise((r) => setTimeout(r, 1100));
    await assert.rejects(f.api("/health"));
    const reopened = await f.tool("open_bridge", { threadId });
    assert.ok(!reopened.isError, JSON.stringify(reopened));
    const newPid = (await (await f.api("/health")).json()).pid;
    t.after(() => { try { process.kill(newPid, "SIGTERM"); } catch {} });
    const restored = await (await f.api("/documents/" + d.id)).json();
    assert.equal(restored.original, source);
    assert.equal(restored.units[0].text, "Saved revision.\n");
    assert.equal(restored.revision, 1);
  });
