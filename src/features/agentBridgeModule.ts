import { Notice, type App } from "obsidian";
import type { FeatureModule } from "../host/pluginHost";
import { AGENT_TOOLS_SERVER_NAME } from "../comments";
import {
  DEFAULT_BRIDGE_PORT,
  buildConnectionConfig,
  handleMcpBody,
  isAgentClient,
  isValidBridgePort,
  type AgentClient,
  type AgentToolsPort,
} from "../agentTools";
import {
  BridgeStartError,
  startBridgeServer,
  type BridgeServerHandle,
} from "../agentBridgeServer";

/**
 * 本机批注工具（给 Agent 用的 MCP）：开关、端口、口令和监听的生命周期。
 *
 * - 只在桌面端：移动端没有 Node 的 http，开关也不显示。
 * - 开关 / 端口 / 口令 / 上次选的 Agent 都存在这台电脑上（app.saveLocalStorage，按库区分），**不放 data.json**：
 *   data.json 会随同步被别的设备整份覆盖（设计文档 §5.2 第 58 条），口令也不该跟着同步走。
 * - 工具本身的读写由 comments 模块实现（AgentToolsPort），这里只负责把请求接进来。
 */
export interface AgentBridgeStatus {
  /** 这台设备能不能开（桌面端才能） */
  available: boolean;
  enabled: boolean;
  running: boolean;
  port: number;
  /** 最近一次启动失败的原因（给设置页显示）；没有为 null */
  error: string | null;
  /** 「复制给」上次选的 Agent */
  client: AgentClient;
}

export interface AgentBridgeOperations {
  status(): AgentBridgeStatus;
  setEnabled(on: boolean): Promise<void>;
  setPort(port: number): Promise<void>;
  /** 换一个新口令（旧的连接命令随即失效） */
  regenerateToken(): Promise<void>;
  /** 「复制给」选哪个 Agent（记在这台电脑上） */
  setClient(client: AgentClient): void;
  /** 当前选中 Agent 的连接配置：text 复制，done 是复制后的提示 */
  connectionConfig(): { text: string; done: string };
  subscribe(listener: () => void): () => void;
}

export interface AgentBridgeModule extends FeatureModule {
  readonly operations: AgentBridgeOperations;
}

export interface AgentBridgeStorage {
  load(): unknown;
  save(data: unknown): void;
}

export interface AgentBridgeModuleOptions {
  /** 桌面端才能开本机服务 */
  isDesktop(): boolean;
  /** comments 模块的批注读写端口 */
  tools(): AgentToolsPort;
  /** 插件版本（MCP serverInfo 用） */
  version: string;
}

export interface AgentBridgeModuleFactories {
  readonly createStorage?: (app: App) => AgentBridgeStorage;
  readonly startServer?: typeof startBridgeServer;
}

const STORAGE_KEY = "writing-toolkit-agent-bridge";

interface StoredBridge {
  enabled: boolean;
  port: number;
  token: string;
  client: AgentClient;
}

function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function readStored(raw: unknown): StoredBridge {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<StoredBridge>;
  return {
    enabled: data.enabled === true,
    port: isValidBridgePort(data.port) ? data.port : DEFAULT_BRIDGE_PORT,
    token: typeof data.token === "string" && data.token.length >= 32 ? data.token : "",
    client: isAgentClient(data.client) ? data.client : "claude",
  };
}

function defaultStorage(app: App): AgentBridgeStorage {
  return {
    load: () => app.loadLocalStorage(STORAGE_KEY) as unknown,
    save: (data) => app.saveLocalStorage(STORAGE_KEY, data),
  };
}

export function createAgentBridgeModule(
  options: AgentBridgeModuleOptions,
  factories: AgentBridgeModuleFactories = {}
): AgentBridgeModule {
  const startServer = factories.startServer ?? startBridgeServer;
  let storage: AgentBridgeStorage | null = null;
  let stored: StoredBridge = readStored(null);
  let server: BridgeServerHandle | null = null;
  let error: string | null = null;
  let active = false;
  /** 启停串行：连点开关、改端口时不会两个监听抢同一个端口 */
  let chain: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (err) {
        console.error("[Writing Toolkit:agent-bridge] 状态监听器失败", err);
      }
    }
  }

  function persist(): void {
    storage?.save({ ...stored });
  }

  function ensureToken(): void {
    if (stored.token) return;
    stored.token = newToken();
    persist();
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = chain.then(task);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function stop(): Promise<void> {
    const current = server;
    server = null;
    if (current) await current.close();
  }

  async function start(announce: boolean): Promise<void> {
    await stop();
    if (!active || !stored.enabled || !options.isDesktop()) return;
    ensureToken();
    const port = stored.port;
    try {
      server = await startServer({
        port,
        token: stored.token,
        handle: (body) =>
          handleMcpBody(body, options.tools(), {
            name: AGENT_TOOLS_SERVER_NAME,
            version: options.version,
          }),
      });
      error = null;
    } catch (err) {
      server = null;
      error =
        err instanceof BridgeStartError && err.code === "EADDRINUSE"
          ? `端口 ${port} 被别的程序占用了，换一个端口再试`
          : `没能启动：${err instanceof Error ? err.message : String(err)}`;
      console.error("[Writing Toolkit:agent-bridge] 本机批注工具启动失败", err);
      if (announce) new Notice(`写作工具箱：批注工具${error}`);
    }
    if (!active) await stop();
  }

  const operations: AgentBridgeOperations = {
    status() {
      return {
        available: options.isDesktop(),
        enabled: stored.enabled,
        running: server !== null,
        port: stored.port,
        error,
        client: stored.client,
      };
    },
    setEnabled(on) {
      stored.enabled = on;
      if (!on) error = null;
      persist();
      return enqueue(async () => {
        if (on) await start(true);
        else await stop();
      }).finally(notify);
    },
    setPort(port) {
      if (!isValidBridgePort(port)) {
        return Promise.reject(new Error("端口要是 1024–65535 之间的整数"));
      }
      if (port === stored.port) return Promise.resolve();
      stored.port = port;
      persist();
      return enqueue(() => start(true)).finally(notify);
    },
    regenerateToken() {
      stored.token = newToken();
      persist();
      return enqueue(() => (stored.enabled ? start(true) : Promise.resolve())).finally(
        notify
      );
    },
    setClient(client) {
      if (!isAgentClient(client) || client === stored.client) return;
      stored.client = client;
      persist();
      notify();
    },
    connectionConfig() {
      ensureToken();
      return buildConnectionConfig(
        stored.client,
        AGENT_TOOLS_SERVER_NAME,
        stored.port,
        stored.token
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    id: "agent-bridge",
    dependsOn: ["comments"],
    activate(context) {
      active = true;
      storage = (factories.createStorage ?? defaultStorage)(context.app);
      stored = readStored(storage.load());
      context.effects.add(() => {
        active = false;
        listeners.clear();
        void enqueue(stop);
      });
      if (stored.enabled && options.isDesktop()) {
        void enqueue(() => start(true)).finally(notify);
      }
    },
    deactivate() {
      active = false;
    },
    get operations() {
      return operations;
    },
  };
}
