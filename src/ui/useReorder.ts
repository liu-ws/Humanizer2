import { useEffect, useRef } from "react";
import type { PointerEvent, MouseEvent } from "react";
import { projectOrder } from "./reorder-layout.ts";
type Group = "sessions" | "documents";
type Drag = {
  group: Group;
  id: string;
  element: HTMLElement;
  parent: HTMLElement;
  items: HTMLElement[];
  starts: number[];
  sizes: number[];
  source: number;
  target: number;
  pointer: number;
  start: number;
  scroll: number;
  moved: boolean;
  settling: boolean;
  offsets: number[];
};
export function useReorder(
  commit: (group: Group, source: string, target: string) => Promise<void>,
  disabled: boolean,
) {
  const dragging = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const translate = (d: Drag, item: HTMLElement, amount: number) => {
    item.style.transform =
      d.group !== "sessions"
        ? `translateY(${amount}px)`
        : `translateX(${amount}px)`;
  };
  const cleanup = (d: Drag) => {
    for (const el of d.items) {
      el.style.removeProperty("transform");
      el.style.removeProperty("transition");
      el.style.removeProperty("z-index");
      el.style.removeProperty("position");
      el.style.removeProperty("will-change");
      delete el.dataset.dragging;
    }
    if (dragging.current === d) dragging.current = null;
  };
  const cancel = () => {
    const d = dragging.current;
    if (!d || d.settling) return;
    suppressClick.current = d.moved;
    cleanup(d);
    if (d.element.hasPointerCapture(d.pointer))
      d.element.releasePointerCapture(d.pointer);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", cancel);
      if (dragging.current) cleanup(dragging.current);
    };
  }, []);
  return (group: Group, id: string) => ({
    draggable: false,
    "data-sort-key": group + ":" + id,
    "data-sortable": !disabled || undefined,
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (disabled || e.button !== 0 || dragging.current) return;
      suppressClick.current = false;
      const element = e.currentTarget,
        parent = element.parentElement!;
      const items = Array.from(
        parent.querySelectorAll<HTMLElement>(`[data-sort-key^="${group}:"]`),
      );
      const vertical = group !== "sessions";
      const rects = items.map((el) => el.getBoundingClientRect());
      const source = items.indexOf(element);
      dragging.current = {
        group,
        id,
        element,
        parent,
        items,
        source,
        target: source,
        pointer: e.pointerId,
        starts: rects.map((r) => (vertical ? r.top : r.left)),
        sizes: rects.map((r) => (vertical ? r.height : r.width)),
        start: vertical ? e.clientY : e.clientX,
        scroll: vertical ? parent.scrollTop : parent.scrollLeft,
        moved: false,
        settling: false,
        offsets: items.map(() => 0),
      };
      element.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const d = dragging.current;
      if (!d || d.settling || disabled) return;
      const vertical = d.group !== "sessions",
        coordinate = vertical ? e.clientY : e.clientX;
      if (!d.moved && Math.abs(coordinate - d.start) < 6) return;
      e.preventDefault();
      if (!d.moved) {
        d.moved = true;
        d.element.dataset.dragging = "true";
        d.element.style.position = "relative";
        d.element.style.zIndex = "5";
        for (const el of d.items) {
          el.style.willChange = "transform";
          el.style.transition =
            el === d.element || reduced()
              ? "none"
              : "transform 180ms cubic-bezier(.2,.8,.2,1)";
        }
      }
      const bounds = d.parent.getBoundingClientRect();
      const edgeStart = vertical ? bounds.top : bounds.left,
        edgeEnd = vertical ? bounds.bottom : bounds.right;
      const step =
        coordinate < edgeStart + 32 ? -10 : coordinate > edgeEnd - 32 ? 10 : 0;
      if (step) d.parent.scrollBy(vertical ? { top: step } : { left: step });
      const delta =
        coordinate -
        d.start +
        (vertical ? d.parent.scrollTop : d.parent.scrollLeft) -
        d.scroll;
      const lo = d.starts[0] - d.starts[d.source],
        hi =
          d.starts.at(-1)! +
          d.sizes.at(-1)! -
          d.starts[d.source] -
          d.sizes[d.source];
      const movement = Math.max(lo, Math.min(hi, delta));
      const projection = projectOrder(
        d.starts,
        d.sizes,
        d.source,
        d.starts[d.source] + movement + d.sizes[d.source] / 2,
      );
      d.target = projection.target;
      d.offsets = projection.offsets;
      d.items.forEach((el, i) =>
        translate(d, el, i === d.source ? movement : d.offsets[i]),
      );
    },
    onPointerUp(e: PointerEvent<HTMLElement>) {
      const d = dragging.current;
      if (!d || d.settling) return;
      if (!d.moved) {
        cleanup(d);
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        return;
      }
      e.preventDefault();
      suppressClick.current = true;
      d.settling = true;
      d.element.style.transition = reduced()
        ? "none"
        : "transform 160ms cubic-bezier(.2,.8,.2,1)";
      translate(d, d.element, d.offsets[d.source]);
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      const target = d.items[d.target].dataset.sortKey!.slice(group.length + 1);
      void (async () => {
        // Keep the projected gap until the persisted order is rendered, then release transforms together.
        await new Promise((r) => setTimeout(r, reduced() ? 0 : 170));
        try {
          if (!disabled && d.target !== d.source)
            await commit(group, d.id, target);
        } finally {
          requestAnimationFrame(() => cleanup(d));
        }
      })();
    },
    onPointerCancel: cancel,
    onLostPointerCapture: () => {
      if (!dragging.current?.settling) cancel();
    },
    onClickCapture(e: MouseEvent<HTMLElement>) {
      if (suppressClick.current) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick.current = false;
      }
    },
  });
}
