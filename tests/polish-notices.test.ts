import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "../src/core/store.ts";
import { polishNotices } from "../src/ui/polish-notices.ts";

const request = (overrides: Partial<Request>): Request => ({
  id: "old",
  threadId: "thread",
  documentId: "document",
  kind: "polish",
  question: "Polish",
  status: "failed",
  createdAt: 1,
  ...overrides,
});

test("an applied retry hides obsolete failures without deleting history", () => {
  const failed = request({});
  const success = request({
    id: "new",
    status: "answered",
    applied: true,
    createdAt: 2,
  });
  assert.deepEqual(polishNotices([failed, success], new Set()), []);
  assert.equal(failed.status, "failed");
  assert.deepEqual(
    polishNotices([failed, { ...success, applied: false }], new Set()),
    [failed, { ...success, applied: false }],
  );
});

test("dismissal hides terminal notices but not running work", () => {
  for (const status of ["failed", "cancelled"] as const)
    assert.deepEqual(
      polishNotices([request({ status })], new Set(["old"])),
      [],
    );
  for (const status of [
    "queued",
    "dispatching",
    "sent",
    "uncertain",
  ] as const) {
    const active = request({ status });
    assert.deepEqual(polishNotices([active], new Set(["old"])), [active]);
  }
});

test("another document or an earlier success cannot hide a new failure", () => {
  const failed = request({ createdAt: 3 });
  const earlier = request({ id: "earlier", status: "answered", applied: true });
  const other = request({
    id: "other",
    documentId: "other",
    status: "answered",
    applied: true,
    createdAt: 4,
  });
  assert.deepEqual(polishNotices([earlier, failed, other], new Set()), [
    failed,
  ]);
});
