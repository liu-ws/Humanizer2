import { test } from "node:test";
import assert from "node:assert/strict";
import { projectOrder } from "../src/ui/reorder-layout.ts";
test("neighbours move before release once the dragged centre crosses their midpoint", () => {
  const starts = [0, 104, 208],
    sizes = [100, 100, 100];
  assert.deepEqual(projectOrder(starts, sizes, 0, 140), {
    target: 0,
    offsets: [0, 0, 0],
  });
  assert.deepEqual(projectOrder(starts, sizes, 0, 160), {
    target: 1,
    offsets: [104, -104, 0],
  });
  assert.deepEqual(projectOrder(starts, sizes, 0, 270), {
    target: 2,
    offsets: [208, -104, -104],
  });
  assert.deepEqual(projectOrder(starts, sizes, 0, 50), {
    target: 0,
    offsets: [0, 0, 0],
  });
});
test("different width tabs reserve the actual source width while moving backwards", () => {
  assert.deepEqual(projectOrder([0, 84, 248], [80, 160, 120], 2, 40), {
    target: 0,
    offsets: [124, 124, -248],
  });
});
