import { resolveStartupDocuments } from "./startup-document.ts";
import { CodexCliAdapter } from "../hosts/codex-cli/adapter.ts";
import { sessionKey } from "./workspace.ts";
import { spawn } from "node:child_process";
import { readFileSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { config, dataDir } from "./config.ts";
import { toolDefinitions, resourceUri, appIcons } from "./tools.ts";
import { PROTOCOL } from "./workspace.ts";
import { workbenchApi } from "./workbench-api.ts";
const root = dirname(fileURLToPath(import.meta.url));
let boundSession: string | undefined;
const cli = process.argv.includes("--codex-cli");
const cliAdapters = new Map<string, CodexCliAdapter>();
const exposedTools = cli
  ? toolDefinitions
      .filter(
        (t) =>
          !["workbench_api", "bridge_poll", "bridge_delivery"].includes(t.name),
      )
      .map(({ _meta, ...tool }) =>
        tool.name === "open_bridge"
          ? {
              ...tool,
              description:
                tool.description +
                " In Codex CLI, return browserUrl to the user and keep this session open for queued requests.",
            }
          : tool,
      )
  : toolDefinitions.map((tool) =>
      tool.name === "open_bridge"
        ? {
            ...tool,
            description:
              tool.description +
              " This is the DESKTOP entrypoint and requires the embedded desktop page to relay requests. In a terminal use humanizer2_cli instead; opening the browser URL alone does not connect this desktop relay.",
          }
        : tool,
    );
async function health() {
  const cfg = config();
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/health`, {
      headers: { Authorization: "Bearer " + cfg.token },
      signal: AbortSignal.timeout(400),
    });
    const data = await r.json();
    if (!r.ok || data.protocol !== PROTOCOL) return false;
    if (
      String(data.version || "0").localeCompare("0.1.3", undefined, {
        numeric: true,
      }) < 0
    ) {
      if (Number.isInteger(data.pid) && data.pid > 1) {
        try {
          process.kill(data.pid, "SIGTERM");
        } catch {}
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
async function ensureHub() {
  if (await health()) return;
  const log = openSync(join(dataDir, "service.log"), "a", 0o600);
  const child = spawn(process.execPath, [join(root, "hub.mjs")], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  closeSync(log);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await health()) return;
  }
  throw Error(
    "统一工作台未能启动。请检查 127.0.0.1:36678 是否被其他程序占用；不会改用另一个网址。",
  );
}
let starting: Promise<void> | null = null;
async function forward(name: string, args: any) {
  // Background polls and stale workbench pages must not revive an idle hub.
  // Only an explicit open reconnects the user and starts the service.
  if (name === "open_bridge") {
    if (!starting)
      starting = ensureHub().finally(() => {
        starting = null;
      });
    await starting;
  } else if (starting) await starting;
  const cfg = config();
  const r = await fetch(`http://127.0.0.1:${cfg.port}/mcp`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(20000),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "本地服务错误");
  return d;
}
const result = (data: any) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
});
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let m: any;
  try {
    m = JSON.parse(line);
    if (m.id === undefined) return;
    let data: any;
    if (m.method === "initialize")
      data = {
        protocolVersion: "2025-03-26",
        capabilities: cli ? { tools: {} } : { tools: {}, resources: {} },
        serverInfo: {
          name: "humanizer2",
          title: "Humanizer²",
          icons: appIcons,
          version: "0.1.3",
        },
      };
    else if (m.method === "ping") data = {};
    else if (m.method === "tools/list") data = { tools: exposedTools };
    else if (m.method === "tools/call") {
      try {
        if (!exposedTools.some((t) => t.name === m.params.name))
          throw Error("Unknown tool");
        const args = { ...m.params.arguments };
        if (m.params.name === "open_bridge") {
          args.documents = await resolveStartupDocuments(args);
          delete args.document;
          if (!args.documents.length) delete args.documents;
        }
        if (cli) {
          args.host = "codex-cli";
          if (args.sessionId)
            args.sessionId = sessionKey(args.sessionId, "codex-cli");
        }
        if (m.params.name === "bridge_status" && !args.sessionId)
          args.sessionId = boundSession;
        data = result(
          m.params.name === "workbench_api"
            ? await workbenchApi(config(), args)
            : await forward(m.params.name, args),
        );
        if (m.params.name === "open_bridge" && args.threadId) {
          boundSession = cli
            ? sessionKey(args.threadId, "codex-cli")
            : args.threadId;
          if (cli && !cliAdapters.has(args.threadId)) {
            const adapter = new CodexCliAdapter(forward);
            await adapter.bind(args.threadId);
            cliAdapters.set(args.threadId, adapter);
            adapter.start();
          }
        }
      } catch (e: any) {
        data = { isError: true, content: [{ type: "text", text: e.message }] };
      }
    } else if (m.method === "resources/list")
      data = {
        resources: cli
          ? []
          : [
              {
                uri: resourceUri,
                name: "Humanizer²",
                icons: appIcons,
                mimeType: "text/html;profile=mcp-app",
              },
            ],
      };
    else if (
      !cli &&
      m.method === "resources/read" &&
      m.params.uri === resourceUri
    )
      data = {
        contents: [
          {
            uri: resourceUri,
            mimeType: "text/html;profile=mcp-app",
            text: readFileSync(join(root, "workbench.html"), "utf8"),
            _meta: {
              ui: {
                prefersBorder: true,
                csp: { connectDomains: [], resourceDomains: [] },
              },
            },
          },
        ],
      };
    else throw Error("Unsupported method");
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: m.id, result: data }) + "\n",
    );
  } catch (e: any) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: m?.id ?? null,
        error: { code: -32603, message: e.message },
      }) + "\n",
    );
  }
});

lines.on("close", () => {
  for (const adapter of cliAdapters.values()) adapter.stop();
});
