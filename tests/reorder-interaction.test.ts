import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
test("pointer motion slides source and displaces neighbours before saving; release commits once", async () => {
  const code = buildSync({
    entryPoints: ["src/ui/useReorder.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["react"],
  }).outputFiles[0].text;
  const module = { exports: {} as any };
  const keys: any = {};
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: () => ({
      useRef: (value: any) => ({ current: value }),
      useEffect: (fn: any) => fn(),
    }),
    window: {
      addEventListener: (k: string, fn: any) => (keys[k] = fn),
      removeEventListener() {},
    },
    matchMedia: () => ({ matches: false }),
    setTimeout,
    requestAnimationFrame: (fn: any) => fn(),
  });
  const calls: any[] = [];
  const props = module.exports.useReorder(async (...args: any[]) => {
    calls.push(args);
  }, false);
  const parent: any = {
    querySelectorAll: () => items,
    getBoundingClientRect: () => ({ left: 0, right: 312, top: 0, bottom: 50 }),
    scrollLeft: 0,
    scrollTop: 0,
    scrollBy() {},
  };
  const items = Array.from({ length: 3 }, (_, i) => ({
    dataset: { sortKey: "sessions:" + i },
    style: {
      removeProperty(k: string) {
        delete (this as any)[k];
      },
    },
    getBoundingClientRect: () => ({
      left: i * 104,
      top: 0,
      width: 100,
      height: 40,
    }),
    parentElement: parent,
    setPointerCapture() {},
    hasPointerCapture: () => false,
    releasePointerCapture() {},
  }));
  const p = props("sessions", "0");
  const event = (x: number) => ({
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: 20,
    currentTarget: items[0],
    preventDefault() {},
    stopPropagation() {},
  });
  p.onPointerDown(event(50));
  p.onPointerMove(event(170));
  assert.equal((items[0].style as any).transform, "translateX(120px)");
  assert.equal((items[1].style as any).transform, "translateX(-104px)");
  assert.equal(
    calls.length,
    0,
    "drag previews must not write intermediate orders",
  );
  p.onPointerUp(event(170));
  await new Promise((r) => setTimeout(r, 210));
  assert.deepEqual(calls, [["sessions", "0", "1"]]);
  assert.equal((items[0].style as any).transform, undefined);
  p.onPointerDown(event(50));
  p.onPointerMove(event(270));
  keys.keydown({ key: "Escape" });
  assert.equal((items[1].style as any).transform, undefined);
  assert.equal(calls.length, 1, "cancelled drag never persists");
});
