import { moveBefore, ordered } from "../core/ordering.ts";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { Engine } from "../core/engine.ts";
export const PROTOCOL = "humanizer2-workspace-v4";
export const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
export const validSessionId = (id: unknown): id is string =>
  typeof id === "string" && validId(id.replace(/^codex-cli:/, ""));
export function sessionKey(threadId: string, host = "codex-desktop") {
  if (!validId(threadId)) throw Error("需要当前原聊天的准确 ID");
  if (!["codex-desktop", "codex-cli"].includes(host))
    throw Error("不支持的宿主");
  return host === "codex-cli" ? `codex-cli:${threadId}` : threadId;
}
export class Workspace {
  registry: DatabaseSync;
  engines = new Map<string, Engine>();
  token: string;
  port: number;
  dataDir: string;
  rules: { zh: string; en: string; academic: string };
  constructor(
    dataDir: string,
    rules: { zh: string; en: string; academic: string },
    requestedPort = 36678,
  ) {
    this.dataDir = dataDir;
    this.rules = rules;
    mkdirSync(join(dataDir, "sessions"), { recursive: true, mode: 0o700 });
    this.registry = new DatabaseSync(join(dataDir, "workspace.sqlite"));
    this.registry.exec(
      `PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,createdAt INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS experiences(id TEXT PRIMARY KEY,value TEXT NOT NULL);`,
    );
    chmodSync(join(dataDir, "workspace.sqlite"), 0o600);
    this.registry
      .prepare("INSERT OR IGNORE INTO meta VALUES(?,?)")
      .run("token", randomBytes(32).toString("hex"));
    this.registry
      .prepare("INSERT OR IGNORE INTO meta VALUES(?,?)")
      .run("port", String(requestedPort));
    this.token = (
      this.registry
        .prepare("SELECT value FROM meta WHERE key='token'")
        .get() as any
    ).value;
    this.port = Number(
      (
        this.registry
          .prepare("SELECT value FROM meta WHERE key='port'")
          .get() as any
      ).value,
    );
  }
  path(id: string) {
    if (!validSessionId(id)) throw Error("会话 ID 无效");
    return join(this.dataDir, "sessions", id + ".sqlite");
  }
  register(id: string, title?: string) {
    if (!validSessionId(id)) throw Error("需要当前原聊天的准确 ID");
    const count = (
      this.registry.prepare("SELECT count(*) AS n FROM sessions").get() as any
    ).n;
    this.registry
      .prepare("INSERT OR IGNORE INTO sessions VALUES(?,?,?)")
      .run(id, title?.trim().slice(0, 80) || `会话 ${count + 1}`, Date.now());
    if (title?.trim())
      this.registry
        .prepare("UPDATE sessions SET title=? WHERE id=?")
        .run(title.trim().slice(0, 80), id);
    this.registry
      .prepare("DELETE FROM meta WHERE key=?")
      .run("disconnected:" + id);
    const engine = this.engine(id);
    engine.paused = false;
    return engine;
  }
  engine(id: string) {
    if (
      !validSessionId(id) ||
      !this.registry.prepare("SELECT id FROM sessions WHERE id=?").get(id)
    )
      throw Error("会话未注册，请先从对应原聊天打开 Humanizer²");
    let e = this.engines.get(id);
    if (!e) {
      const store = new Store(
        this.path(id),
        join(this.dataDir, "workspace.sqlite"),
      );
      chmodSync(this.path(id), 0o600);
      e = new Engine(store, this.rules);
      e.bind(id.replace(/^codex-cli:/, ""));
      this.engines.set(id, e);
    }
    return e;
  }
  sessions() {
    return ordered(
      this.registry
        .prepare("SELECT * FROM sessions ORDER BY createdAt,id")
        .all() as any[],
      (
        this.registry
          .prepare("SELECT value FROM meta WHERE key='session-order'")
          .get() as any
      )?.value,
    )
      .filter((s: any) => !this.isDisconnected(s.id))
      .map((s: any) => ({
        ...s,
        connected: this.engines.get(s.id)?.bridgeStatus().connected || false,
      }));
  }
  isDisconnected(id: string) {
    return !!this.registry
      .prepare("SELECT value FROM meta WHERE key=?")
      .get("disconnected:" + id);
  }
  disconnect(id: string) {
    const e = this.engine(id);
    e.paused = true;
    this.registry
      .prepare("INSERT OR REPLACE INTO meta VALUES(?,?)")
      .run("disconnected:" + id, "true");
    return { ok: true };
  }
  reorderSessions(source: string, target: string) {
    const ids = moveBefore(
      this.sessions().map((s) => s.id),
      source,
      target,
    );
    this.registry
      .prepare("INSERT OR REPLACE INTO meta VALUES(?,?)")
      .run("session-order", JSON.stringify(ids));
    return { ok: true };
  }
  bridgeKey(id: string) {
    return createHmac("sha256", this.token)
      .update("bridge:" + id)
      .digest("hex");
  }
  verifyBridge(id: string, key: string) {
    this.engine(id);
    const expected = Buffer.from(this.bridgeKey(id)),
      supplied = Buffer.from(key || "");
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      throw Error("消息桥不属于此会话");
  }
  locate(requestId: string, threadId?: string, host = "codex-desktop") {
    if (!threadId) {
      if (!validId(requestId)) throw Error("请求 ID 无效");
      const matches = this.sessions()
        .filter((s) => s.id.startsWith("codex-cli:") === (host === "codex-cli"))
        .map((s) => this.engine(s.id))
        .filter((e) =>
          e.store.all<any>("requests").some((r) => r.id === requestId),
        );
      if (matches.length !== 1) throw Error("请求不存在或归属不唯一");
      return matches[0];
    }
    const e = this.engine(sessionKey(threadId, host));
    const r = e.store.get<any>("requests", requestId);
    if (r.threadId !== threadId) throw Error("请求属于另一个会话");
    return e;
  }
  reconcileHostThreads(ids: Set<string>, missing: Map<string, number>) {
    for (const session of this.sessions()) {
      if (session.id.startsWith("codex-cli:")) continue;
      const key = "host-seen:" + session.id;
      if (ids.has(session.id)) {
        this.registry
          .prepare("INSERT OR REPLACE INTO meta VALUES(?,?)")
          .run(key, "true");
        missing.delete(session.id);
      } else if (
        this.registry.prepare("SELECT value FROM meta WHERE key=?").get(key)
      ) {
        const count = (missing.get(session.id) || 0) + 1;
        missing.set(session.id, count);
        if (count >= 2) {
          // Remove the session from use; keep its sole document pair on disk for recovery.
          this.engines.get(session.id)?.store.close();
          this.engines.delete(session.id);
          this.registry
            .prepare("DELETE FROM sessions WHERE id=?")
            .run(session.id);
          this.registry.prepare("DELETE FROM meta WHERE key=?").run(key);
          missing.delete(session.id);
        }
      }
    }
  }
  close() {
    for (const e of this.engines.values()) e.store.close();
    this.registry.close();
  }
}
