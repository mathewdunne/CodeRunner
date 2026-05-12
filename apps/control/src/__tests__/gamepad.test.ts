import { describe, expect, test } from "bun:test";
import type { WorkspaceId } from "@frc-sim/contracts";
import { GamepadSessions, type GamepadLease } from "../gamepad";
import { HalSimBridge, HalSimBridgeUnavailableError } from "../halsim";

class FakeWebSocket {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", { reason: "closed" });
  }
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open", {});
  }
  private emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const WORKSPACE_ID = "ws_0123456789abcdef0123456789abcdef" as WorkspaceId;
const HALSIM_PORT = 34000;

function setupBridgeAndSocket(): { bridge: HalSimBridge; socket: FakeWebSocket } {
  const sockets: FakeWebSocket[] = [];
  const bridge = new HalSimBridge({
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  bridge.ensureConnected(WORKSPACE_ID, HALSIM_PORT);
  const socket = sockets[0]!;
  socket.open();
  socket.sent.length = 0;
  return { bridge, socket };
}

const resolveLease = (): GamepadLease | null => ({ halsimPort: HALSIM_PORT });

describe("GamepadSessions", () => {
  test("getStatus returns unknown before any session activity", () => {
    const { bridge } = setupBridgeAndSocket();
    const sessions = new GamepadSessions(bridge);
    expect(sessions.getStatus(WORKSPACE_ID)).toEqual({
      status: "unknown",
      port: null,
      label: null,
      lastInputAt: null,
    });
  });

  test("state messages forward joystick payload to HALSim and stamp lastInputAt", () => {
    const { bridge, socket } = setupBridgeAndSocket();
    const sessions = new GamepadSessions(bridge);

    sessions.handleMessage(
      WORKSPACE_ID,
      { type: "select", id: "pad-1", label: "Xbox" },
      resolveLease,
    );
    expect(sessions.getStatus(WORKSPACE_ID)).toMatchObject({ status: "connected", port: 0, label: "Xbox" });

    sessions.handleMessage(
      WORKSPACE_ID,
      {
        type: "state",
        seq: 0,
        state: {
          axes: [0.25, -0.5, 0, 0, 0, 0],
          buttons: [true, false, false, false, false, false, false, false, false, false],
          povs: [-1],
        },
      },
      resolveLease,
    );

    const joystick = JSON.parse(socket.sent[0]!) as { type: string; device: string };
    expect(joystick).toMatchObject({ type: "Joystick", device: "0" });
    expect(sessions.getStatus(WORKSPACE_ID).lastInputAt).not.toBeNull();
  });

  test("out-of-order state frames are dropped", () => {
    const { bridge, socket } = setupBridgeAndSocket();
    const sessions = new GamepadSessions(bridge);

    sessions.handleMessage(
      WORKSPACE_ID,
      { type: "select", id: "pad-1", label: "Xbox" },
      resolveLease,
    );

    const frame = (seq: number) =>
      ({
        type: "state" as const,
        seq,
        state: {
          axes: [0, 0, 0, 0, 0, 0],
          buttons: Array<boolean>(10).fill(false),
          povs: [-1],
        },
      }) ;

    sessions.handleMessage(WORKSPACE_ID, frame(5), resolveLease);
    const sentAfterFirst = socket.sent.length;
    sessions.handleMessage(WORKSPACE_ID, frame(3), resolveLease);
    expect(socket.sent.length).toBe(sentAfterFirst);
  });

  test("release safety-disables and clears the session", () => {
    const { bridge, socket } = setupBridgeAndSocket();
    const sessions = new GamepadSessions(bridge);

    sessions.handleMessage(WORKSPACE_ID, { type: "select", id: "pad-1", label: "Xbox" }, resolveLease);
    bridge.applyDriverStationPatch(WORKSPACE_ID, HALSIM_PORT, { enabled: true });
    socket.sent.length = 0;

    const outcome = sessions.handleMessage(WORKSPACE_ID, { type: "release" }, resolveLease);
    expect(outcome).toBe("ok");

    const messages = socket.sent.map((raw) => JSON.parse(raw) as { type: string; data: Record<string, unknown> });
    // releaseJoystick emits zeroed joystick + flush + DS disable.
    expect(messages[0]).toMatchObject({ type: "Joystick" });
    const disable = messages.find((m) => m.type === "DriverStation" && m.data[">enabled"] === false);
    expect(disable).toBeDefined();
    expect(bridge.getSnapshot(WORKSPACE_ID).driverStation.enabled).toBe(false);
    expect(sessions.getStatus(WORKSPACE_ID).status).toBe("disconnected");
  });

  test("returns no-lease when the simulator is not running", () => {
    const { bridge } = setupBridgeAndSocket();
    const sessions = new GamepadSessions(bridge);

    sessions.handleMessage(WORKSPACE_ID, { type: "select", id: "pad-1", label: "Xbox" }, resolveLease);
    const outcome = sessions.handleMessage(
      WORKSPACE_ID,
      {
        type: "state",
        seq: 0,
        state: {
          axes: [0, 0, 0, 0, 0, 0],
          buttons: Array<boolean>(10).fill(false),
          povs: [-1],
        },
      },
      () => null,
    );
    expect(outcome).toBe("no-lease");
  });

  test("returns halsim-unavailable when the bridge socket is not open", () => {
    const bridge = new HalSimBridge({
      webSocketFactory: () => new FakeWebSocket() as unknown as WebSocket,
    });
    // Do not open the socket — applyJoystickState will throw the unavailable
    // error.
    const sessions = new GamepadSessions(bridge);
    sessions.handleMessage(WORKSPACE_ID, { type: "select", id: "pad-1", label: "Xbox" }, resolveLease);
    const outcome = sessions.handleMessage(
      WORKSPACE_ID,
      {
        type: "state",
        seq: 0,
        state: {
          axes: [0, 0, 0, 0, 0, 0],
          buttons: Array<boolean>(10).fill(false),
          povs: [-1],
        },
      },
      resolveLease,
    );
    expect(outcome).toBe("halsim-unavailable");
    expect(HalSimBridgeUnavailableError).toBeDefined();
  });

  test("closeSession safety-releases when a selection exists", () => {
    const { bridge, socket } = setupBridgeAndSocket();
    const sessions = new GamepadSessions(bridge);

    sessions.handleMessage(WORKSPACE_ID, { type: "select", id: "pad-1", label: "Xbox" }, resolveLease);
    bridge.applyDriverStationPatch(WORKSPACE_ID, HALSIM_PORT, { enabled: true });
    socket.sent.length = 0;

    sessions.closeSession(WORKSPACE_ID, resolveLease);
    const messages = socket.sent.map((raw) => JSON.parse(raw) as { type: string; data: Record<string, unknown> });
    expect(messages.find((m) => m.type === "Joystick")).toBeDefined();
    expect(messages.find((m) => m.type === "DriverStation" && m.data[">enabled"] === false)).toBeDefined();
    expect(sessions.getStatus(WORKSPACE_ID).status).toBe("unknown");
  });
});
