import { requestMessage } from "../request-message.ts";
import { execFile } from "node:child_process";
import type { HostAdapter } from "../adapter.ts";

export type Forward = (name: string, args: any) => Promise<any>;
export type Queue = (threadId: string, message: string) => Promise<void>;

/** Queue on the existing session. Never launch exec, resume, or fork. */
export const queueMessage: Queue = (threadId, message) =>
  new Promise((resolve, reject) => {
    execFile(
      process.env.HUMANIZER2_CODEX_BIN || "codex",
      ["queue", "--thread", threadId, "--message", message],
      { timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    );
  });

export class CodexCliAdapter implements HostAdapter {
  readonly host = "codex-cli";
  private threadId: string | null = null;
  private sessionId = "";
  private bridgeKey = "";
  private busy = false;
  private connected = false;
  private timer?: ReturnType<typeof setInterval>;
  private forward: Forward;
  private queue: Queue;
  constructor(forward: Forward, queue: Queue = queueMessage) {
    this.forward = forward;
    this.queue = queue;
  }

  async bind(originalChatId: string) {
    if (!/^[a-f0-9-]{36}$/.test(originalChatId))
      throw Error("需要当前 Codex CLI 聊天的准确 UUID");
    if (this.threadId && this.threadId !== originalChatId)
      throw Error("适配器已绑定另一个聊天");
    const opened = await this.forward("open_bridge", {
      threadId: originalChatId,
      host: this.host,
    });
    this.threadId = originalChatId;
    this.sessionId = opened.sessionId;
    this.bridgeKey = opened.bridgeKey;
  }

  start() {
    if (!this.threadId) throw Error("请先绑定原聊天");
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), 1000);
      this.timer.unref();
      void this.tick();
    }
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.connected = false;
  }
  async tick() {
    if (this.busy || !this.threadId) return;
    this.busy = true;
    try {
      const polled = await this.forward("bridge_poll", {
        sessionId: this.sessionId,
        bridgeKey: this.bridgeKey,
        compact: true,
        capabilities: {
          host: this.host,
          transport: "codex-queue",
          cancel: "local-only",
          hostLivenessVerified: false,
        },
      });
      this.connected = !polled.disconnected;
      if (polled.next) await this.send(polled.next.id);
    } catch {
      this.connected = false;
      // A claimed request is never sent again. The engine expires stale claims.
    } finally {
      this.busy = false;
    }
  }
  async send(requestId: string): Promise<"sent" | "uncertain"> {
    if (!this.threadId) throw Error("请先绑定原聊天");
    // Recheck the claim, including cancellation, immediately before delivery.
    const state = await this.forward("bridge_status", {
      sessionId: this.sessionId,
    });
    const request = state.requests.find((r: any) => r.id === requestId);
    if (request?.status !== "dispatching" || request.threadId !== this.threadId)
      throw Error("请求未领取、已结束或属于另一个聊天");
    let status: "sent" | "uncertain" = "sent";
    let error: string | undefined;
    try {
      await this.queue(this.threadId, requestMessage(request, "codex-cli"));
    } catch {
      status = "uncertain";
      error =
        "codex queue 未确认成功；请检查原聊天和 CLI 服务，不会自动重复发送";
    }
    await this.forward("bridge_delivery", {
      sessionId: this.sessionId,
      bridgeKey: this.bridgeKey,
      requestId,
      status,
      error,
    });
    return status;
  }
  async cancel(requestId: string) {
    if (!this.threadId) throw Error("请先绑定原聊天");
    await this.forward("cancel_browser_request", {
      requestId,
      threadId: this.threadId,
      host: this.host,
    });
  }
  async status() {
    return { connected: this.connected, originalChatId: this.threadId };
  }
}
