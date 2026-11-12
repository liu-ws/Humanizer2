/** Ordinary questions may use the supplied selection and existing context. */
export function requestMessage(
  request: {
    id: string;
    documentName?: string;
    question: string;
    selection?: string;
    selectionText?: string;
  },
  host: "codex-desktop" | "codex-cli",
) {
  const service = host === "codex-cli" ? "humanizer2_cli" : "humanizer2";
  return [
    `Humanizer² 工作台请求。请求 ID：${request.id}`,
    `按需调用 ${service} 的 read_request_context（requestId）获取上下文，通过同一服务的 reply_to_browser（requestId、answer）回传。若请求已取消或结束，请停止处理。`,
    `文档：${request.documentName || "未关联文档"}`,
    `选中文字：\n${request.selectionText || request.selection || "（未选择文字，针对全文提问）"}`,
    `用户问题：\n${request.question}`,
  ].join("\n\n");
}
