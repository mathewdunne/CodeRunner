/**
 * Helpers for seeding the MockWorkspaceRuntimeProvider exposed by the `app`
 * fixture. Centralizes the WorkspaceRuntime shape so specs don't repeat it.
 */
import type { WorkspaceId } from "@frc-sim/contracts";
import type { MockWorkspaceRuntimeProvider } from "../../apps/control/src/__tests__/helpers";
import type { FakeHalsimHandle, FakeVscodeHandle } from "./types";

export function seedRuntimeRunning(opts: {
  runtime: MockWorkspaceRuntimeProvider;
  workspaceId: WorkspaceId;
  fakeVscode: FakeVscodeHandle;
  fakeHalsim: FakeHalsimHandle;
}): void {
  const { runtime, workspaceId, fakeVscode, fakeHalsim } = opts;
  runtime.setRuntime({
    workspaceId,
    state: "running",
    image: "coderunner-workspace",
    runtimeName: `frc-${workspaceId.slice(0, 8)}`,
    ports: { nt4: 8080, vscode: 8081, halsim: 8082 },
    endpoints: {
      vscode: {
        httpBaseUrl: fakeVscode.httpBaseUrl,
        wsBaseUrl: fakeVscode.wsBaseUrl,
        basePath: "/",
      },
      nt4: {
        httpUrl: `${fakeVscode.httpBaseUrl}/nt4`,
        wsUrl: `${fakeVscode.wsBaseUrl.replace(/^http/, "ws")}/nt4`,
      },
      halsim: { wsUrl: fakeHalsim.wsUrl },
    },
    lastUsedAt: new Date().toISOString(),
    error: null,
  });
}

export function seedRuntimeMissing(
  runtime: MockWorkspaceRuntimeProvider,
  workspaceId: WorkspaceId,
): void {
  runtime.setRuntime({
    workspaceId,
    state: "missing",
    image: "coderunner-workspace",
    runtimeName: null,
    ports: { nt4: null, vscode: null, halsim: null },
    endpoints: { vscode: null, nt4: null, halsim: null },
    lastUsedAt: null,
    error: null,
  });
}
