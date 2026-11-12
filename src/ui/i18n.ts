let language = "zh";
export function setUiLocale(value: string) {
  language = value;
}
const english: Record<string, string> = {
  中文: "Chinese",
  "请先处理段落冲突，草稿已保留":
    "Resolve the document conflict first. Your draft is retained.",
  导出失败: "Export failed",
  "文件过大，首版支持 20 万字符以内":
    "The file is too large. The limit is 200,000 characters.",
  记录不存在: "Record not found",
  "会话未注册，请先从对应原聊天打开 Humanizer²":
    "Session not registered. Open Humanizer² from its original chat.",
  "正文已被其他页面修改，请刷新后重试":
    "The document changed in another window. Refresh and try again.",
  "从原稿，到你的表达。": "From draft to your voice.",
  保存规则: "Save rule",
  保留: "Keep",
  修改例句与来源: "Examples and source",
  修改前: "Before",
  修改后: "After",
  全部语言: "All languages",
  删除: "Delete",
  "删除后不再用于写作。": "Deleted rules will no longer be applied.",
  "在这里粘贴原稿…": "Paste your draft here…",
  "学术写作 · academic-humanizer + 中英文规则":
    "Academic · academic-humanizer + language rules",
  "导入 Markdown、纯文本，或直接粘贴。原版始终保留，所有编辑只写入一份润色版。":
    "Import Markdown, plain text, or paste content. The original stays intact; edits update a single polished document.",
  导入并保留原版: "Import document",
  开始一篇新的文字: "Start a new document",
  文件名: "File name",
  文体: "Genre",
  格式: "Format",
  润色规则: "Writing rules",
  确认删除: "Delete",
  粘贴原稿: "Paste original",
  纯文本: "Plain text",
  经验适用文体: "Preference genre",
  英文: "English",
  表达规则: "Writing rule",
  适用文体: "Applicable genre",
  选择文件: "Choose file",
  "通用写作 · 中英文 humanizer": "General · Chinese and English humanizer",
  保存此经验: "Accept this preference",
  "已有同范围经验，请检查是否相似或冲突。可去经验库编辑合并，并取消此候选。":
    "Similar-scope preferences exist. Review possible overlap or conflicts; merge in Preferences or deselect this candidate.",
  "已核对，选择保留两条": "Reviewed: keep both rules",
  禁用: "Disable",
  启用: "Enable",
  经验候选: "Preference candidate",
  "问题已保存；原聊天连接后自动处理。": "Message queued for the original chat.",
  "已恢复未保存的本地草稿；连接恢复后会再次保存。":
    "Unsaved draft restored. Use Save to review your changes.",
  "生成期间已有编辑，保留为建议，未覆盖当前正文":
    "The document changed during generation. The result is retained as a suggestion.",
  "未同步：草稿仍保存在本机": "Not synced: draft retained locally",
};
Object.assign(english, {
  已保存: "Saved",
  "等待原聊天连接／处理": "Waiting for chat",
  正在发送: "Sending",
  原聊天处理中: "Processing",
  "发送结果待确认（不会自动重发）": "Delivery uncertain (no automatic resend)",
  已回答: "Answered",
  已取消: "Cancelled",
  失败: "Failed",
});
export function t(zh: string, en?: string) {
  return language === "en" ? en || english[zh] || zh : zh;
}
