import { requestMessage } from "../request-message.ts";
// The workbench itself owns the host connection; there is no separate bridge UI.
let seq = 0,
  binding: any,
  capabilities: any = {},
  polling = false;
const pending = new Map<
  number,
  {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function rpc(method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("宿主连接超时"));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
}
async function tool(name: string, args: any) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw Error(r.content?.[0]?.text || "操作失败");
  return r.structuredContent || JSON.parse(r.content[0].text);
}
let opening: any,
  initializing = false;
function acceptResult(value: any) {
  let d = value?.structuredContent || value;
  if (!d?.sessionId && value?.content) {
    try {
      d = JSON.parse(value.content.find((x: any) => x.type === "text")?.text);
    } catch {}
  }
  if (
    d?.sessionId &&
    d?.bridgeKey &&
    (!binding || binding.sessionId === d.sessionId)
  ) {
    binding = d;
    void mount().catch(showError);
  }
}
function showError(e: any) {
  if (mounted) return;
  const root = document.getElementById("root")!;
  root.textContent = "工作台未连接：" + (e.message || e) + "。";
  const retry = document.createElement("button");
  retry.textContent = "重新连接";
  retry.onclick = () => void initialize();
  root.appendChild(retry);
}
async function recoverBinding() {
  const api = (window as any).openai;
  acceptResult(api?.toolOutput);
  const input = opening || api?.toolInput;
  if (!binding && input?.threadId)
    acceptResult(await tool("open_bridge", input));
}
let initialized = false,
  mounted = false;
async function mount() {
  if (!initialized || !binding || mounted) return;
  mounted = true;
  (window as any).h2Host = {
    sessionId: binding.sessionId,
    documentId: binding.documentId,
    newSession: async () => {
      const r = await rpc("ui/message", {
        role: "user",
        content: [
          {
            type: "text",
            text: "用户点击 Humanizer² 的新建对话按钮。请使用 create_thread 新建一个名为 Humanizer² 写作的新聊天，并在新聊天中调用 open_bridge 绑定该新聊天、打开工作台。不要将当前会话改绑。",
          },
        ],
        _meta: { "openai/message": { target: "active", send: true } },
      });
      if (r.isError) throw Error("新建对话请求未送达");
    },
    api: (path: string, body: any, sessionId: string) =>
      tool("workbench_api", {
        bridgeSessionId: binding.sessionId,
        bridgeKey: binding.bridgeKey,
        sessionId,
        path,
        ...(body === undefined ? {} : { body }),
      }),
    download: async (text: string, name: string) => {
      const bytes = new TextEncoder().encode(text);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      const r = await rpc("ui/download-file", {
        contents: [
          {
            type: "resource",
            resource: {
              uri: "file:///" + encodeURIComponent(name),
              mimeType: "text/plain",
              blob: btoa(binary),
            },
          },
        ],
      });
      if (r.isError) throw Error("宿主未能下载文件");
    },
  };
  try {
    await (window as any).h2FontReady;
    await import("../../ui/main.tsx");
  } catch (e) {
    mounted = false;
    throw e;
  }
  parent.postMessage(
    {
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 900 },
    },
    "*",
  );
  void poll();
}
window.addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (m?.jsonrpc !== "2.0") return;
  const p = pending.get(m.id);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(m.id);
    m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
  }
  if (m.method === "ui/notifications/tool-input") {
    opening = m.params?.arguments;
    if (initialized) void recoverBinding().catch(showError);
  }
  if (m.method === "ui/notifications/tool-result") {
    acceptResult(m.params);
  }
});
async function poll() {
  if (!initialized || !binding || polling) return;
  polling = true;
  try {
    const args = { sessionId: binding.sessionId, bridgeKey: binding.bridgeKey };
    const s = await tool("bridge_poll", {
      ...args,
      capabilities,
      compact: true,
    });
    if (s.next) {
      const r = s.next;
      try {
        await rpc("ui/message", {
          role: "user",
          content: [
            {
              type: "text",
              text: requestMessage(r, "codex-desktop"),
            },
          ],
          _meta: { "openai/message": { target: "active", send: true } },
        });
        await tool("bridge_delivery", {
          ...args,
          requestId: r.id,
          status: "sent",
        });
      } catch (e: any) {
        await tool("bridge_delivery", {
          ...args,
          requestId: r.id,
          status: "uncertain",
          error: e.message,
        });
      }
    }
  } catch {
  } finally {
    polling = false;
  }
}
async function initialize() {
  if (initializing) return;
  initializing = true;
  try {
    const r = await rpc("ui/initialize", {
      appInfo: { name: "humanizer2-workbench", version: "0.1.3" },
      appCapabilities: {},
      protocolVersion: "2026-01-26",
    });
    capabilities = r.hostCapabilities || {};
    parent.postMessage(
      { jsonrpc: "2.0", method: "ui/notifications/initialized" },
      "*",
    );
    initialized = true;
    await recoverBinding();
    await mount();
    if (!binding)
      setTimeout(() => {
        if (!binding)
          showError(
            Error("未收到本聊天的绑定信息，请在本聊天重新打开 Humanizer²"),
          );
      }, 15000);
  } catch (e: any) {
    mounted = false;
    showError(e);
  } finally {
    initializing = false;
  }
}
setInterval(() => {
  if (initialized) void poll();
}, 2000);
void initialize();
