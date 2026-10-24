/**
 * 本机批注工具的 HTTP 监听（MCP Streamable HTTP 的最小实现：只收 POST，回 JSON）。
 *
 * 只在桌面端用：移动端没有 Node 的 http 模块，loadHttp 先判 Platform.isDesktopApp。
 * 只监听 127.0.0.1；每个请求先过 checkBridgeRequest（路径、Host、Origin、口令、方法）。
 */
import { Platform } from "obsidian";
import { checkBridgeRequest, type BridgeRequestHead } from "./agentTools";

/** Node http 的最小类型（Obsidian 桌面端插件里 require("http") 可用）。 */
interface IncomingMessageLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "end" | "error", listener: (error?: unknown) => void): void;
  destroy(): void;
}

interface ServerResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

interface HttpServerLike {
  listen(port: number, host: string, callback: () => void): void;
  close(callback: () => void): void;
  on(event: "error", listener: (error: { code?: string; message?: string }) => void): void;
  closeAllConnections?(): void;
}

interface HttpModule {
  createServer(
    handler: (req: IncomingMessageLike, res: ServerResponseLike) => void
  ): HttpServerLike;
}

declare const require: (id: string) => unknown;

const MAX_BODY_BYTES = 1024 * 1024;

export interface BridgeServerOptions {
  port: number;
  token: string;
  /** 处理请求体；返回 null 表示只有通知（回 202）。 */
  handle(body: unknown): Promise<unknown>;
}

export interface BridgeServerHandle {
  close(): Promise<void>;
}

/** 端口被占用等启动失败：code 给界面区分提示。 */
export class BridgeStartError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "BridgeStartError";
  }
}

function send(res: ServerResponseLike, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function loadHttp(): HttpModule {
  if (Platform.isDesktopApp) {
    return require("http") as HttpModule;
  }
  throw new BridgeStartError("只有电脑版 Obsidian 能开本机批注工具", "NOT_DESKTOP");
}

export function startBridgeServer(
  options: BridgeServerOptions,
  httpModule?: HttpModule
): Promise<BridgeServerHandle> {
  let http: HttpModule;
  try {
    http = httpModule ?? loadHttp();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  const server = http.createServer((req, res) => {
    const head: BridgeRequestHead = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
    };
    const denied = checkBridgeRequest(head, options.token, options.port);
    if (denied) {
      if (denied.status === 405) {
        res.writeHead(405, { Allow: "POST" });
        res.end();
      } else {
        send(res, denied.status, { error: denied.message });
      }
      req.destroy();
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        send(res, 413, { error: "Payload Too Large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => {
      aborted = true;
    });
    req.on("end", () => {
      if (aborted) return;
      const total = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        total.set(chunk, offset);
        offset += chunk.length;
      }
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(total));
      } catch {
        send(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }
      options
        .handle(body)
        .then((reply) => {
          if (reply === null || reply === undefined) send(res, 202);
          else send(res, 200, reply);
        })
        .catch((error) => {
          console.error("[Writing Toolkit:agent-bridge] 处理请求失败", error);
          send(res, 500, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: "Internal error" },
          });
        });
    });
  });

  return new Promise((resolve, reject) => {
    let listening = false;
    server.on("error", (error) => {
      if (listening) {
        console.error("[Writing Toolkit:agent-bridge] 本机服务出错", error);
        return;
      }
      reject(
        new BridgeStartError(error.message ?? "未知错误", error.code ?? "UNKNOWN")
      );
    });
    server.listen(options.port, "127.0.0.1", () => {
      listening = true;
      resolve({
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // 有连接挂着时 close 要等它们断开；直接断掉，免得重载插件时端口还占着
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
