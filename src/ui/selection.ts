import { diffChars } from "diff";

/** Map offsets in rendered text to its Markdown source, keeping formatting within the selection. */
export function sourceSelection(
  source: string,
  rendered: string,
  from: number,
  to: number,
) {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to <= from ||
    to > rendered.length
  )
    return null;
  let src = 0,
    visible = 0;
  const positions: number[] = [];
  for (const part of diffChars(source, rendered)) {
    if (part.removed) src += part.value.length;
    else if (part.added) {
      for (let i = 0; i < part.value.length; i++) positions[visible++] = src;
    } else {
      for (let i = 0; i < part.value.length; i++) positions[visible++] = src++;
    }
  }
  const start = positions[from],
    end = Math.min(source.length, positions[to - 1] + 1);
  return end > start ? { from: start, to: end } : null;
}
