import { t } from "./i18n.ts";
import { createPortal } from "react-dom";
import React, { useEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import { editorViewOptionsCtx, serializerCtx } from "@milkdown/kit/core";
import { $prose, $node, $remark, replaceAll } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import remarkFrontmatter from "remark-frontmatter";
import { sourceSelection } from "./selection.ts";
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

// Textareas expose offsets but no DOM Range; mirror their layout to locate the selection end.
function sourceCaretRect(el: HTMLTextAreaElement): DOMRect {
  const style = getComputedStyle(el),
    bounds = el.getBoundingClientRect();
  const mirror = document.createElement("div");
  for (const name of Array.from(style))
    mirror.style.setProperty(name, style.getPropertyValue(name));
  Object.assign(mirror.style, {
    position: "fixed",
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: "auto",
    minHeight: "0",
    maxHeight: "none",
    visibility: "hidden",
    pointerEvents: "none",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    overflow: "visible",
  });
  const offset =
    el.selectionDirection === "backward" ? el.selectionStart : el.selectionEnd;
  mirror.textContent = el.value.slice(0, offset);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  // Retain following text so wrapping matches the textarea at word boundaries.
  mirror.append(document.createTextNode(el.value.slice(offset)));
  document.body.append(mirror);
  const rect = marker.getBoundingClientRect();
  mirror.remove();
  return new DOMRect(
    rect.x - el.scrollLeft,
    rect.y - el.scrollTop,
    rect.width,
    rect.height,
  );
}

type Quote = { displayText?: string; text: string; from: number; to: number };
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
  const [quote, setQuote] = useState<Quote | null>(null),
    [error, setError] = useState("");
  const [quotePosition, setQuotePosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const quoteButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!quote) {
      setQuotePosition(null);
      return;
    }
    let frame = 0;
    const position = () => {
      const editor = container.current;
      const active = document.activeElement;
      if (
        !editor ||
        (active && !editor.contains(active) && active !== quoteButton.current)
      ) {
        setQuotePosition(null);
        return;
      }
      let rect: DOMRect | undefined;
      if (source) {
        const textarea = editor.querySelector("textarea");
        if (!textarea || textarea.selectionStart === textarea.selectionEnd) {
          setQuotePosition(null);
          return;
        }
        rect = sourceCaretRect(textarea);
      } else {
        const selection = window.getSelection();
        if (
          !selection?.rangeCount ||
          selection.isCollapsed ||
          !editor.contains(selection.anchorNode) ||
          !editor.contains(selection.focusNode)
        ) {
          setQuotePosition(null);
          return;
        }
        const caret = document.createRange();
        caret.setStart(selection.focusNode!, selection.focusOffset);
        caret.collapse(true);
        rect = caret.getBoundingClientRect();
        if (!rect.height) {
          const rects = selection.getRangeAt(0).getClientRects();
          rect = rects[rects.length - 1];
        }
      }
      if (!rect) {
        setQuotePosition(null);
        return;
      }
      const pane = editor.closest(".editor-scroll") || editor;
      const bounds = pane.getBoundingClientRect();
      const topEdge = Math.max(8, bounds.top),
        bottomEdge = Math.min(innerHeight - 8, bounds.bottom);
      if (rect.bottom < topEdge || rect.top > bottomEdge) {
        setQuotePosition(null);
        return;
      }
      const width = quoteButton.current?.offsetWidth || 132;
      const height = quoteButton.current?.offsetHeight || 38;
      const top =
        rect.bottom + 8 + height <= bottomEdge
          ? rect.bottom + 8
          : Math.max(topEdge, rect.top - height - 8);
      setQuotePosition({
        left: Math.max(8, Math.min(innerWidth - width - 8, rect.left)),
        top,
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuote(null);
    };
    schedule();
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("focusin", schedule);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", schedule);
    };
  }, [quote, source]);
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
    const capture = (view: any) => {
      const { doc, selection } = view.state;
      if (selection.empty) {
        setQuote(null);
        return;
      }
      const leaf = (node: any) => node.attrs.value || node.attrs.alt || "";
      const rendered = doc.textBetween(0, doc.content.size, "\n\n", leaf);
      const from = doc.textBetween(0, selection.from, "\n\n", leaf).length;
      const selected = doc.textBetween(
        selection.from,
        selection.to,
        "\n\n",
        leaf,
      );
      const range = sourceSelection(
        latest.current,
        rendered,
        from,
        from + selected.length,
      );
      setQuote(
        range
          ? {
              ...range,
              displayText: selected,
              text: latest.current.slice(range.from, range.to),
            }
          : null,
      );
    };
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
                  if (!view.state.doc.eq(prev.doc)) {
                    const markdown = ctx.get(serializerCtx)(view.state.doc);
                    latest.current = markdown;
                    lastEmitted.current = markdown;
                    callbacks.current.onChange(markdown);
                  }
                  if (
                    !view.state.selection.eq(prev.selection) ||
                    !view.state.doc.eq(prev.doc)
                  )
                    capture(view);
                },
              }),
              props: {
                handleDOMEvents: {
                  blur: (view) => {
                    if (ready) capture(view);
                    return false;
                  },
                },
              },
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
      setQuote(null);
    }
  }, [value]);
  const quoteToChat = () => {
    if (!quote) return;
    callbacks.current.onSelect?.(quote.text);
    callbacks.current.onSelectionText?.(quote.displayText || quote.text);
    callbacks.current.onSelectionRange?.({ from: quote.from, to: quote.to });
    setQuote(null);
    setQuotePosition(null);
    document
      .querySelector<HTMLTextAreaElement>(".chat-composer textarea")
      ?.focus();
  };
  return (
    <div className="continuous-editor" ref={container}>
      {quote &&
        quotePosition &&
        createPortal(
          <button
            ref={quoteButton}
            className="selection-quote-button"
            type="button"
            style={{ left: quotePosition.left, top: quotePosition.top }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={quoteToChat}
          >
            {t("添加到对话", "Add to conversation")}
          </button>,
          document.body,
        )}
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
            setQuote(null);
          }}
          onSelect={(e) => {
            const el = e.currentTarget;
            setQuote(
              el.selectionEnd > el.selectionStart
                ? {
                    text: el.value.slice(el.selectionStart, el.selectionEnd),
                    from: el.selectionStart,
                    to: el.selectionEnd,
                  }
                : null,
            );
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
  useEffect(resize, [props.value]);
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
  return (
    <textarea
      {...props}
      ref={ref}
      onInput={(e) => {
        resize();
        props.onInput?.(e);
      }}
    />
  );
}
