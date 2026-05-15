import type { LocalDockerRuntimeProvider, DockerRunner } from "../containers";
import type { ControlConfigInput } from "../config";
import type { HalSimBridge, HalSimWebSocketFactory } from "../halsim";
import type { GamepadSessions } from "../gamepad";
import type { IdleManager } from "../idle";
import type { ImportManager } from "../imports";
import type { Nt4AutoChooserBridge, Nt4AutoWebSocketFactory } from "../nt4-auto";
import type { RunCommandFactory, RunConnection, RunManager } from "../runs";
import type { WorkspaceRuntimeProvider } from "../runtime";
import type { AppStorage, AuthContext } from "../storage";

export type HttpFetch = (
  input: string | URL | Request,
  init?: RequestInit & { decompress?: boolean },
) => Promise<Response>;

export type BunUpgradeServer = {
  upgrade(request: Request, options: { data: SocketData; headers?: HeadersInit }): boolean;
};

export type ControlApp = {
  fetch(request: Request, server?: BunUpgradeServer): Promise<Response>;
  websocket: {
    open(ws: AppSocket): void;
    message(ws: AppSocket, message: string | ArrayBuffer | Uint8Array): void;
    close(ws: AppSocket): void;
  };
  storage: AppStorage;
  runtime: WorkspaceRuntimeProvider;
  containers: LocalDockerRuntimeProvider;
  halsim: HalSimBridge;
  gamepad: GamepadSessions;
  nt4Auto: Nt4AutoChooserBridge;
  runs: RunManager;
  imports: ImportManager;
  idle: IdleManager;
  close(): void;
};

export type ControlAppOptions = ControlConfigInput & {
  runtimeProvider?: WorkspaceRuntimeProvider | undefined;
  dockerRunner?: DockerRunner | undefined;
  portAvailable?: ((port: number) => Promise<boolean>) | undefined;
  upstreamFetch?: HttpFetch | undefined;
  runCommandFactory?: RunCommandFactory | undefined;
  halsimWebSocketFactory?: HalSimWebSocketFactory | undefined;
  nt4AutoWebSocketFactory?: Nt4AutoWebSocketFactory | undefined;
};

export type RunSocketData = {
  kind: "run";
  workspace: AuthContext["workspace"];
  connection?: RunConnection | undefined;
};

// Defensive cap on per-socket message buffering while waiting for upstream
// to open. A misbehaving sim that accepts TCP but never finishes the WS
// handshake would otherwise let the browser flood control-plane memory.
export const PROXY_PENDING_LIMIT = 256;

export type Nt4SocketData = {
  kind: "nt4";
  upstreamUrl: string;
  protocols: string[];
  upstream?: WebSocket | undefined;
  upstreamOpen: boolean;
  pendingMessages: Array<string | ArrayBuffer | Uint8Array>;
};

export type VscodeSocketData = {
  kind: "vscode";
  upstreamUrl: string;
  protocols: string[];
  upstream?: WebSocket | undefined;
  upstreamOpen: boolean;
  pendingMessages: Array<string | ArrayBuffer | Uint8Array>;
};

export type HalSimSocketData = {
  kind: "halsim";
  upstreamUrl: string;
  protocols: string[];
  upstream?: WebSocket | undefined;
  upstreamOpen: boolean;
  pendingMessages: Array<string | ArrayBuffer | Uint8Array>;
};

export type ImportSocketData = {
  kind: "import";
  workspace: AuthContext["workspace"];
  userId: string;
};

export type GamepadSocketData = {
  kind: "gamepad";
  workspace: AuthContext["workspace"];
};

export type SocketData =
  | RunSocketData
  | Nt4SocketData
  | VscodeSocketData
  | HalSimSocketData
  | ImportSocketData
  | GamepadSocketData;

export type AppSocket = {
  data: SocketData;
  send(data: string): unknown;
  send(data: ArrayBuffer | Uint8Array): unknown;
  close(code?: number, reason?: string): unknown;
};
