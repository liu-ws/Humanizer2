import { build } from "esbuild";
import {
  cpSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
const logo = readFileSync("assets/logo.svg", "utf8");
const favicon = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(logo)}">`;
const host = process.argv[2] || "codex-desktop";
if (!["codex-desktop", "codex-cli"].includes(host))
  throw Error("Unsupported build target: " + host);
const out = `plugins/${host}/humanizer2`;
for (const dir of ["web", "vendor", "assets"])
  rmSync(out + "/" + dir, { recursive: true, force: true });
mkdirSync(out + "/web", { recursive: true });
mkdirSync(out + "/assets", { recursive: true });
cpSync("assets/logo.png", out + "/assets/logo.png");
cpSync("LICENSE", out + "/LICENSE");
await build({
  entryPoints: { server: "src/server/main.ts", hub: "src/server/hub.ts" },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  banner: {
    js: 'import { createRequire as h2CreateRequire } from "node:module"; const require = h2CreateRequire(import.meta.url);',
  },
  format: "esm",
  target: "node22",
  packages: "bundle",
});
await build({
  entryPoints: ["src/ui/main.tsx"],
  outfile: out + "/web/app.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  legalComments: "eof",
  loader: {
    ".svg": "dataurl",
    ".woff": "file",
    ".woff2": "file",
    ".ttf": "file",
  },
  assetNames: "assets/[name]-[hash]",
});
cpSync("vendor", out + "/vendor", { recursive: true });
writeFileSync(
  out + "/web/index.html",
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Humanizer²</title>' +
    favicon +
    '<link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script></html>',
);

if (host === "codex-desktop") {
  const embedded = await build({
    entryPoints: ["src/hosts/codex-desktop/embedded.ts"],
    outfile: "embedded.js",
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    loader: {
      ".svg": "dataurl",
      ".woff": "dataurl",
      ".woff2": "dataurl",
      ".ttf": "dataurl",
    },
    legalComments: "eof",
  });
  const js = embedded.outputFiles
    .find((f) => f.path.endsWith(".js"))
    .text.replace(/<\/script/gi, "<\\/script");
  const fontFaces = [];
  const css = embedded.outputFiles
    .find((f) => f.path.endsWith(".css"))
    .text.replace(/@font-face\{[^}]+\}/g, (rule) => {
      const data = rule.match(/url\(data:font\/woff2;base64,([^)]*)\)/);
      const family = rule.match(/font-family:([^;}]*)/);
      if (!data || !family)
        throw Error("Embedded font must include a bundled WOFF2 source");
      fontFaces.push({
        family: family[1].replace(/^['"]|['"]$/g, ""),
        data: data[1],
        weight: rule.match(/font-weight:([^;}]*)/)?.[1] || "400",
        style: rule.match(/font-style:([^;}]*)/)?.[1] || "normal",
      });
      return "";
    });
  // Load bundled bytes directly: CSS data: font URLs are not reliable in the host sandbox.
  const fontBootstrap = `window.h2FontReady=(async()=>{
 const results=await Promise.all(${JSON.stringify(fontFaces)}.map(async spec=>{
  try { const bytes=Uint8Array.from(atob(spec.data),c=>c.charCodeAt(0));
   const face=new FontFace(spec.family,bytes.buffer,{weight:spec.weight,style:spec.style});
   await face.load();document.fonts.add(face);return {family:spec.family,ok:true};
  } catch(error) { return {family:spec.family,ok:false,error:String(error)}; }
 }));
 document.documentElement.dataset.h2Fonts=results.every(x=>x.ok)?"loaded":"failed";
 document.documentElement.dataset.h2FontErrors=JSON.stringify(results.filter(x=>!x.ok));
 return results;
})();`;
  writeFileSync(
    out + "/workbench.html",
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Humanizer²</title>' +
      favicon +
      "<style>" +
      css +
      '</style><div id="root">正在连接当前聊天并加载工作台…</div><script>' +
      fontBootstrap +
      js +
      "</script></html>",
  );
}
