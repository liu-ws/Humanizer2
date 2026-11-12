/** Hosts share the document/experience engine; only message transport is host-specific. */
export interface HostAdapter {
  readonly host:
    "codex-desktop" | "codex-cli" | "cc-desktop" | "cc-cli" | "dsh";
  bind(originalChatId: string): Promise<void>;
  send(requestId: string): Promise<"sent" | "uncertain">;
  cancel(requestId: string): Promise<void>;
  status(): Promise<{ connected: boolean; originalChatId: string | null }>;
}
// Codex Desktop transport lives in codex-desktop/embedded.ts (MCP App iframe).
// Codex CLI uses codex-cli/adapter.ts; Claude Code and DeepSeek Harness remain unimplemented.
