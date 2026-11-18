import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
export const mathOptions = {
  trust: false,
  throwOnError: false,
  strict: "ignore" as const,
  maxExpand: 500,
  maxSize: 20,
};
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-rendered">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFrontmatter, remarkMath]}
        rehypePlugins={[[rehypeKatex, mathOptions]]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="image-placeholder">[图片：{alt || "未命名"}]</span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
