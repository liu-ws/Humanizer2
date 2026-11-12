// UI-only preview: no model, no host adapter, no simulated AI responses.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
const child = spawn(
  process.execPath,
  ["plugins/codex-desktop/humanizer2/server.mjs"],
  {
    env: {
      ...process.env,
      HUMANIZER2_DATA_DIR: resolve(".humanizer2/preview"),
      HUMANIZER2_PORT: "0",
    },
    stdio: ["pipe", "pipe", "inherit"],
  },
);
createInterface({ input: child.stdout }).on("line", (line) => {
  const r = JSON.parse(line);
  if (r.id === 1) console.log(r.result.structuredContent.browserUrl);
});
child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "open_bridge",
      arguments: {
        threadId: "11111111-1111-4111-8111-111111111111",
        title: "界面验收 A",
      },
    },
  }) + "\n",
);
process.on("SIGTERM", () => child.kill());
process.on("SIGINT", () => child.kill());

child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "open_bridge",
      arguments: {
        threadId: "22222222-2222-4222-8222-222222222222",
        title: "界面验收 B",
      },
    },
  }) + "\n",
);
