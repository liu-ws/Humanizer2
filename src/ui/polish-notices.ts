import type { Request } from "../core/store.ts";

export const canDismissPolishNotice = (request: Request) =>
  ["failed", "cancelled"].includes(request.status);

export function polishNotices(
  requests: Request[],
  dismissed: ReadonlySet<string>,
) {
  return requests.filter((request) => {
    if (request.kind !== "polish" || request.applied) return false;
    if (!canDismissPolishNotice(request)) return true;
    if (dismissed.has(request.id)) return false;
    return !requests.some(
      (later) =>
        later.kind === "polish" &&
        later.documentId === request.documentId &&
        later.applied &&
        later.createdAt >= request.createdAt,
    );
  });
}
