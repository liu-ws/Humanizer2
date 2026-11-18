import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { t } from "./i18n.ts";

// A textarea has no DOM Range. Keep one text node with the same wrapping so
// scrolling and keyboard selection can reuse the browser's laid-out text.
function sourceCaretMirror(el: HTMLTextAreaElement) {
  const mirror = document.createElement("div");
  const text = document.createTextNode("");
  const range = document.createRange();
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.cssText =
    "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;contain:layout style paint;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:break-word";
  mirror.append(text);
  document.body.append(mirror);
  let width = -1;
  let value: string | undefined;
  return {
    rect() {
      if (width !== el.clientWidth) {
        width = el.clientWidth;
        const style = getComputedStyle(el);
        for (const name of [
          "font-family",
          "font-size",
          "font-weight",
          "font-style",
          "font-stretch",
          "font-variant",
          "font-feature-settings",
          "line-height",
          "letter-spacing",
          "word-spacing",
          "text-align",
          "text-indent",
          "text-transform",
          "tab-size",
          "direction",
          "word-break",
          "padding-top",
          "padding-left",
          "padding-right",
        ])
          mirror.style.setProperty(name, style.getPropertyValue(name));
        mirror.style.width = width + "px";
      }
      if (value !== el.value) {
        value = el.value;
        // Give the caret after a final newline its own line box.
        text.data = value + "\u200b";
      }
      const offset =
        el.selectionDirection === "backward"
          ? el.selectionStart
          : el.selectionEnd;
      range.setStart(text, offset);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      const bounds = el.getBoundingClientRect();
      return new DOMRect(
        bounds.left + el.clientLeft + rect.left - el.scrollLeft,
        bounds.top + el.clientTop + rect.top - el.scrollTop,
        rect.width,
        rect.height,
      );
    },
    remove: () => mirror.remove(),
  };
}

export function SelectionQuote({
  container,
  source,
  onQuote,
}: {
  container: RefObject<HTMLDivElement | null>;
  source: boolean;
  onQuote: () => boolean;
}) {
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [unmapped, setUnmapped] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const dismissed = useRef(false);

  useEffect(() => {
    const editor = container.current!;
    const textarea = source ? editor.querySelector("textarea") : null;
    const pane = editor.closest(".editor-scroll") || editor;
    let mirror: ReturnType<typeof sourceCaretMirror> | undefined;
    let pointer: number | null = null;
    let frame = 0;
    dismissed.current = false;
    setPosition(null);
    setUnmapped(false);

    const positionButton = () => {
      frame = 0;
      if (pointer !== null || dismissed.current) return;
      const active = document.activeElement;
      if (!editor.contains(active) && active !== button.current) {
        setPosition(null);
        return;
      }
      let rect;
      if (textarea && textarea.selectionEnd > textarea.selectionStart) {
        mirror ??= sourceCaretMirror(textarea);
        rect = mirror.rect();
      } else if (!source) {
        const selection = window.getSelection();
        if (
          selection?.focusNode &&
          !selection.isCollapsed &&
          editor.contains(selection.focusNode) &&
          editor.contains(selection.anchorNode)
        ) {
          const caret = document.createRange();
          caret.setStart(selection.focusNode, selection.focusOffset);
          caret.collapse(true);
          rect = caret.getBoundingClientRect();
          if (
            !rect.height &&
            selection.focusNode.nodeType === Node.ELEMENT_NODE
          )
            rect = (selection.focusNode as Element).getBoundingClientRect();
        }
      }
      if (!rect?.height) {
        setPosition(null);
        return;
      }
      const bounds = pane.getBoundingClientRect();
      const topEdge = Math.max(8, bounds.top);
      const bottomEdge = Math.min(innerHeight - 8, bounds.bottom);
      if (rect.bottom < topEdge || rect.top > bottomEdge) {
        setPosition(null);
        return;
      }
      const width = button.current?.offsetWidth || 132;
      const height = button.current?.offsetHeight || 38;
      const left = Math.max(8, Math.min(innerWidth - width - 8, rect.left));
      const top =
        rect.bottom + 8 + height <= bottomEdge
          ? rect.bottom + 8
          : Math.max(topEdge, rect.top - height - 8);
      setPosition((prev) =>
        prev?.left === left && prev.top === top ? prev : { left, top },
      );
    };
    const schedule = () => {
      if (!frame && pointer === null && !dismissed.current)
        frame = requestAnimationFrame(positionButton);
    };
    const selectionChanged = () => {
      if (pointer !== null) return;
      dismissed.current = false;
      setUnmapped(false);
      schedule();
    };
    const start = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      pointer = event.pointerId;
      setPosition(null);
    };
    const finish = (event: PointerEvent) => {
      if (pointer !== event.pointerId) return;
      pointer = null;
      selectionChanged();
    };
    const reenter = (event: PointerEvent) => {
      // The release can land outside the workbench iframe.
      if (event.buttons === 0) finish(event);
    };
    const dismiss = () => {
      pointer = null;
      dismissed.current = true;
      setPosition(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    editor.addEventListener("pointerdown", start);
    editor.addEventListener("pointerenter", reenter);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("blur", dismiss);
    document.addEventListener("selectionchange", selectionChanged);
    textarea?.addEventListener("select", selectionChanged);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("focusin", schedule);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      mirror?.remove();
      editor.removeEventListener("pointerdown", start);
      editor.removeEventListener("pointerenter", reenter);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("selectionchange", selectionChanged);
      textarea?.removeEventListener("select", selectionChanged);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", schedule);
    };
  }, [container, source]);

  if (!position) return null;
  return createPortal(
    <button
      ref={button}
      className="selection-quote-button"
      type="button"
      style={position}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        if (onQuote()) {
          dismissed.current = true;
          setPosition(null);
        } else setUnmapped(true);
      }}
    >
      {unmapped
        ? t("请在源码模式引用这段文字", "Quote this passage in Source mode")
        : t("添加到对话", "Add to conversation")}
    </button>,
    document.body,
  );
}
