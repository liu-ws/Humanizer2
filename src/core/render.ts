import type { Document } from "./store.ts";
export function renderPolished(d: Document) {
  return d.units.map((u) => u.text).join("");
}
