import { describe, expect, test } from "bun:test";
import { HalSimBridge } from "../halsim";

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

  message(data: unknown): void {
    this.emit("message", { data: JSON.stringify(data) });
  }

  private emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("HalSimBridge", () => {
  test("shares one upstream socket for repeated ensures", () => {
    const sockets: FakeWebSocket[] = [];
    const bridge = new HalSimBridge({
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    bridge.ensureConnected("ws_0123456789abcdef0123456789abcdef", 34000);
    bridge.ensureConnected("ws_0123456789abcdef0123456789abcdef", 34000);

    expect(sockets).toHaveLength(1);
  });

  test("updates DS state from readback and disables before mode changes", () => {
    const sockets: FakeWebSocket[] = [];
    const workspaceId = "ws_0123456789abcdef0123456789abcdef";
    const bridge = new HalSimBridge({
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    bridge.ensureConnected(workspaceId, 34000);
    const socket = sockets[0]!;
    socket.open();
    socket.message({
      type: "DriverStation",
      device: "",
      data: {
        ">enabled": true,
        ">autonomous": false,
        ">test": false,
        ">estop": false,
        ">station": "blue2",
      },
    });

    expect(bridge.getSnapshot(workspaceId).driverStation).toMatchObject({
      enabled: true,
      mode: "teleop",
      alliance: "blue2",
    });

    bridge.applyDriverStationPatch(workspaceId, 34000, { mode: "auto" });
    const messages = socket.sent.map((raw) => JSON.parse(raw) as { data: Record<string, unknown> });

    expect(messages.at(-2)?.data).toMatchObject({ ">enabled": false, ">new_data": true });
    expect(messages.at(-1)?.data).toMatchObject({
      ">autonomous": true,
      ">test": false,
      ">new_data": true,
    });
    expect(bridge.getSnapshot(workspaceId).driverStation).toMatchObject({
      enabled: false,
      mode: "auto",
    });
  });

  test("enable sends current mode flags so HALSim respects mode after restart", () => {
    const sockets: FakeWebSocket[] = [];
    const workspaceId = "ws_0123456789abcdef0123456789abcdef";
    const bridge = new HalSimBridge({
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    bridge.ensureConnected(workspaceId, 34000);
    const socket = sockets[0]!;
    socket.open();

    // Switch to test mode (this disables + sets mode)
    bridge.applyDriverStationPatch(workspaceId, 34000, { mode: "test" });
    socket.sent.length = 0;

    // Now enable — message must include mode flags
    bridge.applyDriverStationPatch(workspaceId, 34000, { enabled: true });
    const msg = JSON.parse(socket.sent.at(-1)!) as { data: Record<string, unknown> };
    expect(msg.data).toMatchObject({
      ">enabled": true,
      ">autonomous": false,
      ">test": true,
      ">new_data": true,
    });
  });

  test("does not collapse TEST to TELEOP on partial mode readback while switching to AUTO", () => {
    const sockets: FakeWebSocket[] = [];
    const workspaceId = "ws_0123456789abcdef0123456789abcdef";
    const bridge = new HalSimBridge({
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    bridge.ensureConnected(workspaceId, 34000);
    const socket = sockets[0]!;
    socket.open();
    socket.message({
      type: "DriverStation",
      device: "",
      data: {
        ">enabled": false,
        ">autonomous": false,
        ">test": true,
      },
    });

    expect(bridge.getSnapshot(workspaceId).driverStation.mode).toBe("test");

    bridge.applyDriverStationPatch(workspaceId, 34000, { mode: "auto" });
    expect(bridge.getSnapshot(workspaceId).driverStation.mode).toBe("auto");

    socket.message({
      type: "DriverStation",
      device: "",
      data: {
        ">test": false,
      },
    });

    expect(bridge.getSnapshot(workspaceId).driverStation.mode).toBe("auto");
  });
});
