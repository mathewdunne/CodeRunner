import { spawn, type SpawnOptions } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";
import {
  InitializeRequest,
  Message,
  type InitializeParams,
  type RequestMessage,
  type ResponseMessage,
} from "vscode-languageserver-protocol";
import {
  type IWebSocket,
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from "vscode-ws-jsonrpc";
import {
  createConnection,
  createServerProcess,
  forward,
} from "vscode-ws-jsonrpc/server";
import { WebSocketServer, type RawData, type ServerOptions } from "ws";

const serverName = "Eclipse JDT LS";
const port = Number(process.env.PORT ?? 30003);
const host = process.env.HOST ?? "0.0.0.0";
const pathName = process.env.LSP_PATH ?? "/jdtls";
const jdtLsHome = process.env.JDTLS_HOME ?? "/opt/jdtls";
const jdtLsLauncher =
  process.env.JDTLS_LAUNCHER ??
  `${jdtLsHome}/plugins/org.eclipse.equinox.launcher_1.6.900.v20240613-2009.jar`;
const jdtLsConfig = process.env.JDTLS_CONFIG ?? `${jdtLsHome}/config_linux`;
const jdtLsData = process.env.JDTLS_DATA ?? "/workspace/jdtls-data";
const logMessages = process.env.LSP_LOG_MESSAGES === "1";

type LanguageServerRunConfig = {
  pathName: string;
  serverPort: number;
  runCommand: string;
  runCommandArgs: string[];
  wsServerOptions: ServerOptions;
  spawnOptions?: SpawnOptions;
};

const runConfig: LanguageServerRunConfig = {
  pathName,
  serverPort: port,
  runCommand: "java",
  runCommandArgs: [
    "-Declipse.application=org.eclipse.jdt.ls.core.id1",
    "-Dosgi.bundles.defaultStartLevel=4",
    "-Declipse.product=org.eclipse.jdt.ls.core.product",
    "-Dlog.level=ALL",
    "-Xmx1G",
    "--add-modules=ALL-SYSTEM",
    "--add-opens",
    "java.base/java.util=ALL-UNNAMED",
    "--add-opens",
    "java.base/java.lang=ALL-UNNAMED",
    "-jar",
    jdtLsLauncher,
    "-configuration",
    jdtLsConfig,
    "-data",
    jdtLsData,
  ],
  wsServerOptions: { noServer: true, perMessageDeflate: false },
};

function launchLanguageServer(config: LanguageServerRunConfig, socket: IWebSocket): void {
  const reader = new WebSocketMessageReader(socket);
  const writer = new WebSocketMessageWriter(socket);
  const socketConnection = createConnection(reader, writer, () => socket.dispose());
  const serverConnection = createServerProcess(
    serverName,
    config.runCommand,
    config.runCommandArgs,
    config.spawnOptions,
  );

  if (serverConnection === undefined) {
    socket.dispose();
    return;
  }

  forward(socketConnection, serverConnection, (message) => {
    if (Message.isRequest(message)) {
      if (message.method === InitializeRequest.type.method) {
        const initializeParams = message.params as InitializeParams;
        initializeParams.processId = process.pid;
      }
      if (logMessages) {
        console.log(`${serverName} received ${message.method}`);
      }
      return message as RequestMessage;
    }

    if (Message.isResponse(message)) {
      if (logMessages) {
        console.log(`${serverName} sent response ${message.id}`);
      }
      return message as ResponseMessage;
    }

    return message;
  });
}

function asWebSocket(webSocket: import("ws").WebSocket): IWebSocket {
  return {
    send: (content) => {
      webSocket.send(content, (error) => {
        if (error) {
          throw error;
        }
      });
    },
    onMessage: (callback) => {
      webSocket.on("message", (data: RawData) => callback(data));
    },
    onError: (callback) => {
      webSocket.on("error", callback);
    },
    onClose: (callback) => {
      webSocket.on("close", callback);
    },
    dispose: () => {
      webSocket.close();
    },
  };
}

function handleUpgrade(
  config: LanguageServerRunConfig,
  httpServer: Server,
  wsServer: WebSocketServer,
): void {
  httpServer.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const baseUrl = `http://${request.headers.host ?? "localhost"}/`;
    const requestPath = request.url ? new URL(request.url, baseUrl).pathname : undefined;

    if (requestPath !== config.pathName) {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (webSocket) => {
      const lspSocket = asWebSocket(webSocket);
      if (webSocket.readyState === webSocket.OPEN) {
        launchLanguageServer(config, lspSocket);
      } else {
        webSocket.on("open", () => launchLanguageServer(config, lspSocket));
      }
    });
  });
}

process.on("uncaughtException", (err: Error) => {
  console.error(`Uncaught exception: ${err.message}`);
  if (err.stack) {
    console.error(err.stack);
  }
});

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(`${serverName} WebSocket bridge. Connect to ${pathName}.\n`);
});
const wsServer = new WebSocketServer(runConfig.wsServerOptions);
handleUpgrade(runConfig, httpServer, wsServer);

httpServer.listen(runConfig.serverPort, host, () => {
  console.log(`${serverName} bridge listening on ws://${host}:${runConfig.serverPort}${pathName}`);
});

process.on("SIGTERM", () => {
  wsServer.close();
  httpServer.close();
});

