import { fromMarkdown } from "mdast-util-from-markdown";
import { decodeString } from "micromark-util-decode-string";

type Range = { from: number; to: number };
export type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  value?: unknown;
  alt?: unknown;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** A textarea counts CRLF as one character. The saved document keeps both. */
export function textareaSelection(
  source: string,
  value: string,
  from: number,
  to: number,
): Range | null {
  if (from >= to) return null;
  if (value === source) return { from, to };
  if (source.replace(/\r\n?/g, "\n") !== value) return null;
  for (const match of source.matchAll(/\r\n/g)) {
    if (match.index >= to) break;
    if (match.index < from) from++;
    to++;
  }
  return { from, to };
}

// In a render that only hides markup, a character's earliest and latest
// subsequence matches bound every possible alignment. Equal bounds identify
// its source position even if the selected passage occurs thousands of times.
function uniqueEndpoints(
  source: string,
  visible: string,
  from: number,
  to: number,
) {
  const boundary = visible[from] + visible[to - 1];
  // Ordinary spaces can be matched together with the full text. Rendered
  // line endings may be virtual, or may cover a CRLF pair in the source.
  if (/[\r\n]/.test(boundary)) return null;
  const ignoreWhitespace = !/\s/.test(boundary);
  let start = -1,
    end = -1,
    cursor = 0;
  for (let i = 0; i < visible.length; i++) {
    if (ignoreWhitespace && /\s/.test(visible[i])) continue;
    while (cursor < source.length && source[cursor] !== visible[i]) cursor++;
    if (cursor === source.length) return null;
    if (i === from) start = cursor;
    if (i === to - 1) end = cursor;
    cursor++;
  }
  if (start < 0 || end < 0) return null;
  cursor = source.length - 1;
  for (let i = visible.length - 1; i >= from; i--) {
    if (ignoreWhitespace && /\s/.test(visible[i])) continue;
    while (cursor >= 0 && source[cursor] !== visible[i]) cursor--;
    if ((i === from && start !== cursor) || (i === to - 1 && end !== cursor))
      return null;
    cursor--;
  }
  return { from: start, to: end + 1 };
}

// ProseMirror can insert block separators or hide soft breaks. Match only
// whitespace differences, checking all the text before trusting either offset.
function layoutRange(
  source: string,
  visible: string,
  from: number,
  to: number,
): Range | null {
  if (source === visible) return { from, to };
  let i = 0,
    j = 0,
    start = -1,
    end = -1;
  while (i < source.length || j < visible.length) {
    const a = i,
      b = j;
    while (i < source.length && /\s/.test(source[i])) i++;
    while (j < visible.length && /\s/.test(visible[j])) j++;
    if (i > a && j > b) {
      const same = source.slice(a, i) === visible.slice(b, j);
      if (from >= b && from < j) start = same ? a + from - b : a;
      if (to > b && to <= j) end = same ? a + to - b : i;
    }
    if (i === source.length && j === visible.length) break;
    if (source[i] !== visible[j]) return null;
    if (from === j) start = i;
    if (to === j + 1) end = i + 1;
    i++;
    j++;
  }
  return start >= 0 && start < end ? { from: start, to: end } : null;
}

type Span = { text: string; start: number; end: number; type: string };
const blockTypes = new Set([
  "heading",
  "paragraph",
  "tableCell",
  "code",
  "math",
  "yaml",
]);
const entity =
  /&(?:#(?:[0-9]{1,7}|[xX][\da-fA-F]{1,6})|[A-Za-z][A-Za-z0-9]{0,31});/;
const escapeOrEntity = new RegExp(
  "\\\\[!-/:-@\\x5b-\\x60{-~]|" + entity.source,
  "g",
);

function markdownSpans(tree: MarkdownNode) {
  const spans: Span[] = [];
  let lastBlockEnd: number | undefined;
  function walk(node: MarkdownNode) {
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (blockTypes.has(node.type) && start !== undefined && end !== undefined) {
      if (lastBlockEnd !== undefined)
        spans.push({
          text: "\n\n",
          start: lastBlockEnd,
          end: start,
          type: "separator",
        });
      lastBlockEnd = end;
    }
    if (node.children) {
      node.children.forEach(walk);
      return;
    }
    const value =
      node.type === "image" || node.type === "imageReference"
        ? node.alt
        : node.value;
    if (
      start !== undefined &&
      end !== undefined &&
      typeof value === "string" &&
      value &&
      node.type !== "definition"
    )
      spans.push({ text: value, start, end, type: node.type });
  }
  walk(tree);
  return spans;
}

// A displayed character from an HTML entity or backslash escape covers the
// entire source spelling. Decode with the same rules as the Markdown parser.
function decodedRange(
  raw: string,
  text: string,
  from: number,
  to: number,
): Range | null {
  const pieces: { at: number; raw: string; decoded: string }[] = [];
  let decoded = "",
    prev = 0;
  for (const match of raw.matchAll(escapeOrEntity)) {
    decoded += raw.slice(prev, match.index);
    const value = decodeString(match[0]);
    pieces.push({ at: decoded.length, raw: match[0], decoded: value });
    decoded += value;
    prev = match.index + match[0].length;
  }
  decoded += raw.slice(prev);
  const range =
    layoutRange(decoded, text, from, to) ??
    uniqueEndpoints(decoded, text, from, to);
  if (!range) return null;
  function offset(pos: number, isEnd: boolean) {
    let delta = 0;
    for (const piece of pieces) {
      if (pos < piece.at) break;
      if (pos < piece.at + piece.decoded.length && piece.decoded !== piece.raw)
        return piece.at + delta + (isEnd ? piece.raw.length : 0);
      delta += piece.raw.length - piece.decoded.length;
    }
    return pos + delta + (isEnd ? 1 : 0);
  }
  return { from: offset(range.from, false), to: offset(range.to - 1, true) };
}

function spanRange(
  source: string,
  span: Span,
  from: number,
  to: number,
): Range | null {
  let start = span.start,
    end = span.end;
  const raw = source.slice(start, end);
  switch (span.type) {
    case "separator": {
      // Between adjacent list items, both rendered newlines can refer to one
      // source line ending. Keep the neighboring item marker outside the quote.
      const lines = [...raw.matchAll(/\r\n?|\n/g)];
      if (!lines.length) return end > start ? { from: start, to: end } : null;
      const first = lines[from === 0 ? 0 : lines.length - 1];
      const last = lines[to === 1 ? 0 : lines.length - 1];
      return {
        from: start + first.index,
        to: start + last.index + last[0].length,
      };
    }
    case "code":
    case "math":
    case "yaml": {
      const fence = raw.match(
        /^ {0,3}(?:\x60{3,}|~{3,}|[$]{2,}|---)[^\r\n]*(?:\r\n?|\n)/,
      );
      if (fence) start += fence[0].length;
      break;
    }
    case "inlineCode":
    case "inlineMath": {
      const delimiter = raw.match(/^(?:\x60+|[$]+)/)?.[0];
      if (delimiter && raw.endsWith(delimiter)) {
        start += delimiter.length;
        end -= delimiter.length;
      }
      break;
    }
    case "image":
    case "imageReference": {
      // Restrict the search to the image label. A destination can contain the
      // same word as decoded alt text.
      const label = raw.match(/^!\[((?:\\[\s\S]|[^\[\]\\])*)\]/);
      if (!label) return null;
      start += 2;
      end = start + label[1].length;
      break;
    }
  }
  const content = source.slice(start, end);
  let local: Range | null;
  if (
    ["text", "image", "imageReference"].includes(span.type) &&
    content !== span.text
  )
    local = decodedRange(content, span.text, from, to);
  else {
    const at = content.indexOf(span.text);
    local =
      at >= 0
        ? { from: at + from, to: at + to }
        : (layoutRange(content, span.text, from, to) ??
          uniqueEndpoints(content, span.text, from, to));
  }
  return local && { from: start + local.from, to: start + local.to };
}

/** Map UTF-16 offsets in rendered text to its Markdown source. */
export function sourceSelection(
  source: string,
  rendered: string,
  from: number,
  to: number,
  parseMarkdown: (source: string) => MarkdownNode = fromMarkdown,
): Range | null {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to <= from ||
    to > rendered.length
  )
    return null;
  if (source === rendered) return { from, to };
  // Decoding can introduce characters that coincide with entirely unrelated
  // markup, such as an encoded link label that also appears in its destination.
  if (!entity.test(source)) {
    const exact = uniqueEndpoints(source, rendered, from, to);
    if (
      exact &&
      source[exact.from - 1] !== "\\" &&
      source[exact.to - 2] !== "\\"
    )
      return exact;
  }
  const spans = markdownSpans(parseMarkdown(source));
  const range = layoutRange(
    spans.map((span) => span.text).join(""),
    rendered,
    from,
    to,
  );
  if (!range) return null;
  let offset = 0,
    start = -1;
  for (const span of spans) {
    const next = offset + span.text.length;
    const hasStart = range.from >= offset && range.from < next;
    const hasEnd = range.to > offset && range.to <= next;
    if (hasStart || hasEnd) {
      const lo = hasStart ? range.from - offset : range.to - offset - 1;
      const hi = hasEnd ? range.to - offset : range.from - offset + 1;
      const local = spanRange(source, span, lo, hi);
      if (!local) return null;
      if (hasStart) start = local.from;
      if (hasEnd)
        return start >= 0 && start < local.to
          ? { from: start, to: local.to }
          : null;
    }
    offset = next;
  }
  return null;
}
