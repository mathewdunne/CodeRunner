import { describe, expect, test } from "bun:test";
import {
	authProvidersResponseSchema,
	autoChooserPatchSchema,
	autoChoosersResponseSchema,
	deployFilePathSchema,
	deployFilesSnapshotResponseSchema,
	driverStationPatchSchema,
	gamepadClientMessageSchema,
	gamepadServerMessageSchema,
	gamepadStateSchema,
	importRequestSchema,
	importResponseSchema,
	isWorkspaceSlug,
	lessonCatalogResponseSchema,
	lessonCatalogSchema,
	lessonLoadRequestSchema,
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
		expect(authProvidersResponseSchema.parse({ providers: ["auth0"] })).toEqual(
			{
				providers: ["auth0"],
			},
		);
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

describe("lesson catalog schemas", () => {
	test("parses a well-formed manifest", () => {
		expect(
			lessonCatalogSchema.parse({
				schemaVersion: 1,
				modules: [
					{
						id: "hello-world",
						title: "Hello, World",
						description: "Variables and stdin.",
						subdir: "modules/hello-world",
						kind: "plain-java",
						order: 10,
					},
				],
			}),
		).toMatchObject({ modules: [{ id: "hello-world", kind: "plain-java" }] });
	});

	test("rejects an unknown module kind", () => {
		expect(
			lessonCatalogSchema.safeParse({
				schemaVersion: 1,
				modules: [
					{
						id: "x",
						title: "X",
						description: "",
						subdir: "modules/x",
						kind: "console",
						order: 10,
					},
				],
			}).success,
		).toBe(false);
	});

	test("rejects unsafe module subdir values", () => {
		for (const subdir of [
			"../escape",
			"/modules/hello-world",
			"modules/../escape",
			"modules/hello name",
			"modules/hello;rm",
			"modules/$HOME",
		]) {
			expect(
				lessonCatalogSchema.safeParse({
					schemaVersion: 1,
					modules: [
						{
							id: "x",
							title: "X",
							description: "",
							subdir,
							kind: "plain-java",
							order: 10,
						},
					],
				}).success,
			).toBe(false);
		}
	});

	test("lessonCatalogResponseSchema requires ok:true and modules", () => {
		expect(
			lessonCatalogResponseSchema.parse({
				ok: true,
				modules: [],
				error: null,
			}),
		).toMatchObject({ ok: true, modules: [] });
		expect(
			lessonCatalogResponseSchema.safeParse({ ok: false, modules: [] }).success,
		).toBe(false);
	});

	test("lessonLoadRequestSchema requires a non-empty moduleId", () => {
		expect(lessonLoadRequestSchema.parse({ moduleId: "hello-world" })).toEqual({
			moduleId: "hello-world",
		});
		expect(lessonLoadRequestSchema.safeParse({ moduleId: "" }).success).toBe(
			false,
		);
	});
});

describe("importRequestSchema", () => {
	test("accepts a bare url and ignores legacy branch/subdir fields", () => {
		expect(
			importRequestSchema.parse({ url: "https://github.com/owner/repo" }),
		).toEqual({ url: "https://github.com/owner/repo" });
	});

	test("rejects an empty url", () => {
		expect(importRequestSchema.safeParse({ url: "" }).success).toBe(false);
	});

	test("importResponseSchema matches the validation endpoint response", () => {
		expect(
			importResponseSchema.parse({
				ok: true,
				cloneUrl: "https://github.com/owner/repo.git",
			}),
		).toEqual({ ok: true, cloneUrl: "https://github.com/owner/repo.git" });
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

describe("deployFilePathSchema", () => {
	test("accepts realistic PathPlanner file paths", () => {
		for (const path of [
			"src/main/deploy/pathplanner/paths/Example Path.path",
			"src/main/deploy/pathplanner/autos/Two Piece (Left).auto",
			"src/main/deploy/pathplanner/settings.json",
			"src/main/deploy/choreo/Trajectory.traj",
		]) {
			expect(deployFilePathSchema.safeParse(path).success).toBe(true);
		}
	});

	test("accepts ordinary student-chosen filenames with punctuation and non-ASCII letters", () => {
		for (const path of [
			"src/main/deploy/pathplanner/autos/Two Piece (Left).path",
			"src/main/deploy/pathplanner/autos/Bob's Auto.auto",
			"src/main/deploy/pathplanner/autos/Score #1.path",
			"src/main/deploy/pathplanner/autos/A+B.path",
			"src/main/deploy/pathplanner/autos/Left, Right.path",
			"src/main/deploy/pathplanner/autos/Ünïcode.path",
		]) {
			expect(deployFilePathSchema.safeParse(path).success).toBe(true);
		}
	});

	test("rejects traversal, absolute, hidden, and malformed paths", () => {
		for (const path of [
			"",
			"/etc/passwd",
			"src/main/deploy/pathplanner/../secrets.json",
			"src/main/deploy/pathplanner/.hidden",
			"src\\main\\deploy\\pathplanner\\x.path",
			"src/main/deploy/pathplanner//double.path",
			`src/${"a".repeat(600)}.path`,
		]) {
			expect(deployFilePathSchema.safeParse(path).success).toBe(false);
		}
	});

	test("rejects segments with control characters or reserved filesystem characters", () => {
		for (const path of [
			`src/main/deploy/pathplanner/${String.fromCharCode(1)}bad.path`,
			"src/main/deploy/pathplanner/autos/star*.path",
		]) {
			expect(deployFilePathSchema.safeParse(path).success).toBe(false);
		}
	});
});

describe("deployFilesSnapshotResponseSchema", () => {
	test("accepts a snapshot payload", () => {
		const parsed = deployFilesSnapshotResponseSchema.safeParse({
			ok: true,
			files: [
				{
					path: "src/main/deploy/pathplanner/paths/A.path",
					content: "{}",
				},
			],
		});
		expect(parsed.success).toBe(true);
	});
});
