import { validSessionId } from "./workspace.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
export async function workbenchApi(
  cfg: { port: number; token: string },
  args: any,
) {
  const expected = Buffer.from(
    createHmac("sha256", cfg.token)
      .update("bridge:" + args.bridgeSessionId)
      .digest("hex"),
  );
  const supplied = Buffer.from(
    typeof args.bridgeKey === "string" ? args.bridgeKey : "",
  );
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  )
    throw Error("工作台会话凭证无效");
  const path = args.path;
  const get =
    typeof path === "string" &&
    (/^\/(state|sessions)$/.test(path) ||
      /^\/documents\/[a-f0-9-]{36}$/.test(path) ||
      /^\/export\?id=[a-f0-9-]{36}$/.test(path));
  const post =
    typeof path === "string" &&
    /^\/(editing|preferences\/sync|questions|requests\/(cancel|apply)|documents|edit|enter|review\/complete|sessions\/(reorder|disconnect)|documents\/(reorder|attach|disconnect)|confirm|experiences\/(update|delete)|bridge\/pause)$/.test(
      path,
    );
  const hasBody = args.body !== undefined;
  if (!(hasBody ? post : get)) throw Error("不允许的工作台操作");
  if (!validSessionId(args.sessionId)) throw Error("会话 ID 无效");
  const response = await fetch(`http://127.0.0.1:${cfg.port}${path}`, {
    method: hasBody ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + cfg.token,
      "X-Humanizer-Session": args.sessionId,
      "Content-Type": "application/json",
    },
    body: hasBody ? JSON.stringify(args.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error((await response.json()).error || "工作台操作失败");
  return path.startsWith("/export?")
    ? { text: await response.text() }
    : await response.json();
}
