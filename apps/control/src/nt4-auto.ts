import type { AutoChooser, AutoChooserPatch, AutoChoosersResponse, BridgeConnection, WorkspaceId } from "@frc-sim/contracts";

type Nt4Topic = {
  id: number;
  name: string;
  type: string;
};

type Nt4AutoEntry = {
  workspaceId: WorkspaceId;
  upstreamUrl: string;
  socket: WebSocket | null;
  connection: BridgeConnection;
  connected: boolean;
  stale: boolean;
  lastMessageAt: string | null;
  error: string | null;
  topicsById: Map<number, Nt4Topic>;
  topicsByName: Map<string, Nt4Topic>;
  valuesByName: Map<string, unknown>;
  publishedTopics: Map<string, Nt4Topic>;
};

export type Nt4AutoWebSocketFactory = (url: string, protocols: string[]) => WebSocket;

type Nt4AutoChooserBridgeOptions = {
  webSocketFactory?: Nt4AutoWebSocketFactory;
};

export class Nt4AutoChooserUnavailableError extends Error {
  readonly status = 503;

  constructor(message = "NT4 auto chooser bridge is not connected.") {
    super(message);
    this.name = "Nt4AutoChooserUnavailableError";
  }
}

const APP_NAME = "FrcSimAutoChooser";
const SUBSCRIPTION_ID = 1;
const STRING_TYPE_INDEX = 4;
const DEFAULT_CHOOSER_KEY = "SmartDashboard/Auto Choices";

function upstreamUrlFor(nt4Port: number): string {
  return `ws://127.0.0.1:${nt4Port}/nt/${APP_NAME}`;
}

function normalizeTopicName(name: string): string {
  return name.replace(/^NT:?\/?/, "").replace(/^\/+/, "");
}

function publishTopicName(key: string): string {
  return `/${normalizeTopicName(key)}`;
}

function displayKey(root: string): string {
  return normalizeTopicName(root);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function chooserSortKey(chooser: AutoChooser): string {
  return chooser.displayKey === DEFAULT_CHOOSER_KEY ? "" : chooser.displayKey;
}

function readString(entry: Nt4AutoEntry, root: string, field: string): string | null {
  return stringValue(entry.valuesByName.get(`${root}/${field}`)) ?? stringValue(entry.valuesByName.get(`${root}/.${field}`));
}

function readOptions(entry: Nt4AutoEntry, root: string): string[] {
  const direct = stringArrayValue(entry.valuesByName.get(`${root}/options`));
  const dotted = stringArrayValue(entry.valuesByName.get(`${root}/.options`));
  const options = direct.length > 0 ? direct : dotted;
  if (options.length > 0) return options;

  const length = entry.valuesByName.get(`${root}/options/length`);
  const count = typeof length === "number" ? Math.max(0, Math.floor(length)) : 0;
  const expanded: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const value = stringValue(entry.valuesByName.get(`${root}/options/${i}`));
    if (value !== null) expanded.push(value);
  }
  return expanded;
}

function chooserRoots(entry: Nt4AutoEntry): Set<string> {
  const roots = new Set<string>();
  for (const name of entry.topicsByName.keys()) {
    const normalized = normalizeTopicName(name);
    for (const suffix of ["/.type", "/type", "/.options", "/options", "/options/length", "/.default", "/default", "/.active", "/active"]) {
      if (normalized.endsWith(suffix)) {
        roots.add(normalized.slice(0, -suffix.length));
      }
    }
  }
  return roots;
}

function isChooser(entry: Nt4AutoEntry, root: string): boolean {
  const type = readString(entry, root, "type");
  if (type === "String Chooser" || type === "SendableChooser") return true;
  return readOptions(entry, root).length > 0 && (readString(entry, root, "default") !== null || readString(entry, root, "active") !== null);
}

function snapshotChoosers(entry: Nt4AutoEntry): AutoChooser[] {
  return [...chooserRoots(entry)]
    .filter((root) => isChooser(entry, root))
    .map((root) => ({
      key: displayKey(root),
      displayKey: displayKey(root),
      options: readOptions(entry, root),
      default: readString(entry, root, "default"),
      active: readString(entry, root, "active"),
      selected: readString(entry, root, "selected"),
    }))
    .sort((a, b) => chooserSortKey(a).localeCompare(chooserSortKey(b)));
}

function encodeMsgPack(value: unknown): Uint8Array {
  const chunks: number[] = [];
  const push = (...bytes: number[]) => chunks.push(...bytes.map((byte) => byte & 0xff));
  const pushString = (value: string) => {
    const encoded = new TextEncoder().encode(value);
    if (encoded.length < 32) {
      push(0xa0 | encoded.length);
    } else if (encoded.length <= 0xff) {
      push(0xd9, encoded.length);
    } else {
      push(0xda, encoded.length >> 8, encoded.length);
    }
    chunks.push(...encoded);
  };
  const pushUint64 = (value: number) => {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setBigUint64(0, BigInt(Math.max(0, Math.floor(value))));
    push(0xcf, ...new Uint8Array(buffer));
  };
  const write = (item: unknown) => {
    if (Array.isArray(item)) {
      if (item.length < 16) {
        push(0x90 | item.length);
      } else {
        push(0xdc, item.length >> 8, item.length);
      }
      for (const child of item) write(child);
    } else if (typeof item === "string") {
      pushString(item);
    } else if (typeof item === "number") {
      if (Number.isInteger(item) && item >= 0 && item <= 0x7f) push(item);
      else if (Number.isInteger(item) && item >= 0 && item <= 0xffffffff) push(0xce, item >>> 24, item >>> 16, item >>> 8, item);
      else if (Number.isInteger(item) && item >= 0) pushUint64(item);
      else {
        const buffer = new ArrayBuffer(8);
        new DataView(buffer).setFloat64(0, item);
        push(0xcb, ...new Uint8Array(buffer));
      }
    } else if (typeof item === "boolean") {
      push(item ? 0xc3 : 0xc2);
    } else {
      push(0xc0);
    }
  };
  write(value);
  return new Uint8Array(chunks);
}

function decodeMsgPack(buffer: ArrayBuffer | Uint8Array): unknown[] {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const decoder = new TextDecoder();
  let offset = 0;
  const MAX_COLLECTION_LENGTH = 100_000;
  const read = (length: number) => {
    if (length < 0 || offset + length > bytes.length) {
      throw new RangeError("Malformed MsgPack frame.");
    }
    const start = offset;
    offset += length;
    return bytes.slice(start, offset);
  };
  const view = (length: number) => {
    if (length < 0 || offset + length > bytes.length) {
      throw new RangeError("Malformed MsgPack frame.");
    }
    const dataView = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
    offset += length;
    return dataView;
  };
  const readUint = (length: number) => {
    let value = 0;
    for (const byte of read(length)) value = value * 256 + byte;
    return value;
  };
  const readArray = (length: number): unknown[] => {
    if (length > MAX_COLLECTION_LENGTH) {
      throw new RangeError("MsgPack array is too large.");
    }
    const value: unknown[] = [];
    for (let i = 0; i < length; i += 1) {
      value.push(parse());
    }
    return value;
  };
  const readMap = (length: number): Record<string, unknown> => {
    if (length > MAX_COLLECTION_LENGTH) {
      throw new RangeError("MsgPack map is too large.");
    }
    const value: Record<string, unknown> = {};
    for (let i = 0; i < length; i += 1) {
      const key = parse();
      value[String(key)] = parse();
    }
    return value;
  };
  const parse = (): unknown => {
    if (offset >= bytes.length) {
      throw new RangeError("Malformed MsgPack frame.");
    }
    const marker = bytes[offset++] ?? 0xc0;
    if (marker <= 0x7f) return marker;
    if (marker >= 0x80 && marker <= 0x8f) return readMap(marker & 0x0f);
    if (marker >= 0x90 && marker <= 0x9f) return readArray(marker & 0x0f);
    if (marker >= 0xa0 && marker <= 0xbf) return decoder.decode(read(marker & 0x1f));
    if (marker === 0xc0) return null;
    if (marker === 0xc2) return false;
    if (marker === 0xc3) return true;
    if (marker === 0xc4) return read(readUint(1));
    if (marker === 0xc5) return read(readUint(2));
    if (marker === 0xc6) return read(readUint(4));
    if (marker === 0xc7) {
      const length = readUint(1);
      read(1);
      return read(length);
    }
    if (marker === 0xc8) {
      const length = readUint(2);
      read(1);
      return read(length);
    }
    if (marker === 0xc9) {
      const length = readUint(4);
      read(1);
      return read(length);
    }
    if (marker === 0xca) return view(4).getFloat32(0);
    if (marker === 0xcb) return view(8).getFloat64(0);
    if (marker === 0xcc) return readUint(1);
    if (marker === 0xcd) return readUint(2);
    if (marker === 0xce) return readUint(4);
    if (marker === 0xcf) return Number(view(8).getBigUint64(0));
    if (marker === 0xd0) return view(1).getInt8(0);
    if (marker === 0xd1) return view(2).getInt16(0);
    if (marker === 0xd2) return view(4).getInt32(0);
    if (marker === 0xd3) return Number(view(8).getBigInt64(0));
    if (marker === 0xd4) {
      read(1);
      return read(1);
    }
    if (marker === 0xd5) {
      read(1);
      return read(2);
    }
    if (marker === 0xd6) {
      read(1);
      return read(4);
    }
    if (marker === 0xd7) {
      read(1);
      return read(8);
    }
    if (marker === 0xd8) {
      read(1);
      return read(16);
    }
    if (marker === 0xd9) return decoder.decode(read(readUint(1)));
    if (marker === 0xda) return decoder.decode(read(readUint(2)));
    if (marker === 0xdb) return decoder.decode(read(readUint(4)));
    if (marker === 0xdc) return readArray(readUint(2));
    if (marker === 0xdd) return readArray(readUint(4));
    if (marker === 0xde) return readMap(readUint(2));
    if (marker === 0xdf) return readMap(readUint(4));
    if (marker >= 0xe0) return marker - 0x100;
    throw new RangeError(`Unsupported MsgPack marker 0x${marker.toString(16)}.`);
  };

  const values: unknown[] = [];
  while (offset < bytes.length) {
    values.push(parse());
  }
  return values;
}

export class Nt4AutoChooserBridge {
  private readonly webSocketFactory: Nt4AutoWebSocketFactory;
  private readonly entries = new Map<WorkspaceId, Nt4AutoEntry>();

  constructor(options: Nt4AutoChooserBridgeOptions = {}) {
    this.webSocketFactory = options.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols));
  }

  ensureConnected(workspaceId: WorkspaceId, nt4Port: number): AutoChoosersResponse {
    const upstreamUrl = upstreamUrlFor(nt4Port);
    let entry = this.entries.get(workspaceId);
    if (entry && entry.upstreamUrl !== upstreamUrl) {
      this.disconnect(workspaceId);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        workspaceId,
        upstreamUrl,
        socket: null,
        connection: "disconnected",
        connected: false,
        stale: true,
        lastMessageAt: null,
        error: null,
        topicsById: new Map(),
        topicsByName: new Map(),
        valuesByName: new Map(),
        publishedTopics: new Map(),
      };
      this.entries.set(workspaceId, entry);
    }
    if (!entry.socket) {
      this.open(entry);
    }
    return this.snapshotFromEntry(entry);
  }

  getSnapshot(workspaceId: WorkspaceId): AutoChoosersResponse {
    const entry = this.entries.get(workspaceId);
    return entry ? this.snapshotFromEntry(entry) : {
      ok: true,
      nt4: { connection: "disconnected", connected: false, stale: true, lastMessageAt: null, error: null },
      choosers: [],
    };
  }

  select(workspaceId: WorkspaceId, nt4Port: number, patch: AutoChooserPatch): AutoChoosersResponse {
    const snapshot = this.ensureConnected(workspaceId, nt4Port);
    const entry = this.entries.get(workspaceId);
    if (!entry || !entry.socket || entry.socket.readyState !== WebSocket.OPEN) {
      throw new Nt4AutoChooserUnavailableError(snapshot.nt4.error ?? "NT4 auto chooser bridge is not connected.");
    }
    const chooser = snapshot.choosers.find((candidate) => candidate.key === patch.key);
    if (!chooser) {
      const error = new Error(`Unknown auto chooser: ${patch.key}`);
      (error as Error & { status: number }).status = 404;
      throw error;
    }
    if (!chooser.options.includes(patch.selected)) {
      const error = new Error(`Unknown autonomous routine: ${patch.selected}`);
      (error as Error & { status: number }).status = 400;
      throw error;
    }

    const topicName = `${publishTopicName(patch.key)}/selected`;
    this.publishStringTopic(entry, topicName);
    entry.socket.send(encodeMsgPack([entry.publishedTopics.get(topicName)!.id, Date.now() * 1000, STRING_TYPE_INDEX, patch.selected]));
    entry.valuesByName.set(normalizeTopicName(topicName), patch.selected);
    entry.lastMessageAt = new Date().toISOString();
    entry.stale = false;
    return this.snapshotFromEntry(entry);
  }

  disconnect(workspaceId: WorkspaceId): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    const socket = entry.socket;
    entry.socket = null;
    entry.connection = "disconnected";
    entry.connected = false;
    entry.stale = true;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }
  }

  close(): void {
    for (const workspaceId of this.entries.keys()) {
      this.disconnect(workspaceId);
    }
    this.entries.clear();
  }

  private open(entry: Nt4AutoEntry): void {
    entry.connection = "reconnecting";
    entry.connected = false;
    entry.stale = entry.lastMessageAt !== null;
    entry.error = null;
    const socket = this.webSocketFactory(entry.upstreamUrl, ["v4.1.networktables.first.wpi.edu", "networktables.first.wpi.edu"]);
    socket.binaryType = "arraybuffer";
    entry.socket = socket;
    socket.addEventListener("open", () => {
      if (entry.socket !== socket) return;
      entry.connection = "connected";
      entry.connected = true;
      entry.stale = false;
      entry.error = null;
      for (const topic of entry.publishedTopics.values()) {
        this.sendJson(entry, "publish", {
          name: topic.name,
          type: topic.type,
          pubuid: topic.id,
          properties: {},
        });
      }
      this.sendJson(entry, "subscribe", {
        topics: ["/"],
        subuid: SUBSCRIPTION_ID,
        options: { prefix: true, all: false, periodic: 0.1 },
      });
    });
    socket.addEventListener("message", (event) => {
      if (entry.socket !== socket) return;
      this.handleMessage(entry, event.data);
    });
    socket.addEventListener("close", (event) => {
      if (entry.socket !== socket) return;
      entry.socket = null;
      entry.connection = "disconnected";
      entry.connected = false;
      entry.stale = true;
      entry.error = event.reason || null;
    });
    socket.addEventListener("error", () => {
      if (entry.socket !== socket) return;
      entry.error = "NT4 upstream error.";
    });
  }

  private handleMessage(entry: Nt4AutoEntry, raw: unknown): void {
    entry.lastMessageAt = new Date().toISOString();
    entry.stale = false;
    entry.error = null;
    if (typeof raw === "string") {
      const messages = JSON.parse(raw) as Array<{ method: string; params: Record<string, unknown> }>;
      for (const message of messages) {
        if (message.method === "announce") {
          const id = message.params.id;
          const name = message.params.name;
          const type = message.params.type;
          if (typeof id === "number" && typeof name === "string" && typeof type === "string") {
            const topic = { id, name: normalizeTopicName(name), type };
            entry.topicsById.set(id, topic);
            entry.topicsByName.set(topic.name, topic);
          }
        } else if (message.method === "unannounce") {
          const name = message.params.name;
          if (typeof name === "string") {
            const topic = entry.topicsByName.get(normalizeTopicName(name));
            if (topic) entry.topicsById.delete(topic.id);
            entry.topicsByName.delete(normalizeTopicName(name));
            entry.valuesByName.delete(normalizeTopicName(name));
          }
        }
      }
      return;
    }

    let decoded: unknown[];
    try {
      decoded = decodeMsgPack(raw as ArrayBuffer | Uint8Array);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : "Unable to decode NT4 binary frame.";
      return;
    }

    for (const item of decoded) {
      if (!Array.isArray(item) || item.length < 4) continue;
      const topicId = item[0];
      const value = item[3];
      if (typeof topicId !== "number" || topicId < 0) continue;
      const topic = entry.topicsById.get(topicId);
      if (topic) entry.valuesByName.set(topic.name, value);
    }
  }

  private publishStringTopic(entry: Nt4AutoEntry, name: string): void {
    if (entry.publishedTopics.has(name)) return;
    const topic = { id: Math.floor(Math.random() * 99_999_999), name, type: "string" };
    entry.publishedTopics.set(name, topic);
    this.sendJson(entry, "publish", { name, type: "string", pubuid: topic.id, properties: {} });
  }

  private sendJson(entry: Nt4AutoEntry, method: string, params: Record<string, unknown>): void {
    if (!entry.socket || entry.socket.readyState !== WebSocket.OPEN) {
      throw new Nt4AutoChooserUnavailableError();
    }
    entry.socket.send(JSON.stringify([{ method, params }]));
  }

  private snapshotFromEntry(entry: Nt4AutoEntry): AutoChoosersResponse {
    return {
      ok: true,
      nt4: {
        connection: entry.connection,
        connected: entry.connected,
        stale: entry.stale,
        lastMessageAt: entry.lastMessageAt,
        error: entry.error,
      },
      choosers: snapshotChoosers(entry),
    };
  }
}
