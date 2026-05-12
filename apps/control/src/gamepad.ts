import type { GamepadClientMessage, WorkspaceId } from "@frc-sim/contracts";
import { HalSimBridge, HalSimBridgeUnavailableError } from "./halsim";

export type GamepadStatus = {
  status: "unknown" | "connected" | "disconnected";
  port: 0 | null;
  label: string | null;
  lastInputAt: string | null;
};

// v1 always binds to WPILib joystick port 0.
const DEFAULT_PORT = 0 as const;

export type GamepadLease = { halsimPort: number };

export type GamepadLeaseResolver = (
  workspaceId: WorkspaceId,
) => GamepadLease | null;

export type GamepadMessageOutcome = "ok" | "no-lease" | "halsim-unavailable";

type SessionState = {
  workspaceId: WorkspaceId;
  selected: { id: string; label: string } | null;
  lastSeq: number;
  lastInputAt: string | null;
};

export class GamepadSessions {
  private readonly sessions = new Map<WorkspaceId, SessionState>();

  constructor(private readonly halsim: HalSimBridge) {}

  getStatus(workspaceId: WorkspaceId): GamepadStatus {
    const session = this.sessions.get(workspaceId);
    if (!session || !session.selected) {
      return {
        status: session ? "disconnected" : "unknown",
        port: null,
        label: null,
        lastInputAt: session?.lastInputAt ?? null,
      };
    }
    return {
      status: "connected",
      port: DEFAULT_PORT,
      label: session.selected.label,
      lastInputAt: session.lastInputAt,
    };
  }

  handleMessage(
    workspaceId: WorkspaceId,
    message: GamepadClientMessage,
    resolveLease: GamepadLeaseResolver,
  ): GamepadMessageOutcome {
    const session = this.ensureSession(workspaceId);

    if (message.type === "select") {
      session.selected = { id: message.id, label: message.label };
      session.lastSeq = -1;
      return "ok";
    }

    if (message.type === "release") {
      const hadSelection = session.selected !== null;
      session.selected = null;
      session.lastSeq = -1;
      session.lastInputAt = null;
      if (!hadSelection) return "ok";
      return this.safetyRelease(workspaceId, resolveLease);
    }

    if (!session.selected) {
      // State frame without a prior select; drop.
      return "ok";
    }
    if (message.seq <= session.lastSeq) {
      // Out of order or duplicate. Browsers can re-fire on reconnect.
      return "ok";
    }
    session.lastSeq = message.seq;

    const lease = resolveLease(workspaceId);
    if (!lease) {
      return "no-lease";
    }
    try {
      this.halsim.applyJoystickState(workspaceId, lease.halsimPort, DEFAULT_PORT, message.state);
      session.lastInputAt = new Date().toISOString();
      return "ok";
    } catch (error) {
      if (error instanceof HalSimBridgeUnavailableError) {
        return "halsim-unavailable";
      }
      throw error;
    }
  }

  // Called when the WS closes or the user explicitly releases. Performs the
  // safety disable and drops the session.
  closeSession(
    workspaceId: WorkspaceId,
    resolveLease: GamepadLeaseResolver,
  ): GamepadMessageOutcome {
    const session = this.sessions.get(workspaceId);
    if (!session) return "ok";
    const hadSelection = session.selected !== null;
    this.sessions.delete(workspaceId);
    if (!hadSelection) return "ok";
    return this.safetyRelease(workspaceId, resolveLease);
  }

  reset(workspaceId: WorkspaceId): void {
    this.sessions.delete(workspaceId);
  }

  private ensureSession(workspaceId: WorkspaceId): SessionState {
    let session = this.sessions.get(workspaceId);
    if (!session) {
      session = {
        workspaceId,
        selected: null,
        lastSeq: -1,
        lastInputAt: null,
      };
      this.sessions.set(workspaceId, session);
    }
    return session;
  }

  private safetyRelease(
    workspaceId: WorkspaceId,
    resolveLease: GamepadLeaseResolver,
  ): GamepadMessageOutcome {
    const lease = resolveLease(workspaceId);
    if (!lease) return "no-lease";
    try {
      this.halsim.releaseJoystick(workspaceId, lease.halsimPort, DEFAULT_PORT);
      return "ok";
    } catch (error) {
      if (error instanceof HalSimBridgeUnavailableError) {
        return "halsim-unavailable";
      }
      throw error;
    }
  }
}
