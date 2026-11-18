import { moveBefore, ordered } from "./ordering.ts";
import { renderPolished } from "./render.ts";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { validateHumanEdit, language, type Unit } from "./documents.ts";
export type Document = {
  id: string;
  name: string;
  format: string;
  genre: string;
  original: string;
  revision: number;
  currentUnit: string | null;
  units: Unit[];
  stage: string;
  fullDocument: true;
  writingMode?: "general" | "academic";
};
export type Experience = {
  id: string;
  rule: string;
  language: string;
  genre: string;
  before: string;
  after: string;
  source: string;
  enabled: boolean;
  confirmed: boolean;
};
export type Request = {
  id: string;
  threadId: string;
  kind: string;
  question: string;
  documentId?: string;
  unitId?: string;
  unitIds?: string[];
  selection?: string;
  selectionText?: string;
  selectionRange?: { from: number; to: number };
  revision?: number;
  contextRead?: boolean;
  experienceStamp?: string;
  status: string;
  createdAt: number;
  dispatchedAt?: number;
  answeredAt?: number;
  answer?: string;
  data?: any;
  error?: string;
  applied?: boolean;
};
// The relay only needs pending work and syncs that can block a later sync.
const bridgeRequestsFilter = `json_extract(value, '$.status') IN ('queued', 'dispatching')
  OR (json_extract(value, '$.kind') = 'sync' AND json_extract(value, '$.status') IN ('sent', 'uncertain'))`;
export class Store {
  db: DatabaseSync;
  shared = false;
  constructor(path: string, sharedPath?: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS experiences(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS requests_bridge ON requests(id) WHERE ${bridgeRequestsFilter};
 CREATE INDEX IF NOT EXISTS documents_summary ON documents(
   id, json_extract(value, '$.name'), json_extract(value, '$.stage'), json_extract(value, '$.revision')
 );`);
    if (sharedPath) {
      this.db.prepare("ATTACH DATABASE ? AS shared").run(sharedPath);
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS shared.experiences(id TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT OR IGNORE INTO shared.experiences SELECT * FROM main.experiences; DELETE FROM main.experiences;",
      );
      this.shared = true;
    }
  }
  close() {
    this.db.close();
  }
  table(table: string) {
    if (!["documents", "requests", "experiences"].includes(table))
      throw Error("Unknown table");
    return table === "experiences" && this.shared
      ? "shared.experiences"
      : table;
  }
  all<T>(table: string): T[] {
    return this.db
      .prepare(`SELECT value FROM ${this.table(table)}`)
      .all()
      .map((x: any) => JSON.parse(x.value));
  }
  bridgeRequests(): Request[] {
    return this.db
      .prepare(`
        SELECT value FROM requests INDEXED BY requests_bridge
        WHERE ${bridgeRequestsFilter} ORDER BY rowid
      `)
      .all()
      .map((row: any) => JSON.parse(row.value));
  }
  get<T>(table: string, id: string): T {
    const row: any = this.db
      .prepare(`SELECT value FROM ${this.table(table)} WHERE id=?`)
      .get(id);
    if (!row) throw Error("记录不存在");
    return JSON.parse(row.value);
  }
  put(table: string, value: any) {
    this.db
      .prepare(
        `INSERT INTO ${this.table(table)}(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`,
      )
      .run(value.id, JSON.stringify(value));
    return value;
  }
  meta(key: string, value?: string): string | undefined {
    if (value !== undefined)
      this.db
        .prepare(
          "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, value);
    return (
      this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as any
    )?.value;
  }
  private transactionDepth = 0;
  transaction<T>(fn: () => T): T {
    const nested = this.transactionDepth > 0;
    const point = "h2_transaction_" + this.transactionDepth;
    this.db.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const out = fn();
      this.db.exec(nested ? `RELEASE SAVEPOINT ${point}` : "COMMIT");
      return out;
    } catch (e) {
      if (nested) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${point}`);
        this.db.exec(`RELEASE SAVEPOINT ${point}`);
      } else this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.transactionDepth--;
    }
  }
  import(
    name: string,
    text: string,
    format: string,
    genre = "通用",
    writingMode: "general" | "academic" = "general",
  ) {
    if (
      typeof name !== "string" ||
      typeof genre !== "string" ||
      genre.length > 120
    )
      throw Error("文档名称或文体无效");
    if (typeof text !== "string" || !text.trim() || text.length > 200000)
      throw Error("请输入 1–200000 字符");
    if (!["md", "txt"].includes(format))
      throw Error("仅支持 Markdown 和纯文本");
    const d: Document = {
      id: randomUUID(),
      name: name.slice(0, 160) || "未命名",
      format,
      genre,
      original: text,
      revision: 0,
      currentUnit: null,
      units: [
        {
          id: randomUUID(),
          start: 0,
          end: text.length,
          text,
          editable: true,
          language: language(text),
          revision: 0,
          reviewed: false,
          baseline: null,
        },
      ],
      fullDocument: true,
      writingMode,
      stage: "imported",
    };
    return this.put("documents", d);
  }
  document(id: string) {
    const d = this.get<Document>("documents", id);
    return d;
  }
  documentName(id: string): string {
    const row = this.db
      .prepare(`
        SELECT json_extract(value, '$.name') AS name
        FROM documents INDEXED BY documents_summary WHERE id=?
      `)
      .get(id);
    if (!row) throw Error("记录不存在");
    return row.name as string;
  }
  documentLists() {
    type Summary = Pick<Document, "id" | "name" | "stage" | "revision">;
    const rows = this.db.prepare(`
      SELECT d.id, json_extract(d.value, '$.name') AS name,
        json_extract(d.value, '$.stage') AS stage, json_extract(d.value, '$.revision') AS revision,
        m.value IS 'true' AS closed
      FROM documents AS d INDEXED BY documents_summary
      LEFT JOIN meta AS m ON m.key = 'closed:' || d.id ORDER BY d.rowid
    `).all() as (Summary & { closed: number })[];
    const documents = ordered(rows, this.meta("document-order"));
    return {
      history: documents.map(({ id, name, stage }) => ({ id, name, stage })),
      documents: documents
        .filter((d) => !d.closed)
        .map(({ closed, ...d }) => d),
    };
  }
  polished(d: Document) {
    return renderPolished(d);
  }
  stamp(d: Document, _unit?: Unit) {
    const rules = this.applicable(d)
      .map((e) => ({
        id: e.id,
        rule: e.rule,
        language: e.language,
        genre: e.genre,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return createHash("sha256").update(JSON.stringify(rules)).digest("hex");
  }
  importOrOpen(
    name: string,
    text: string,
    format: string,
    genre = "通用",
    writingMode: "general" | "academic" = "general",
  ) {
    const existing = this.all<Document>("documents").find(
      (d) =>
        d.original === text &&
        d.format === format &&
        d.genre === genre &&
        (d.writingMode || "general") === writingMode,
    );
    const d = existing
      ? this.document(existing.id)
      : this.import(name, text, format, genre, writingMode);
    return this.attachDocument(d.id);
  }
  attachDocument(id: string) {
    const d = this.document(id);
    this.meta("closed:" + id, "false");
    return d;
  }
  detachDocument(id: string) {
    this.document(id);
    this.meta("closed:" + id, "true");
    return { ok: true };
  }
  openDocuments() {
    return this.orderedDocuments().filter(
      (d) => this.meta("closed:" + d.id) !== "true",
    );
  }
  orderedDocuments() {
    return ordered(
      this.all<Document>("documents"),
      this.meta("document-order"),
    );
  }
  reorderDocuments(source: string, target: string) {
    const ids = moveBefore(
      this.orderedDocuments().map((d) => d.id),
      source,
      target,
    );
    this.meta("document-order", JSON.stringify(ids));
    return { ok: true };
  }
  edit(id: string, unitId: string, text: string, revision: number) {
    return this.transaction(() => {
      const d = this.document(id);
      const u = d.units.find((u) => u.id === unitId);
      if (!u?.editable) throw Error("该区域受保护");
      if (u.revision !== revision)
        throw Error("该段已在其他页面修改，请保留当前草稿并重新对照");
      const suffix = u.text.match(/\s+$/)?.[0] || "";
      if (suffix && !/\s$/.test(text)) text += suffix;
      validateHumanEdit(text);
      if (typeof text !== "string" || text.length > 200000)
        throw Error("文档内容无效");
      if (u.text !== text) {
        if (u.reviewed) u.baseline = u.text;
        u.baseline ??= u.text;
        u.text = text;
        u.language = language(text);
        u.revision++;
        u.reviewed = false;
        d.revision++;
        d.stage = "reviewing";
      }
      return this.put("documents", d);
    });
  }
  enter(id: string, unitId: string) {
    const d = this.document(id);
    const u = d.units.find((u) => u.id === unitId);
    if (!u?.editable) throw Error("段落不存在");
    u.baseline ??= u.text;
    d.currentUnit = unitId;
    return this.put("documents", d);
  }
  completeReview(id: string, unitId: string, revision: number) {
    return this.transaction(() => {
      const d = this.document(id),
        u = d.units.find((u) => u.id === unitId);
      if (!u || u.revision !== revision)
        throw Error("段落已改变，请重新完成审阅");
      u.reviewed = true;
      return this.put("documents", d);
    });
  }
  confirm(
    id: string,
    unitId: string,
    revision: number,
    candidates: any[],
    requestId?: string,
  ) {
    return this.transaction(() => {
      const d = this.document(id);
      const u = d.units.find((u) => u.id === unitId);
      if (!u || u.revision !== revision)
        throw Error("段落已改变，请重新查看 diff");
      if (candidates.some((c) => c.manual !== true)) {
        if (!requestId) throw Error("缺少经验提炼来源");
        const r = this.get<Request>("requests", requestId);
        if (
          r.kind !== "learn" ||
          r.documentId !== id ||
          r.unitId !== unitId ||
          r.revision !== d.revision ||
          r.status !== "answered"
        )
          throw Error("经验来源过期");
        if (u.baseline === null || u.baseline === u.text)
          throw Error("没有人工修改可供学习");
      }
      if (candidates.length > 0) {
        for (const c of candidates) {
          this.checkExperience(c);
          this.put("experiences", {
            ...c,
            id: randomUUID(),
            before: u.baseline,
            after: u.text,
            source: `${id}:${unitId}:${c.manual === true ? "manual" : requestId}`,
            enabled: true,
            confirmed: true,
          });
        }
      }
      u.baseline = null;
      u.reviewed = true;
      u.experienceStamp = this.stamp(d, u);
      this.put("documents", d);
      // Candidates and segment baselines are temporary, never a version history.
      for (const r of this.all<Request>("requests").filter(
        (r) => r.documentId === id && r.unitId === unitId && r.kind === "learn",
      )) {
        r.data = null;
        // Keep the conversation text, but clear editable candidate state.
        r.applied = true;
        this.put("requests", r);
      }
      return d;
    });
  }
  checkExperience(c: any) {
    if (
      typeof c.rule !== "string" ||
      !c.rule.trim() ||
      c.rule.length > 2000 ||
      !["zh", "en", "all"].includes(c.language) ||
      typeof c.genre !== "string"
    )
      throw Error("经验规则、语言或文体无效");
  }
  experiences() {
    return this.all<Experience>("experiences");
  }
  updateExperience(id: string, patch: any) {
    const e = this.get<Experience>("experiences", id);
    const updated = {
      ...e,
      rule: patch.rule ?? e.rule,
      language: patch.language ?? e.language,
      genre: patch.genre ?? e.genre,
      enabled: patch.enabled ?? e.enabled,
    };
    this.checkExperience(updated);
    return this.put("experiences", updated);
  }
  deleteExperience(id: string) {
    this.db
      .prepare(`DELETE FROM ${this.table("experiences")} WHERE id=?`)
      .run(id);
  }
  applicable(d: Document) {
    return this.experiences().filter(
      (e) =>
        e.confirmed &&
        e.enabled &&
        (e.genre === "通用" || e.genre === d.genre) &&
        (e.language === "all" ||
          (e.language === "zh" ? /\p{Script=Han}/u : /[A-Za-z]/).test(
            d.units.map((u) => u.text).join(""),
          ) ||
          d.units.some((u) => u.editable && u.language === e.language)),
    );
  }
}
