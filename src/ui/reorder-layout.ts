/** Project a reordered strip without mutating its DOM or persisting intermediate orders. */
export function projectOrder(
  starts: number[],
  sizes: number[],
  source: number,
  center: number,
) {
  const remaining = starts.map((_, i) => i).filter((i) => i !== source);
  const target = remaining.filter(
    (i) => center > starts[i] + sizes[i] / 2,
  ).length;
  const order = [...remaining];
  order.splice(target, 0, source);
  const gaps = starts.slice(1).map((x, i) => x - starts[i] - sizes[i]);
  const gap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  let cursor = starts[0] || 0;
  const offsets = starts.map(() => 0);
  for (const index of order) {
    offsets[index] = cursor - starts[index];
    cursor += sizes[index] + gap;
  }
  return { target, offsets };
}
