export function moveBefore(ids: string[], source: string, target: string) {
  if (!ids.includes(source) || !ids.includes(target))
    throw Error("排序项目已改变，请刷新后重试");
  if (source === target) return ids;
  const result = ids.filter((id) => id !== source);
  const at = result.indexOf(target);
  // Moving forward lands after the target; moving backward lands before it.
  result.splice(
    at + (ids.indexOf(source) < ids.indexOf(target) ? 1 : 0),
    0,
    source,
  );
  return result;
}
export function ordered<T extends { id: string }>(
  items: T[],
  raw?: string | null,
): T[] {
  let ids: string[] = [];
  try {
    const value = JSON.parse(raw || "[]");
    if (Array.isArray(value)) ids = value;
  } catch {}
  const rank = new Map(ids.map((id, i) => [id, i]));
  return [...items].sort(
    (a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length),
  );
}
