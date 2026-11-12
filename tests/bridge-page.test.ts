import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";

for (const encoding of ["structured", "text", "compatibility"])
  test(`embedded workbench mounts from ${encoding} result and retains its original chat`, async () => {
    const source = readFileSync(
      "src/hosts/codex-desktop/embedded.ts",
      "utf8",
    ).replace('await import("../../ui/main.tsx");', "await Promise.resolve();");
    const code = buildSync({stdin:{contents:source,loader:"ts",resolveDir:process.cwd()+"/src/hosts/codex-desktop"},bundle:true,write:false,format:"iife"}).outputFiles[0].text;
    const sent: any[] = [];
    let listener: any;
    const parent = {
      postMessage(m: any) {
        sent.push(m);
        if (m.id !== undefined)
          queueMicrotask(() =>
            listener({
              source: parent,
              data: {
                jsonrpc: "2.0",
                id: m.id,
                result:
                  m.method === "ui/initialize"
                    ? { hostCapabilities: { message: { text: {} } } }
                    : { structuredContent: { next: m.params?.name === "bridge_poll" ? {id:"req-1", threadId:"original",documentName:"论文.md",selection:"引用段落",question:"解释这段"} : null } },
              },
            }),
          );
      },
    };
    const window: any = {
      addEventListener(_: string, f: any) {
        listener = f;
      },
    };
    if (encoding === "compatibility")
      window.openai = {
        toolOutput: {
          sessionId: "original",
          bridgeKey: "key",
          documentId: "startup-doc",
        },
      };
    runInNewContext(code, {
      window,
      parent,
      document: {
        getElementById() {
          return {};
        },
      },
      setTimeout: () => 0,
      clearTimeout() {},
      setInterval() {},
      TextEncoder,
      btoa,
    });
    await new Promise((r) => setImmediate(r));
    if (encoding !== "compatibility") assert.equal(window.h2Host, undefined);
    const bind = (id: string) =>
      listener({
        source: parent,
        data: {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params:
            encoding === "structured"
              ? {
                  structuredContent: {
                    sessionId: id,
                    bridgeKey: "key",
                    documentId: "startup-doc",
                  },
                }
              : {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        sessionId: id,
                        bridgeKey: "key",
                        documentId: "startup-doc",
                      }),
                    },
                  ],
                },
        },
      });
    bind("original");
    await new Promise((r) => setImmediate(r));
    assert.equal(window.h2Host.sessionId, "original");
    assert.equal(window.h2Host.documentId, "startup-doc");
    assert.ok(sent.some((m) => m.params?.name === "bridge_poll"));
    const notification = sent.find(m => m.method === "ui/message").params.content[0].text;
    assert.match(notification, /论文.md/);
    assert.match(notification, /引用段落/);
    assert.match(notification, /解释这段/);
    assert.doesNotMatch(notification, /绑定原聊天|权限授权|不要新建/);
    bind("different");
    await window.h2Host.api("/state", undefined, "original");
    const api = sent.find((m) => m.params?.name === "workbench_api");
    assert.equal(api.params.arguments.bridgeSessionId, "original");
    assert.equal(api.params.arguments.sessionId, "original");
    assert.ok(!sent.some((m) => m.method === "ui/open-link"));
  });
