import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
export const dataDir =
  process.env.HUMANIZER2_DATA_DIR ||
  join(homedir(), ".local", "share", "humanizer2");
export function config() {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "workspace.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  db.prepare("INSERT OR IGNORE INTO meta VALUES(?,?)").run(
    "token",
    randomBytes(32).toString("hex"),
  );
  db.prepare("INSERT OR IGNORE INTO meta VALUES(?,?)").run(
    "port",
    process.env.HUMANIZER2_PORT || "36678",
  );
  const token = (
    db.prepare("SELECT value FROM meta WHERE key='token'").get() as any
  ).value;
  const port = Number(
    (db.prepare("SELECT value FROM meta WHERE key='port'").get() as any).value,
  );
  db.close();
  chmodSync(path, 0o600);
  return { token, port };
}
