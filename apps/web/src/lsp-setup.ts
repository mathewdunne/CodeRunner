// Thin wrapper around monaco-languageclient. The library handles the
// initialize handshake, document sync, completion/hover/diagnostics, and the
// lifecycle state machine. The backend serves /lsp as a plain JSON-RPC
// WebSocket (one message per text frame, no Content-Length headers), which is
// exactly what `vscode-ws-jsonrpc`'s `toSocket()` produces. See decision 009.

import { MonacoLanguageClient } from "monaco-languageclient";
import {
  toSocket,
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from "vscode-ws-jsonrpc";
import { CloseAction, ErrorAction } from "vscode-languageclient";
import * as vscode from "vscode";

export type LanguageClientHandle = {
  ready: Promise<void>;
  dispose(): Promise<void>;
};

function lspWebSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/lsp`;
}

// jdtls 1.58 needs explicit initializationOptions to drive Buildship's
// Gradle import. Without these, jdtls processes initialize but never moves
// off "Starting" and completions stay empty. Mirrors what vscode-java sends.
const JDTLS_INIT_OPTIONS = {
  bundles: [],
  workspaceFolders: ["file:///workspace/project"],
  settings: {
    java: {
      home: null,
      configuration: {
        updateBuildConfiguration: "automatic",
        runtimes: [],
      },
      autobuild: { enabled: true },
      maxConcurrentBuilds: 1,
      import: {
        gradle: { enabled: true, wrapper: { enabled: true } },
        maven: { enabled: false },
      },
      signatureHelp: { enabled: true },
      contentProvider: { preferred: "fernflower" },
      errors: { incompleteClasspath: { severity: "warning" } },
      completion: {
        enabled: true,
        overwrite: true,
        guessMethodArguments: true,
      },
      format: { enabled: true },
      saveActions: { organizeImports: false },
      references: { includeAccessors: true, includeDecompiledSources: true },
      selectionRange: { enabled: true },
      showBuildStatusOnStart: { enabled: "notification" },
    },
  },
  extendedClientCapabilities: {
    progressReportProvider: false,
    classFileContentsSupport: false,
    overrideMethodsPromptSupport: false,
    hashCodeEqualsPromptSupport: false,
    advancedOrganizeImportsSupport: false,
    generateToStringPromptSupport: false,
    advancedGenerateAccessorsSupport: false,
    generateConstructorsPromptSupport: false,
    generateDelegateMethodsPromptSupport: false,
    advancedExtractRefactoringSupport: false,
    inferSelectionSupport: ["extractMethod"],
    moveRefactoringSupport: false,
    clientHoverProvider: true,
    clientDocumentSymbolProvider: true,
    gradleChecksumWrapperPromptSupport: false,
    advancedIntroduceParameterRefactoringSupport: false,
    actionableRuntimeNotificationSupport: false,
    onCompletionItemSelectedCommand: "editor.action.triggerSuggest",
    extractInterfaceSupport: false,
    advancedUpgradeGradleSupport: false,
  },
  triggerFiles: [
    "file:///workspace/project/src/main/java/frc/robot/Robot.java",
  ],
};

export function startLanguageClient(): LanguageClientHandle {
  const ws = new WebSocket(lspWebSocketUrl());
  let client: MonacoLanguageClient | undefined;

  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener(
      "open",
      () => {
        const socket = toSocket(ws);
        const reader = new WebSocketMessageReader(socket);
        const writer = new WebSocketMessageWriter(socket);
        client = new MonacoLanguageClient({
          name: "FRC Java",
          clientOptions: {
            documentSelector: [{ language: "java" }],
            workspaceFolder: {
              index: 0,
              name: "project",
              uri: vscode.Uri.parse("file:///workspace/project"),
            },
            errorHandler: {
              error: () => ({ action: ErrorAction.Continue }),
              closed: () => ({ action: CloseAction.DoNotRestart }),
            },
            initializationOptions: JDTLS_INIT_OPTIONS,
          },
          messageTransports: { reader, writer },
        });
        client.start().then(resolve, reject);
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => reject(new Error("lsp websocket error")),
      { once: true },
    );
  });

  const dispose = async (): Promise<void> => {
    try {
      await client?.stop();
    } catch {
      // socket may already be torn down
    }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };

  return { ready, dispose };
}
