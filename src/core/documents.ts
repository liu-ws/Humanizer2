import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
const parse = (text: string) =>
  fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
export type Unit = {
  id: string;
  experienceStamp?: string;
  start: number;
  end: number;
  text: string;
  editable: boolean;
  language: "zh" | "en";
  revision: number;
  reviewed: boolean;
  baseline: string | null;
};
export function language(text: string): "zh" | "en" {
  return (text.match(/\p{Script=Han}/gu) || []).length >
    (text.match(/[A-Za-z]+/g) || []).length / 2
    ? "zh"
    : "en";
}
function skeleton(node: any): any {
  const out: any = { type: node.type };
  for (const k of [
    "depth",
    "url",
    "title",
    "identifier",
    "alt",
    "lang",
    "meta",
    "ordered",
    "start",
    "spread",
    "checked",
  ])
    if (node[k] !== undefined) out[k] = node[k];
  if (
    [
      "code",
      "inlineCode",
      "html",
      "definition",
      "image",
      "imageReference",
    ].includes(node.type)
  )
    out.value = node.value;
  if (node.children) out.children = node.children.map(skeleton);
  return out;
}
function protectedText(text: string) {
  const items: string[] = [];
  const fm = text.match(
    /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,
  )?.[0];
  if (fm) items.push(fm);
  const walk = (n: any) => {
    if (["table", "code", "html"].includes(n.type))
      items.push(text.slice(n.position.start.offset, n.position.end.offset));
    else n.children?.forEach(walk);
  };
  walk(parse(text));
  return items;
}
export function validateEdit(before: string, after: string, format: string) {
  if (typeof after !== "string" || after.length > 200000)
    throw Error("文档内容无效或过长");
  if (
    format === "md" &&
    (JSON.stringify(protectedText(before)) !==
      JSON.stringify(protectedText(after)) ||
      JSON.stringify(skeleton(parse(before))) !==
        JSON.stringify(skeleton(parse(after))))
  )
    throw Error("修改改变了 Markdown 结构、代码或链接目标；请仅修改正文表达");
}

/** Explicit human editing may change Markdown structure; AI edits use validateEdit. */
export function validateHumanEdit(after: string) {
  if (typeof after !== "string" || after.length > 200000)
    throw Error("文档内容无效或过长");
}
