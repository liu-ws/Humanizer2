import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { Engine } from "../core/engine.ts";
import type { Request } from "../core/store.ts";

export type StartupDocument = {
  path?: string;
  name?: string;
  text?: string;
  format?: "md" | "txt";
  genre?: string;
  writingMode?: "general" | "academic";
};

/** Resolve local attachments in the MCP process, not the shared HTTP service. */
export async function resolveStartupDocument(input: StartupDocument) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("启动文档必须是对象");
  if (input.path !== undefined && input.text !== undefined)
    throw Error("文档路径与文本只能提供一种");
  let text = input.text;
  let name = input.name;
  let format = input.format;
  if (input.path !== undefined) {
    if (typeof input.path !== "string" || !isAbsolute(input.path))
      throw Error("请提供关联文档的绝对路径");
    const extension = extname(input.path).toLowerCase();
    if (![".md", ".markdown", ".txt"].includes(extension))
      throw Error("启动导入仅支持 Markdown 和 UTF-8 纯文本文件");
    const file = await open(
      input.path,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 800000)
        throw Error("请提供不超过 200000 字符的普通文本文件");
      // Bounded even if another process grows the file after stat().
      const buffer = Buffer.alloc(800001);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          size,
          buffer.length - size,
          null,
        );
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > 800000) throw Error("文档过大");
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      );
    } finally {
      await file.close();
    }
    name ??= basename(input.path);
    format ??= extension === ".txt" ? "txt" : "md";
  }
  const result = {
    name,
    text,
    format: format ?? "md",
    genre: input.genre ?? "通用",
    writingMode: input.writingMode ?? "general",
  };
  validateStartupDocument(result);
  return result as {
    name: string;
    text: string;
    format: "md" | "txt";
    genre: string;
    writingMode: "general" | "academic";
  };
}

function validateStartupDocument(input: any) {
  if (
    !input ||
    typeof input !== "object" ||
    input.path !== undefined ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    typeof input.text !== "string" ||
    !input.text.trim() ||
    input.text.length > 200000 ||
    input.text.includes("\0") ||
    !["md", "txt"].includes(input.format) ||
    typeof input.genre !== "string" ||
    input.genre.length > 120 ||
    !["general", "academic"].includes(input.writingMode)
  )
    throw Error("启动文档无效：需要名称、1–200000 字符正文及有效格式/写作模式");
}

export function importStartupDocument(engine: Engine, input: unknown) {
  validateStartupDocument(input);
  const source = input as Required<Omit<StartupDocument, "path">>;
  return engine.store.transaction(() => {
    let document = engine.store.importOrOpen(
      source.name,
      source.text,
      source.format,
      source.genre,
      source.writingMode,
    );
    const existing = engine.store
      .all<Request>("requests")
      .find((r) => r.documentId === document.id && r.kind === "polish");
    // Any previous attempt (including cancelled/failed) requires explicit user retry.
    const request =
      existing ||
      (document.stage === "imported"
        ? engine.submit({
            id: randomUUID(),
            documentId: document.id,
            revision: document.revision,
            kind: "polish",
            question:
              "请使用适用的中英文规则、写作模式和已确认偏好润色全文，保留为连续全文。",
          })
        : null);
    return {
      documentId: document.id,
      name: document.name,
      requestId: request?.id ?? null,
      status: request?.status ?? "skipped-edited",
      stage: document.stage,
    };
  });
}

export function startupInputs(args: {
  document?: unknown;
  documents?: unknown;
}): unknown[] {
  if (args.document !== undefined && args.documents !== undefined)
    throw Error("document 和 documents 只能提供一种");
  if (args.documents !== undefined) {
    if (
      !Array.isArray(args.documents) ||
      args.documents.length < 1 ||
      args.documents.length > 20
    )
      throw Error("每批需要 1–20 篇文档；更多文档可分批导入");
    return args.documents;
  }
  return args.document === undefined ? [] : [args.document];
}

export async function resolveStartupDocuments(args: {
  document?: unknown;
  documents?: unknown;
}) {
  const resolved = [];
  for (const input of startupInputs(args))
    resolved.push(await resolveStartupDocument(input as StartupDocument));
  if (Buffer.byteLength(JSON.stringify(resolved), "utf8") > 1800000)
    throw Error("本批文档总量过大，请分批导入；未导入本批任何文档");
  return resolved;
}

export function importStartupDocuments(engine: Engine, inputs: unknown[]) {
  for (const input of inputs) validateStartupDocument(input);
  return engine.store.transaction(() =>
    inputs.map((input) => importStartupDocument(engine, input)),
  );
}
