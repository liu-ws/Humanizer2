import { t } from "./i18n.ts";
import { SelectionQuote } from "./SelectionQuote.tsx";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import {
  editorViewCtx,
  editorViewOptionsCtx,
  remarkCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { $prose, $node, $remark, replaceAll } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import remarkFrontmatter from "remark-frontmatter";
import {
  sourceSelection,
  textareaSelection,
  type MarkdownNode,
} from "./selection.ts";
import { mathOptions } from "./Markdown.tsx";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

const frontmatter = $remark("h2-frontmatter", () => remarkFrontmatter, [
  "yaml",
]);
const yaml = $node("yaml", () => ({
  group: "block",
  content: "text*",
  code: true,
  marks: "",
  defining: true,
  parseDOM: [{ tag: "pre[data-frontmatter]", preserveWhitespace: "full" }],
  toDOM: () => [
    "pre",
    { "data-frontmatter": "true", class: "document-frontmatter" },
    ["code", 0],
  ],
  parseMarkdown: {
    match: (n) => n.type === "yaml",
    runner: (state, node, type) => {
      state.openNode(type);
      if (node.value) state.addText(String(node.value));
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (n) => n.type.name === "yaml",
    runner: (state, node) => {
      state.addNode("yaml", undefined, node.textContent);
    },
  },
}));

export function LiveEditor({
  value,
  onChange,
  onSelect,
  onSelectionRange,
  onSelectionText,
  plain = false,
  sourceMode = false,
  onSourceModeChange,
  locale = "zh",
  label = t("全文编辑", "Document editor"),
}: {
  value: string;
  onChange: (text: string) => void;
  onSelect?: (text: string) => void;
  onSelectionText?: (text: string) => void;
  onSelectionRange?: (range: { from: number; to: number }) => void;
  plain?: boolean;
  sourceMode?: boolean;
  onSourceModeChange?: (source: boolean) => void;
  label?: string;
  locale?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null),
    instance = useRef<Crepe | null>(null);
  const suppress = useRef(false),
    lastEmitted = useRef(value);
  const latest = useRef(value),
    callbacks = useRef({
      onChange,
      onSelect,
      onSelectionRange,
      onSelectionText,
    });
  callbacks.current = { onChange, onSelect, onSelectionRange, onSelectionText };
  latest.current = value;
  const source = plain || sourceMode;
  const syntax = useRef<{ source: string; tree: MarkdownNode } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (source || !root.current) return;
    let disposed = false,
      ready = false,
      external = false;
    const crepe = new Crepe({
      root: root.current,
      defaultValue: latest.current,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.TopBar]: false,
        [Crepe.Feature.BlockEdit]: false,
        [Crepe.Feature.Toolbar]: false,
        [Crepe.Feature.ImageBlock]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: t("开始写作…", "Start writing…") },
        [Crepe.Feature.LinkTooltip]: {
          inputPlaceholder: t("粘贴链接…", "Paste link…"),
        },
        [Crepe.Feature.Latex]: { katexOptions: mathOptions },
        [Crepe.Feature.CodeMirror]: {
          previewOnlyByDefault: true,
          copyText: t("复制", "Copy"),
          searchPlaceholder: t("查找语言", "Search languages"),
          noResultText: t("无匹配语言", "No matching language"),
          previewLabel: t("预览", "Preview"),
          previewLoading: t("正在加载预览…", "Loading preview…"),
          previewToggleText: (only) =>
            only ? t("编辑源码", "Edit source") : t("仅预览", "Preview only"),
        },
      },
    });
    crepe.editor
      .use(frontmatter)
      .use(yaml)
      .config((ctx) => {
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: {
            ...prev.attributes,
            "aria-label": label,
            role: "textbox",
            "aria-multiline": "true",
          },
        }));
      })
      .use(
        $prose(
          (ctx) =>
            new Plugin({
              view: () => ({
                update(view, prev) {
                  if (!ready || disposed || external || suppress.current)
                    return;
                  if (view.state.doc.eq(prev.doc)) return;
                  const markdown = ctx.get(serializerCtx)(view.state.doc);
                  latest.current = markdown;
                  lastEmitted.current = markdown;
                  callbacks.current.onChange(markdown);
                },
              }),
            }),
        ),
      );
    instance.current = crepe;
    void crepe
      .create()
      .then(() => {
        if (disposed) {
          void crepe.destroy();
          return;
        }
        ready = true;
        // Changes arriving during async initialization must not be lost.
        if (latest.current !== value) {
          external = true;
          crepe.editor.action(replaceAll(latest.current));
          external = false;
        }
      })
      .catch((e) => {
        if (!disposed) {
          setError(String(e));
          onSourceModeChange?.(true);
        }
      });
    return () => {
      disposed = true;
      instance.current = null;
      if (ready) void crepe.destroy();
    };
  }, [source, plain, label, locale]);
  useEffect(() => {
    const crepe = instance.current;
    if (!crepe || crepe.editor.status !== "Created") return;
    // Parent echoes are already represented in the editor. Only replace remote updates.
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      suppress.current = true;
      try {
        crepe.editor.action(replaceAll(value));
      } finally {
        suppress.current = false;
      }
    }
  }, [value]);
  const quoteToChat = () => {
    const textarea = source
      ? container.current?.querySelector("textarea")
      : null;
    const crepe = instance.current;
    let range: { from: number; to: number } | null = null;
    let displayText = "";
    const markdown = latest.current;
    if (textarea) {
      const { selectionStart, selectionEnd, value } = textarea;
      range = textareaSelection(markdown, value, selectionStart, selectionEnd);
      displayText = value.slice(selectionStart, selectionEnd);
    } else if (!source && crepe?.editor.status === "Created") {
      range = crepe.editor.action((ctx) => {
        const { doc, selection } = ctx.get(editorViewCtx).state;
        if (selection.empty) return null;
        const leaf = (node: typeof doc) =>
          node.attrs.value || node.attrs.alt || "";
        const rendered = doc.textBetween(0, doc.content.size, "\n\n", leaf);
        const from = doc.textBetween(0, selection.from, "\n\n", leaf).length;
        displayText = doc.textBetween(
          selection.from,
          selection.to,
          "\n\n",
          leaf,
        );
        return sourceSelection(
          markdown,
          rendered,
          from,
          from + displayText.length,
          (source) => {
            if (syntax.current?.source !== source)
              syntax.current = {
                source,
                tree: ctx.get(remarkCtx).parse(source),
              };
            return syntax.current.tree;
          },
        );
      });
    }
    if (!range || range.from === range.to) return false;
    const text = markdown.slice(range.from, range.to);
    callbacks.current.onSelect?.(text);
    callbacks.current.onSelectionText?.(displayText || text);
    callbacks.current.onSelectionRange?.(range);
    document
      .querySelector<HTMLTextAreaElement>(".chat-composer textarea")
      ?.focus();
    return true;
  };
  return (
    <div className="continuous-editor" ref={container}>
      <SelectionQuote
        container={container}
        source={source}
        onQuote={quoteToChat}
      />
      {error && (
        <p role="alert">
          {t(
            "即时编辑器加载失败，可切换源码继续编辑：",
            "The editor could not load. Continue in Source mode: ",
          )}
          {error}
        </p>
      )}
      {source ? (
        <AutoTextarea
          className="document-source"
          aria-label={label}
          value={value}
          onChange={(e) => {
            latest.current = e.target.value;
            lastEmitted.current = e.target.value;
            onChange(e.target.value);
          }}
        />
      ) : (
        <div className="live-editor" ref={root} />
      )}
    </div>
  );
}
export function AutoTextarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.max(54, el.scrollHeight + 2) + "px";
    }
  };
  useLayoutEffect(resize, [props.value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        resize();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <textarea {...props} ref={ref} />;
}
