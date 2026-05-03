import * as monaco from "monaco-editor";

type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification;

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

type LspPosition = {
  line: number;
  character: number;
};

type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

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
  textEdit?: {
    range?: LspRange;
    newText: string;
  };
};

type LspCompletionList = {
  items: LspCompletionItem[];
};

type JavaLspConfig = {
  model: monaco.editor.ITextModel;
  url: string;
  onStatus: (message: string) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

const projectRootUri = "file:///workspace/project";

export async function startJavaLsp(config: JavaLspConfig): Promise<void> {
  const client = new BrowserLspClient(config.url);
  const model = config.model;

  try {
    await client.open();
    await client.request("initialize", initializeParams());
    client.notify("initialized", {});
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: model.uri.toString(),
        languageId: "java",
        version: model.getVersionId(),
        text: model.getValue(),
      },
    });
    config.onStatus("java language server connected");
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    config.onStatus(`java language server unavailable: ${message}`);
    return;
  }

  client.onNotification((message) => {
    if (message.method === "textDocument/publishDiagnostics") {
      handleDiagnostics(model, message.params);
    }
  });

  const contentDisposable = model.onDidChangeContent(() => {
    client.notify("textDocument/didChange", {
      textDocument: {
        uri: model.uri.toString(),
        version: model.getVersionId(),
      },
      contentChanges: [{ text: model.getValue() }],
    });
  });

  const completionDisposable = monaco.languages.registerCompletionItemProvider("java", {
    triggerCharacters: ["."],
    provideCompletionItems: async (completionModel, position, _context, token) => {
      if (completionModel.uri.toString() !== model.uri.toString()) {
        return { suggestions: [] };
      }

      const result = await client.request("textDocument/completion", {
        textDocument: { uri: model.uri.toString() },
        position: toLspPosition(position),
      });

      if (token.isCancellationRequested) {
        return { suggestions: [] };
      }

      return {
        suggestions: completionItemsToSuggestions(model, position, result),
      };
    },
  });

  const hoverDisposable = monaco.languages.registerHoverProvider("java", {
    provideHover: async (hoverModel, position, token) => {
      if (hoverModel.uri.toString() !== model.uri.toString()) {
        return undefined;
      }

      const result = await client.request("textDocument/hover", {
        textDocument: { uri: model.uri.toString() },
        position: toLspPosition(position),
      });

      if (token.isCancellationRequested) {
        return undefined;
      }

      return hoverToMonaco(result);
    },
  });

  window.addEventListener("beforeunload", () => {
    contentDisposable.dispose();
    completionDisposable.dispose();
    hoverDisposable.dispose();
    client.notify("textDocument/didClose", {
      textDocument: { uri: model.uri.toString() },
    });
    client.close();
  });
}

class BrowserLspClient {
  #socket: WebSocket | undefined;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #notificationHandlers: Array<(message: JsonRpcNotification) => void> = [];

  constructor(private readonly url: string) {}

  async open(): Promise<void> {
    if (this.#socket && this.#socket.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.#socket = socket;

      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Failed to connect to ${this.url}`)), {
        once: true,
      });
      socket.addEventListener("message", (event: MessageEvent<string>) => {
        this.handleMessage(event.data);
      });
      socket.addEventListener("close", () => {
        for (const pending of this.#pending.values()) {
          pending.reject(new Error("Java language server connection closed"));
        }
        this.#pending.clear();
      });
    });
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
    const parsed = JSON.parse(raw) as JsonRpcMessage;

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

function initializeParams(): unknown {
  return {
    processId: null,
    rootUri: projectRootUri,
    workspaceFolders: [{ uri: projectRootUri, name: "project" }],
    capabilities: {
      textDocument: {
        synchronization: {
          didSave: true,
          dynamicRegistration: false,
        },
        hover: {
          dynamicRegistration: false,
          contentFormat: ["markdown", "plaintext"],
        },
        completion: {
          dynamicRegistration: false,
          contextSupport: true,
          completionItem: {
            snippetSupport: true,
            documentationFormat: ["markdown", "plaintext"],
          },
        },
        publishDiagnostics: {
          relatedInformation: true,
        },
      },
      workspace: {
        workspaceFolders: true,
        didChangeConfiguration: { dynamicRegistration: false },
      },
    },
    initializationOptions: {},
  };
}

function toLspPosition(position: monaco.Position): LspPosition {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1,
  };
}

function toMonacoRange(range: LspRange): monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

function handleDiagnostics(model: monaco.editor.ITextModel, params: unknown): void {
  if (!isObject(params) || params.uri !== model.uri.toString() || !Array.isArray(params.diagnostics)) {
    return;
  }

  const markers: monaco.editor.IMarkerData[] = params.diagnostics
    .filter(isLspDiagnostic)
    .map((diagnostic) => ({
      severity: toMarkerSeverity(diagnostic.severity),
      message: diagnostic.message,
      source: diagnostic.source ?? "jdtls",
      code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
      startLineNumber: diagnostic.range.start.line + 1,
      startColumn: diagnostic.range.start.character + 1,
      endLineNumber: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1,
    }));

  monaco.editor.setModelMarkers(model, "jdtls", markers);
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

  return items.map((item) => ({
    label: item.label,
    kind: toCompletionItemKind(item.kind),
    detail: item.detail,
    documentation: documentationToMarkdown(item.documentation),
    sortText: item.sortText,
    filterText: item.filterText,
    insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
    insertTextRules:
      item.insertTextFormat === 2
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    range: item.textEdit?.range ? toMonacoRange(item.textEdit.range) : fallbackRange,
  }));
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

function hoverToMonaco(result: unknown): monaco.languages.Hover | undefined {
  if (!isObject(result) || !("contents" in result)) {
    return undefined;
  }

  const hover = result as LspHover;
  const contents = hoverContentsToMarkdown(hover.contents);
  if (contents.length === 0) {
    return undefined;
  }

  return {
    contents,
    range: hover.range ? toMonacoRange(hover.range) : undefined,
  };
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
  return (
    isObject(value) &&
    isRange(value.range) &&
    typeof value.message === "string"
  );
}

function isRange(value: unknown): value is LspRange {
  return (
    isObject(value) &&
    isPosition(value.start) &&
    isPosition(value.end)
  );
}

function isPosition(value: unknown): value is LspPosition {
  return (
    isObject(value) &&
    typeof value.line === "number" &&
    typeof value.character === "number"
  );
}

function isCompletionItem(value: unknown): value is LspCompletionItem {
  return isObject(value) && typeof value.label === "string";
}
