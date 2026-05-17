import { describe, expect, test } from "bun:test";
import {
	authProvidersResponseSchema,
	autoChooserPatchSchema,
	autoChoosersResponseSchema,
	driverStationPatchSchema,
	gamepadClientMessageSchema,
	gamepadServerMessageSchema,
	gamepadStateSchema,
	isWorkspaceSlug,
	runClientMessageSchema,
	runServerMessageSchema,
	simRunCommandRequestSchema,
	simStatusResponseSchema,
} from "./index";

describe("isWorkspaceSlug", () => {
	test("accepts route-safe workspace slugs", () => {
		expect(isWorkspaceSlug("alice")).toBe(true);
		expect(isWorkspaceSlug("team_6328-2026")).toBe(true);
	});

	test("rejects path-like or empty slugs", () => {
		expect(isWorkspaceSlug("")).toBe(false);
		expect(isWorkspaceSlug("../alice")).toBe(false);
		expect(isWorkspaceSlug("alice/bob")).toBe(false);
		expect(isWorkspaceSlug("alice.bob")).toBe(false);
		expect(isWorkspaceSlug("a".repeat(41))).toBe(false);
	});
});

describe("run message schemas", () => {
	test("parses the run WebSocket contract", () => {
		expect(runClientMessageSchema.parse({ type: "start" })).toEqual({
			type: "start",
		});
		expect(
			runServerMessageSchema.parse({
				type: "status",
				status: "building",
			}),
		).toEqual({
			type: "status",
			status: "building",
		});
	});
});

describe("simulation API schemas", () => {
	test("parses auth provider discovery payloads", () => {
		expect(
			authProvidersResponseSchema.parse({ providers: ["github"] }),
		).toEqual({
			providers: ["github"],
		});
		expect(
			authProvidersResponseSchema.safeParse({ providers: ["discord"] }).success,
		).toBe(false);
	});

	test("parses sim command and Driver Station patch payloads", () => {
		expect(simRunCommandRequestSchema.parse({ action: "restart" })).toEqual({
			action: "restart",
		});
		expect(
			driverStationPatchSchema.parse({ enabled: false, mode: "teleop" }),
		).toEqual({
			enabled: false,
			mode: "teleop",
		});
		expect(driverStationPatchSchema.safeParse({}).success).toBe(false);
		expect(
			simRunCommandRequestSchema.safeParse({ action: "toggle" }).success,
		).toBe(false);
	});

	test("parses auto chooser payloads", () => {
		expect(
			autoChooserPatchSchema.parse({
				key: "SmartDashboard/Auto Choices",
				selected: "Taxi",
			}),
		).toEqual({
			key: "SmartDashboard/Auto Choices",
			selected: "Taxi",
		});
		expect(
			autoChoosersResponseSchema.parse({
				ok: true,
				nt4: {
					connection: "connected",
					connected: true,
					stale: false,
					lastMessageAt: new Date(0).toISOString(),
					error: null,
				},
				choosers: [
					{
						key: "SmartDashboard/Auto Choices",
						displayKey: "SmartDashboard/Auto Choices",
						options: ["Taxi", "Score"],
						default: "Taxi",
						active: "Score",
						selected: "Score",
					},
				],
			}),
		).toMatchObject({ choosers: [{ active: "Score" }] });
	});

	test("parses a full sim status snapshot", () => {
		expect(
			simStatusResponseSchema.parse({
				ok: true,
				workspace: { id: "ws_0123456789abcdef0123456789abcdef", slug: "alice" },
				container: { state: "running" },
				run: { status: "running", runId: "run_abc" },
				halsim: {
					connection: "connected",
					connected: true,
					stale: false,
					lastMessageAt: new Date(0).toISOString(),
					error: null,
				},
				driverStation: {
					enabled: false,
					mode: "teleop",
					eStopped: false,
					alliance: "red1",
				},
				comms: { canEnable: true },
				joysticks: {
					status: "unknown",
					port: null,
					label: null,
					lastInputAt: null,
				},
			}),
		).toMatchObject({
			run: { status: "running" },
			driverStation: { mode: "teleop" },
		});
	});
});

describe("gamepad message schemas", () => {
	test("accepts select / state / release frames", () => {
		expect(
			gamepadClientMessageSchema.parse({
				type: "select",
				id: "045e-0b13",
				label: "Xbox Wireless Controller",
			}),
		).toMatchObject({ type: "select" });

		expect(
			gamepadClientMessageSchema.parse({
				type: "state",
				seq: 42,
				state: {
					axes: [0.5, -0.25, 0, 0, 0, 0],
					buttons: [
						true,
						false,
						false,
						false,
						false,
						false,
						false,
						false,
						false,
						false,
					],
					povs: [90],
				},
			}),
		).toMatchObject({ type: "state", seq: 42 });

		expect(gamepadClientMessageSchema.parse({ type: "release" })).toEqual({
			type: "release",
		});
	});

	test("rejects out-of-range axis values", () => {
		expect(() =>
			gamepadStateSchema.parse({
				axes: [2.5, 0, 0, 0, 0, 0],
				buttons: [false],
				povs: [-1],
			}),
		).toThrow();
	});

	test("rejects too many axes", () => {
		expect(() =>
			gamepadStateSchema.parse({
				axes: new Array(20).fill(0),
				buttons: [false],
				povs: [-1],
			}),
		).toThrow();
	});

	test("server messages include hello / halsim-disconnected / error", () => {
		expect(gamepadServerMessageSchema.parse({ type: "hello" })).toEqual({
			type: "hello",
		});
		expect(
			gamepadServerMessageSchema.parse({ type: "halsim-disconnected" }),
		).toEqual({ type: "halsim-disconnected" });
		expect(
			gamepadServerMessageSchema.parse({
				type: "error",
				message: "Simulator is not running.",
			}),
		).toMatchObject({ type: "error" });
	});
});
