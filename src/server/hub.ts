import { readJsonBody } from "./request-body.ts";
import { importStartupDocuments, startupInputs } from "./startup-document.ts";
import { startLifecycleSync } from "../hosts/codex-desktop/lifecycle.ts";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { Workspace, PROTOCOL, sessionKey } from "./workspace.ts";
import { config, dataDir } from "./config.ts";
const root = dirname(fileURLToPath(import.meta.url));
const cfg = config();
const workspace = new Workspace(
  dataDir,
  {
    zh: readFileSync(join(root, "vendor/humanizer-zh/SKILL.md"), "utf8"),
    en: readFileSync(join(root, "vendor/humanizer/SKILL.md"), "utf8"),
    academic: readFileSync(
      join(root, "vendor/academic-humanizer/SKILL.md"),
      "utf8",
    ),
  },
  cfg.port,
);
let port = cfg.port;
function tool(name: string, args: any = {}) {
  switch (name) {
    case "open_bridge": {
      if (!args.threadId)
        throw Error("需要当前聊天的准确 threadId，请重新打开工作台并传入该 ID");
      const id = sessionKey(args.threadId, args.host);
      const engine = workspace.register(id, args.title);
      const startups = importStartupDocuments(engine, startupInputs(args));
      const startup = startups[0] || null;
      const host = args.host || "codex-desktop";
      return {
        ...engine.state(),
        sessionId: id,
        startup,
        startups,
        host,
        deliveryNote:
          host === "codex-cli"
            ? "queued 表示任务已保存，等待 CLI 中继发送及原聊天处理，尚未完成润色。请保持原 CLI 会话运行，并通过 bridge_status 检查请求状态。"
            : "queued 表示任务已保存，尚未开始润色。请在 Codex 桌面保持内嵌工作台打开以连接消息桥；单独打开浏览器网址不能连接桌面消息桥。终端请使用 humanizer2_cli 入口。",
        documentId: startup?.documentId,
        bridgeKey: workspace.bridgeKey(id),
        sessions: workspace.sessions(),
        browserUrl: `http://127.0.0.1:${port}/#token=${cfg.token}&session=${id}${startup ? "&document=" + startup.documentId : ""}`,
      };
    }
    case "bridge_status":
      return args.sessionId
        ? workspace.engine(args.sessionId).state()
        : { sessions: workspace.sessions() };
    case "bridge_poll":
      workspace.verifyBridge(args.sessionId, args.bridgeKey);
      if (workspace.isDisconnected(args.sessionId))
        return { next: null, disconnected: true };
      return workspace.engine(args.sessionId).poll(args.capabilities);
    case "bridge_delivery":
      workspace.verifyBridge(args.sessionId, args.bridgeKey);
      return {
        request: workspace
          .engine(args.sessionId)
          .delivery(args.requestId, args.status, args.error),
      };
    case "read_request_context":
      return workspace
        .locate(args.requestId, args.threadId, args.host)
        .context(args.requestId);
    case "reply_to_browser": {
      const engine = workspace.locate(args.requestId, args.threadId, args.host);
      return {
        request: engine.reply(
          args.requestId,
          engine.store.meta("threadId")!,
          args.answer,
        ),
      };
    }
    case "cancel_browser_request":
      return workspace
        .locate(args.requestId, args.threadId, args.host)
        .cancel(args.requestId);
    case "fail_browser_request": {
      const engine = workspace.locate(args.requestId, args.threadId, args.host);
      const r = engine.store.get<any>("requests", args.requestId);
      if (!["sent", "dispatching", "uncertain"].includes(r.status))
        throw Error("请求已结束");
      r.status = "failed";
      r.error = args.error;
      return { request: engine.store.put("requests", r) };
    }
    default:
      throw Error("Unknown tool");
  }
}
let shuttingDown = false;
const server = createServer(async (req, res) => {
  if (shuttingDown) {
    res.writeHead(503, { "Connection": "close" }).end();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  const origin = `http://127.0.0.1:${port}`;
  if (
    req.headers.host !== `127.0.0.1:${port}` ||
    (req.headers.origin && req.headers.origin !== origin)
  ) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url || "/", origin);
  const assets: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript"],
    "/app.css": ["app.css", "text/css"],
  };
  if (
    req.method === "GET" &&
    (assets[url.pathname] ||
      /^\/assets\/[a-zA-Z0-9_.-]+\.(woff2?|ttf)$/.test(url.pathname))
  ) {
    const [file, mime] = assets[url.pathname] || [
      url.pathname.slice(1),
      url.pathname.endsWith(".woff2")
        ? "font/woff2"
        : url.pathname.endsWith(".woff")
          ? "font/woff"
          : "font/ttf",
    ];
    try {
      res.setHeader("Content-Type", mime);
      res.end(readFileSync(join(root, "web", file)));
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  const supplied = Buffer.from(
    (req.headers.authorization || "").replace(/^Bearer /, ""),
  );
  if (
    supplied.length !== cfg.token.length ||
    !timingSafeEqual(supplied, Buffer.from(cfg.token))
  ) {
    res.writeHead(401).end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  try {
    let body: any = {};
    if (req.method === "POST") {
      body = await readJsonBody(req);
    }
    if (url.pathname === "/health") {
      res.end(
        JSON.stringify({
          protocol: PROTOCOL,
          version: "0.1.2",
          pid: process.pid,
        }),
      );
      return;
    }
    if (url.pathname === "/mcp" && req.method === "POST") {
      res.end(JSON.stringify(tool(body.name, body.args)));
      return;
    }
    let data: any;
    const path = url.pathname;
    const id =
      (req.headers["x-humanizer-session"] as string) ||
      url.searchParams.get("session") ||
      "";
    if (path === "/sessions") {
      res.end(JSON.stringify({ sessions: workspace.sessions() }));
      return;
    }
    if (path === "/sessions/reorder" && req.method === "POST") {
      workspace.engine(id);
      res.end(
        JSON.stringify(workspace.reorderSessions(body.source, body.target)),
      );
      return;
    }
    if (path === "/sessions/disconnect" && req.method === "POST") {
      workspace.engine(id);
      workspace.disconnect(body.id);
      const sessions = workspace.sessions();
      if (!sessions.length) {
        // Flush the final disconnect response before closing the listener.
        res.setHeader("Connection", "close");
        res.once("finish", () => {
          if (!workspace.sessions().length) shutdown();
        });
      }
      res.end(JSON.stringify({ ok: true, sessions }));
      return;
    }
    const engine = workspace.engine(id),
      store = engine.store;
    if (path === "/state" && req.method === "GET")
      data = {
        ...engine.state(),
        sessions: workspace.sessions(),
        history: store
          .orderedDocuments()
          .map((d) => ({ id: d.id, name: d.name, stage: d.stage })),
        documents: store.openDocuments().map((d) => ({
          id: d.id,
          name: d.name,
          stage: d.stage,
          revision: d.revision,
        })),
        experiences: store.experiences(),
      };
    else if (path === "/preferences/sync" && req.method === "POST")
      data = engine.syncPreferences(body.documentId);
    else if (path === "/editing" && req.method === "POST") {
      const d = store.document(body.documentId);
      if (!d.units.some((u) => u.id === body.unitId)) throw Error("文档不存在");
      store.meta(
        "editing:" + body.unitId,
        String(body.active ? Date.now() + 45000 : 0),
      );
      data = { ok: true };
    } else if (path === "/questions" && req.method === "POST")
      data = engine.submit(body);
    else if (path === "/requests/cancel" && req.method === "POST")
      data = engine.cancel(body.id);
    else if (path === "/requests/apply" && req.method === "POST")
      data = engine.apply(body.id);
    else if (path === "/documents" && req.method === "POST") {
      data = store.importOrOpen(
        body.name,
        body.text,
        body.format,
        body.genre,
        body.writingMode,
      );
    } else if (path.startsWith("/documents/") && req.method === "GET")
      data = store.document(decodeURIComponent(path.slice(11)));
    else if (path === "/edit" && req.method === "POST")
      data = store.edit(body.documentId, body.unitId, body.text, body.revision);
    else if (path === "/enter" && req.method === "POST")
      data = store.enter(body.documentId, body.unitId);
    else if (path === "/documents/attach" && req.method === "POST")
      data = store.attachDocument(body.id);
    else if (path === "/documents/disconnect" && req.method === "POST")
      data = store.detachDocument(body.id);
    else if (path === "/documents/reorder" && req.method === "POST")
      data = store.reorderDocuments(body.source, body.target);
    else if (path === "/review/complete" && req.method === "POST") {
      data = store.completeReview(body.documentId, body.unitId, body.revision);
      engine.syncSessionPreferences(data.id, body.skipDocumentIds || []);
    } else if (path === "/confirm" && req.method === "POST")
      data = store.transaction(() => {
        const out = store.confirm(
          body.documentId,
          body.unitId,
          body.revision,
          body.candidates || [],
          body.requestId,
        );
        if (body.syncPreferences) {
          engine.syncSessionPreferences(out.id, body.skipDocumentIds || []);
        }
        return out;
      });
    else if (path === "/experiences/update" && req.method === "POST")
      data = store.updateExperience(body.id, body);
    else if (path === "/experiences/delete" && req.method === "POST") {
      store.deleteExperience(body.id);
      data = { ok: true };
    } else if (path === "/bridge/pause" && req.method === "POST") {
      engine.paused = !!body.paused;
      data = engine.state();
    } else if (path === "/export" && req.method === "GET") {
      const d = store.document(url.searchParams.get("id") || "");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(d.name.replace(/\.(md|txt)$/i, "") + "-润色版." + d.format)}`,
      );
      res.end(store.polished(d));
      return;
    } else {
      res.writeHead(404).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    res.end(JSON.stringify(data));
  } catch (e: any) {
    res.writeHead(400).end(JSON.stringify({ error: e.message }));
  }
});
server.on("error", (error: any) => {
  workspace.close();
  if (error.code === "EADDRINUSE") process.exit(0);
  else {
    console.error(error.message);
    process.exit(1);
  }
});
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
port = (server.address() as any).port;
workspace.registry
  .prepare("UPDATE meta SET value=? WHERE key='port'")
  .run(String(port));
const stopLifecycle = startLifecycleSync(workspace);
// Closing one MCP connection is not a session disconnect. Keep other sessions alive.
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopLifecycle();
  server.close(() => {
    workspace.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", shutdown);
