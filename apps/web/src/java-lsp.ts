import * as monaco from "monaco-editor";

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type LspPosition = { line: number; character: number };
type LspRange = { start: LspPosition; end: LspPosition };

type LspDiagnostic = {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
};

type LspHover = {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { language?: string; value: string }>;
  range?: LspRange;
};

type LspCompletionItem = {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { range?: LspRange; newText: string };
};

type LspCompletionList = { items: LspCompletionItem[] };

type LspSemanticTokensLegend = { tokenTypes: string[]; tokenModifiers: string[] };
type LspSemanticTokensProvider = {
  legend: LspSemanticTokensLegend;
  full?: boolean | { delta?: boolean };
  range?: boolean | object;
};
type LspInitializeResult = {
  capabilities?: { semanticTokensProvider?: LspSemanticTokensProvider | null };
};
type LspSemanticTokens = { resultId?: string; data: number[] };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type JavaLspStatus =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "unavailable";

export type JavaLspController = {
  onStatusChange(handler: (status: JavaLspStatus, detail: string | null) => void): void;
  attachModel(model: monaco.editor.ITextModel): void;
  detachModel(uri: string): void;
  notifyDidCreateFile(uri: string): void;
  notifyDidDeleteFile(uri: string): void;
  notifyDidRenameFile(oldUri: string, newUri: string): void;
  dispose(): void;
};

const projectRootUri = "file:///workspace/project";
// Reconnect schedule (ms). Caps at 10s; we never give up because the operator
// may restart the LSP container at any time and we want the browser to recover.
const reconnectBackoffMs = [1_000, 2_000, 5_000, 10_000];

const semanticTokenTypes = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "annotation",
  "annotationMember",
  "record",
  "recordComponent",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
] as const;

const semanticTokenModifiers = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
  "public",
  "private",
  "protected",
  "native",
  "generic",
  "typeArgument",
  "importDeclaration",
  "constructor",
] as const;

class BrowserLspClient {
  #socket: WebSocket | undefined;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #notificationHandlers: Array<(message: JsonRpcNotification) => void> = [];
  #closeHandlers: Array<() => void> = [];

  constructor(private readonly url: string) {}

  async open(): Promise<void> {
    if (this.#socket && this.#socket.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.#socket = socket;

      const onOpen = () => resolve();
      const onError = () => reject(new Error(`Failed to connect to ${this.url}`));
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          this.handleMessage(event.data);
        }
      });
      socket.addEventListener("close", () => {
        for (const pending of this.#pending.values()) {
          pending.reject(new Error("Java language server connection closed"));
        }
        this.#pending.clear();
        for (const handler of this.#closeHandlers) {
          handler();
        }
      });
    });
  }

  isOpen(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  onNotification(handler: (message: JsonRpcNotification) => void): void {
    this.#notificationHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.#closeHandlers.push(handler);
  }

  close(): void {
    this.#socket?.close();
  }

  private send(message: JsonRpcMessage): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Java language server socket is not open");
    }
    this.#socket.send(JSON.stringify(message));
  }

  private handleMessage(raw: string): void {
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    if ("id" in parsed && !("method" in parsed)) {
      const pending = this.#pending.get(parsed.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    if ("method" in parsed) {
      for (const handler of this.#notificationHandlers) {
        handler(parsed);
      }
    }
  }
}

type ManagedModel = {
  model: monaco.editor.ITextModel;
  contentDisposable: monaco.IDisposable;
};

export type StartJavaLspOptions = {
  url: string;
  onStatus?: (message: string) => void;
};

function modelUriString(model: monaco.editor.ITextModel): string {
  return model.uri.toString();
}

export function startJavaLsp(options: StartJavaLspOptions): JavaLspController {
  let client = new BrowserLspClient(options.url);
  const managed = new Map<string, ManagedModel>();
  let initialized = false;
  let initializeResult: LspInitializeResult | null = null;
  let semanticTokensDisposable: monaco.IDisposable | undefined;
  let completionDisposable: monaco.IDisposable | undefined;
  let hoverDisposable: monaco.IDisposable | undefined;
  let statusListener: ((status: JavaLspStatus, detail: string | null) => void) | null = null;
  let disposed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let bootstrapInFlight = false;

  function setStatus(status: JavaLspStatus, detail: string | null = null): void {
    options.onStatus?.(`java language server ${status}${detail ? `: ${detail}` : ""}`);
    statusListener?.(status, detail);
  }

  function disposeProviders(): void {
    semanticTokensDisposable?.dispose();
    semanticTokensDisposable = undefined;
    completionDisposable?.dispose();
    completionDisposable = undefined;
    hoverDisposable?.dispose();
    hoverDisposable = undefined;
  }

  function clearStaleMarkers(): void {
    for (const entry of managed.values()) {
      monaco.editor.setModelMarkers(entry.model, "jdtls", []);
    }
  }

  function registerProviders(): void {
    completionDisposable = monaco.languages.registerCompletionItemProvider("java", {
      triggerCharacters: ["."],
      provideCompletionItems: async (completionModel, position, _context, token) => {
        if (!initialized || !managed.has(modelUriString(completionModel))) {
          return { suggestions: [] };
        }
        try {
          const result = await client.request("textDocument/completion", {
            textDocument: { uri: modelUriString(completionModel) },
            position: toLspPosition(position),
          });
          if (token.isCancellationRequested) {
            return { suggestions: [] };
          }
          return { suggestions: completionItemsToSuggestions(completionModel, position, result) };
        } catch {
          return { suggestions: [] };
        }
      },
    });

    hoverDisposable = monaco.languages.registerHoverProvider("java", {
      provideHover: async (hoverModel, position, token) => {
        if (!initialized || !managed.has(modelUriString(hoverModel))) {
          return undefined;
        }
        try {
          const result = await client.request("textDocument/hover", {
            textDocument: { uri: modelUriString(hoverModel) },
            position: toLspPosition(position),
          });
          if (token.isCancellationRequested) {
            return undefined;
          }
          return hoverToMonaco(result);
        } catch {
          return undefined;
        }
      },
    });

    semanticTokensDisposable = registerSemanticTokens(client, managed, initializeResult);
  }

  function attachClientHandlers(): void {
    client.onNotification((message) => {
      if (message.method === "textDocument/publishDiagnostics") {
        handleDiagnostics(managed, message.params);
      }
    });
    client.onClose(() => {
      if (disposed) {
        return;
      }
      // Move from "ready"/"connecting" into reconnect loop. Provider disposal
      // prevents stale results, and clearing markers stops ghost diagnostics.
      const wasInitialized = initialized;
      initialized = false;
      disposeProviders();
      clearStaleMarkers();
      setStatus("reconnecting", wasInitialized ? "connection dropped" : "initial connect failed");
      scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== null) {
      return;
    }
    const delay = reconnectBackoffMs[Math.min(reconnectAttempt, reconnectBackoffMs.length - 1)] ?? 10_000;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectAttempt += 1;
      client = new BrowserLspClient(options.url);
      attachClientHandlers();
      void bootstrap(true);
    }, delay);
  }

  async function bootstrap(isReconnect = false): Promise<void> {
    if (bootstrapInFlight) {
      return;
    }
    bootstrapInFlight = true;
    if (!isReconnect) {
      setStatus("connecting");
    }
    try {
      await client.open();
      const result = (await client.request("initialize", initializeParams())) as LspInitializeResult;
      initializeResult = result;
      client.notify("initialized", {});
      initialized = true;
      reconnectAttempt = 0;
      registerProviders();
      // Re-open every managed model so JDT LS sees the current editor state.
      for (const entry of managed.values()) {
        sendDidOpen(entry.model);
      }
      setStatus("ready", isReconnect ? "reconnected" : null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      // Don't flip to a permanent "unavailable" — keep retrying. The user sees
      // "reconnecting" and operator-driven container restarts can recover.
      setStatus("reconnecting", message);
      scheduleReconnect();
    } finally {
      bootstrapInFlight = false;
    }
  }

  function sendDidOpen(model: monaco.editor.ITextModel): void {
    if (!initialized) {
      return;
    }
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: modelUriString(model),
        languageId: "java",
        version: model.getVersionId(),
        text: model.getValue(),
      },
    });
  }

  function sendDidClose(uri: string): void {
    if (!initialized) {
      return;
    }
    client.notify("textDocument/didClose", { textDocument: { uri } });
  }

  function attachModel(model: monaco.editor.ITextModel): void {
    if (disposed) {
      return;
    }
    if (model.getLanguageId() !== "java") {
      return;
    }
    const uri = modelUriString(model);
    if (managed.has(uri)) {
      return;
    }

    const contentDisposable = model.onDidChangeContent(() => {
      if (!initialized) {
        return;
      }
      try {
        client.notify("textDocument/didChange", {
          textDocument: { uri, version: model.getVersionId() },
          contentChanges: [{ text: model.getValue() }],
        });
      } catch {
        // Connection may have closed mid-edit; reconnect-on-demand handles recovery.
      }
    });

    managed.set(uri, { model, contentDisposable });
    sendDidOpen(model);
  }

  function detachModel(uri: string): void {
    const entry = managed.get(uri);
    if (!entry) {
      return;
    }
    entry.contentDisposable.dispose();
    managed.delete(uri);
    sendDidClose(uri);
    monaco.editor.setModelMarkers(entry.model, "jdtls", []);
  }

  function fileEvent(uri: string, type: 1 | 2 | 3): unknown {
    return { changes: [{ uri, type }] };
  }

  function notifyDidCreateFile(uri: string): void {
    if (!initialized) {
      return;
    }
    try {
      client.notify("workspace/didCreateFiles", { files: [{ uri }] });
      client.notify("workspace/didChangeWatchedFiles", fileEvent(uri, 1));
    } catch {
      // Ignored; recovery happens on the next user action.
    }
  }

  function notifyDidDeleteFile(uri: string): void {
    if (!initialized) {
      return;
    }
    try {
      client.notify("workspace/didDeleteFiles", { files: [{ uri }] });
      client.notify("workspace/didChangeWatchedFiles", fileEvent(uri, 3));
    } catch {
      // Ignored.
    }
  }

  function notifyDidRenameFile(oldUri: string, newUri: string): void {
    if (!initialized) {
      return;
    }
    try {
      client.notify("workspace/didRenameFiles", { files: [{ oldUri, newUri }] });
      client.notify("workspace/didChangeWatchedFiles", { changes: [
        { uri: oldUri, type: 3 },
        { uri: newUri, type: 1 },
      ] });
    } catch {
      // Ignored.
    }
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    for (const uri of [...managed.keys()]) {
      detachModel(uri);
    }
    disposeProviders();
    client.close();
  }

  attachClientHandlers();
  void bootstrap();

  return {
    onStatusChange(handler) {
      statusListener = handler;
    },
    attachModel,
    detachModel,
    notifyDidCreateFile,
    notifyDidDeleteFile,
    notifyDidRenameFile,
    dispose,
  };
}

function registerSemanticTokens(
  client: BrowserLspClient,
  managed: Map<string, ManagedModel>,
  result: LspInitializeResult | null,
): monaco.IDisposable | undefined {
  const provider = semanticTokensProvider(result);
  if (!provider?.legend || !provider.full) {
    return undefined;
  }

  return monaco.languages.registerDocumentSemanticTokensProvider("java", {
    getLegend() {
      return provider.legend;
    },
    provideDocumentSemanticTokens: async (semanticModel, _lastResultId, token) => {
      const uri = semanticModel.uri.toString();
      if (!managed.has(uri)) {
        return null;
      }
      const tokens = await client
        .request("textDocument/semanticTokens/full", { textDocument: { uri } })
        .catch(() => null);
      if (token.isCancellationRequested || !isSemanticTokens(tokens)) {
        return null;
      }
      if (tokens.resultId !== undefined) {
        return { resultId: tokens.resultId, data: Uint32Array.from(tokens.data) };
      }
      return { data: Uint32Array.from(tokens.data) };
    },
    releaseDocumentSemanticTokens(_resultId) {
      // JDT LS does not require an explicit release for full token requests.
    },
  });
}

function initializeParams(): unknown {
  return {
    processId: null,
    rootUri: projectRootUri,
    workspaceFolders: [{ uri: projectRootUri, name: "project" }],
    capabilities: {
      textDocument: {
        synchronization: { didSave: true, dynamicRegistration: false },
        hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
        completion: {
          dynamicRegistration: false,
          contextSupport: true,
          completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] },
        },
        publishDiagnostics: { relatedInformation: true },
        semanticTokens: {
          dynamicRegistration: false,
          tokenTypes: semanticTokenTypes,
          tokenModifiers: semanticTokenModifiers,
          formats: ["relative"],
          requests: { range: false, full: { delta: false } },
          overlappingTokenSupport: false,
          multilineTokenSupport: false,
          augmentsSyntaxTokens: true,
        },
      },
      workspace: {
        workspaceFolders: true,
        didChangeConfiguration: { dynamicRegistration: false },
        didChangeWatchedFiles: { dynamicRegistration: false },
        fileOperations: {
          didCreate: true,
          didDelete: true,
          didRename: true,
        },
      },
    },
    initializationOptions: {},
  };
}

function toLspPosition(position: monaco.Position): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function toMonacoRange(range: LspRange): monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

function handleDiagnostics(managed: Map<string, ManagedModel>, params: unknown): void {
  if (!isObject(params) || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) {
    return;
  }
  const entry = managed.get(params.uri);
  if (!entry) {
    return;
  }
  const markers: monaco.editor.IMarkerData[] = params.diagnostics
    .filter(isLspDiagnostic)
    .map((diagnostic) => {
      const marker: monaco.editor.IMarkerData = {
        severity: toMarkerSeverity(diagnostic.severity),
        message: diagnostic.message,
        source: diagnostic.source ?? "jdtls",
        startLineNumber: diagnostic.range.start.line + 1,
        startColumn: diagnostic.range.start.character + 1,
        endLineNumber: diagnostic.range.end.line + 1,
        endColumn: diagnostic.range.end.character + 1,
      };
      if (diagnostic.code !== undefined) {
        marker.code = String(diagnostic.code);
      }
      return marker;
    });
  monaco.editor.setModelMarkers(entry.model, "jdtls", markers);
}

function completionItemsToSuggestions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  result: unknown,
): monaco.languages.CompletionItem[] {
  const items = completionItems(result);
  const word = model.getWordUntilPosition(position);
  const fallbackRange = new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn,
  );
  return items.map((item) => {
    const suggestion: monaco.languages.CompletionItem = {
      label: item.label,
      kind: toCompletionItemKind(item.kind),
      insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
      range: item.textEdit?.range ? toMonacoRange(item.textEdit.range) : fallbackRange,
    };
    if (item.detail !== undefined) {
      suggestion.detail = item.detail;
    }
    const documentation = documentationToMarkdown(item.documentation);
    if (documentation !== undefined) {
      suggestion.documentation = documentation;
    }
    if (item.sortText !== undefined) {
      suggestion.sortText = item.sortText;
    }
    if (item.filterText !== undefined) {
      suggestion.filterText = item.filterText;
    }
    if (item.insertTextFormat === 2) {
      suggestion.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    }
    return suggestion;
  });
}

function completionItems(result: unknown): LspCompletionItem[] {
  if (Array.isArray(result)) {
    return result.filter(isCompletionItem);
  }
  if (isObject(result) && Array.isArray((result as LspCompletionList).items)) {
    return (result as LspCompletionList).items.filter(isCompletionItem);
  }
  return [];
}

function semanticTokensProvider(result: LspInitializeResult | null): LspSemanticTokensProvider | undefined {
  const provider = result?.capabilities?.semanticTokensProvider;
  if (!isSemanticTokensProvider(provider)) {
    return undefined;
  }
  return provider;
}

function hoverToMonaco(result: unknown): monaco.languages.Hover | undefined {
  if (!isObject(result) || !("contents" in result)) {
    return undefined;
  }
  const hover = result as LspHover;
  const contents = hoverContentsToMarkdown(hover.contents);
  if (contents.length === 0) {
    return undefined;
  }
  const monacoHover: monaco.languages.Hover = { contents };
  if (hover.range) {
    monacoHover.range = toMonacoRange(hover.range);
  }
  return monacoHover;
}

function hoverContentsToMarkdown(contents: LspHover["contents"]): monaco.IMarkdownString[] {
  if (typeof contents === "string") {
    return contents.length > 0 ? [{ value: contents }] : [];
  }
  if (Array.isArray(contents)) {
    return contents.flatMap((item) => {
      if (typeof item === "string") {
        return item.length > 0 ? [{ value: item }] : [];
      }
      return item.value.length > 0 ? [{ value: item.value }] : [];
    });
  }
  return contents.value.length > 0 ? [{ value: contents.value }] : [];
}

function documentationToMarkdown(
  documentation: LspCompletionItem["documentation"],
): monaco.IMarkdownString | string | undefined {
  if (!documentation) {
    return undefined;
  }
  if (typeof documentation === "string") {
    return documentation;
  }
  return { value: documentation.value };
}

function toMarkerSeverity(severity: number | undefined): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    case 4:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Warning;
  }
}

function toCompletionItemKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  switch (kind) {
    case 2:
      return monaco.languages.CompletionItemKind.Method;
    case 3:
      return monaco.languages.CompletionItemKind.Function;
    case 4:
      return monaco.languages.CompletionItemKind.Constructor;
    case 5:
      return monaco.languages.CompletionItemKind.Field;
    case 6:
      return monaco.languages.CompletionItemKind.Variable;
    case 7:
      return monaco.languages.CompletionItemKind.Class;
    case 8:
      return monaco.languages.CompletionItemKind.Interface;
    case 9:
      return monaco.languages.CompletionItemKind.Module;
    case 10:
      return monaco.languages.CompletionItemKind.Property;
    case 12:
      return monaco.languages.CompletionItemKind.Value;
    case 13:
      return monaco.languages.CompletionItemKind.Enum;
    case 14:
      return monaco.languages.CompletionItemKind.Keyword;
    case 15:
      return monaco.languages.CompletionItemKind.Snippet;
    case 17:
      return monaco.languages.CompletionItemKind.File;
    case 18:
      return monaco.languages.CompletionItemKind.Reference;
    case 20:
      return monaco.languages.CompletionItemKind.EnumMember;
    case 21:
      return monaco.languages.CompletionItemKind.Constant;
    case 22:
      return monaco.languages.CompletionItemKind.Struct;
    case 23:
      return monaco.languages.CompletionItemKind.Event;
    case 24:
      return monaco.languages.CompletionItemKind.Operator;
    case 25:
      return monaco.languages.CompletionItemKind.TypeParameter;
    default:
      return monaco.languages.CompletionItemKind.Text;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLspDiagnostic(value: unknown): value is LspDiagnostic {
  return isObject(value) && isRange(value.range) && typeof value.message === "string";
}

function isRange(value: unknown): value is LspRange {
  return isObject(value) && isPosition(value.start) && isPosition(value.end);
}

function isPosition(value: unknown): value is LspPosition {
  return isObject(value) && typeof value.line === "number" && typeof value.character === "number";
}

function isCompletionItem(value: unknown): value is LspCompletionItem {
  return isObject(value) && typeof value.label === "string";
}

function isSemanticTokensProvider(value: unknown): value is LspSemanticTokensProvider {
  return (
    isObject(value) &&
    isSemanticTokensLegend(value.legend) &&
    (value.full === true || isObject(value.full))
  );
}

function isSemanticTokensLegend(value: unknown): value is LspSemanticTokensLegend {
  return (
    isObject(value) &&
    Array.isArray(value.tokenTypes) &&
    value.tokenTypes.every((tokenType) => typeof tokenType === "string") &&
    Array.isArray(value.tokenModifiers) &&
    value.tokenModifiers.every((tokenModifier) => typeof tokenModifier === "string")
  );
}

function isSemanticTokens(value: unknown): value is LspSemanticTokens {
  return (
    isObject(value) &&
    Array.isArray(value.data) &&
    value.data.every((tokenPart) => typeof tokenPart === "number") &&
    (value.resultId === undefined || typeof value.resultId === "string")
  );
}
