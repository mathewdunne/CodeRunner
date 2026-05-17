import type { WorkspaceId, WorkspaceSlug } from "@frc-sim/contracts";
import type { ControlApp } from "../../apps/control/src/app";

export type SeededUser = {
	id: string;
	email: string;
	name: string;
	slug: WorkspaceSlug;
	role: "student" | "admin";
};

export type SeededWorkspace = {
	user: SeededUser;
	workspaceId: WorkspaceId;
	slug: WorkspaceSlug;
	cookie: string;
};

export type AppFixture = {
	app: ControlApp;
	baseURL: string;
	fakeVscode: FakeVscodeHandle;
	fakeHalsim: FakeHalsimHandle;
};

export type FakeVscodeHandle = {
	httpBaseUrl: string;
	wsBaseUrl: string;
	receivedHeaders(): Array<Record<string, string>>;
	receivedFrames(): Array<unknown>;
	wsConnections(): number;
	awaitWsConnection(target?: number, timeout?: number): Promise<void>;
	stop(): Promise<void>;
};

export type FakeHalsimHandle = {
	wsUrl: string;
	receivedFrames(): Array<unknown>;
	stop(): Promise<void>;
	restart(): Promise<void>;
};
