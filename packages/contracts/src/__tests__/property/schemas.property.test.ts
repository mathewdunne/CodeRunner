/**
 * Property tests for shared contract schemas.
 *
 * P9 — JSON round-trip: any object that passes schema.parse() re-passes after
 *      JSON.parse(JSON.stringify(...)). Catches schemas that allow non-JSON
 *      values (Date, undefined, functions).
 * P10 — reject malformed inputs at every schema (slug regex, axis bounds, etc).
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
	allianceStationSchema,
	bridgeConnectionSchema,
	containerStateSchema,
	driverStationPatchSchema,
	dsModeSchema,
	gamepadStateSchema,
	importRequestSchema,
	lessonCatalogSchema,
	lessonModuleSchema,
	runClientMessageSchema,
	runServerMessageSchema,
	workspaceSlugSchema,
} from "../../index";

const NUM_RUNS = Number(process.env.FAST_CHECK_NUM_RUNS ?? 200);

const slugArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,40}$/);

describe("workspaceSlugSchema", () => {
	test("accepts any string matching the regex", () => {
		fc.assert(
			fc.property(slugArb, (s) => {
				expect(workspaceSlugSchema.safeParse(s).success).toBe(true);
			}),
			{ numRuns: NUM_RUNS },
		);
	});

	test("rejects any string with disallowed characters", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("/", "\\", " ", ".", "@", "..", "a/b", "../escape", ""),
				(s) => {
					expect(workspaceSlugSchema.safeParse(s).success).toBe(false);
				},
			),
			{ numRuns: 50 },
		);
	});

	test("rejects > 40 chars", () => {
		expect(workspaceSlugSchema.safeParse("a".repeat(41)).success).toBe(false);
	});
});

describe("gamepadStateSchema", () => {
	test("P10 rejects axes outside [-1.1, 1.1]", () => {
		expect(
			gamepadStateSchema.safeParse({ axes: [2], buttons: [], povs: [] })
				.success,
		).toBe(false);
		expect(
			gamepadStateSchema.safeParse({ axes: [-Infinity], buttons: [], povs: [] })
				.success,
		).toBe(false);
		expect(
			gamepadStateSchema.safeParse({
				axes: [Number.NaN],
				buttons: [],
				povs: [],
			}).success,
		).toBe(false);
	});

	test("P10 rejects POV outside {-1..360}", () => {
		expect(
			gamepadStateSchema.safeParse({ axes: [], buttons: [], povs: [-2] })
				.success,
		).toBe(false);
		expect(
			gamepadStateSchema.safeParse({ axes: [], buttons: [], povs: [400] })
				.success,
		).toBe(false);
	});

	test("P9 JSON round-trip preserves validity", () => {
		fc.assert(
			fc.property(
				fc.record({
					axes: fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
						maxLength: 8,
					}),
					buttons: fc.array(fc.boolean(), { maxLength: 32 }),
					povs: fc.array(fc.integer({ min: -1, max: 360 }), { maxLength: 2 }),
				}),
				(state) => {
					const first = gamepadStateSchema.parse(state);
					const round = JSON.parse(JSON.stringify(first));
					expect(gamepadStateSchema.safeParse(round).success).toBe(true);
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});
});

describe("driverStationPatchSchema", () => {
	test("requires at least one field", () => {
		expect(driverStationPatchSchema.safeParse({}).success).toBe(false);
	});

	test("rejects unknown modes/alliances", () => {
		expect(
			driverStationPatchSchema.safeParse({ mode: "kitchen-sink" }).success,
		).toBe(false);
		expect(
			driverStationPatchSchema.safeParse({ alliance: "green1" }).success,
		).toBe(false);
	});
});

describe("runClientMessageSchema / runServerMessageSchema", () => {
	test("client accepts only start/stop", () => {
		expect(runClientMessageSchema.safeParse({ type: "start" }).success).toBe(
			true,
		);
		expect(runClientMessageSchema.safeParse({ type: "stop" }).success).toBe(
			true,
		);
		expect(runClientMessageSchema.safeParse({ type: "kill" }).success).toBe(
			false,
		);
	});

	test("server status frames require legal status values", () => {
		for (const s of ["building", "running", "stopping", "failed", "stopped"]) {
			expect(
				runServerMessageSchema.safeParse({ type: "status", status: s }).success,
			).toBe(true);
		}
		expect(
			runServerMessageSchema.safeParse({ type: "status", status: "exploded" })
				.success,
		).toBe(false);
	});

	test("server log frame requires a known stream", () => {
		expect(
			runServerMessageSchema.safeParse({
				type: "log",
				stream: "stdout",
				line: "ok",
			}).success,
		).toBe(true);
		expect(
			runServerMessageSchema.safeParse({
				type: "log",
				stream: "secret",
				line: "ok",
			}).success,
		).toBe(false);
	});
});

describe("importRequestSchema", () => {
	test("rejects empty url", () => {
		expect(importRequestSchema.safeParse({ url: "" }).success).toBe(false);
	});

	test("accepts well-formed import requests", () => {
		fc.assert(
			fc.property(
				fc.stringMatching(
					/^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,20}\/[A-Za-z0-9_.-]{1,20}$/,
				),
				(url) => {
					expect(importRequestSchema.safeParse({ url }).success).toBe(true);
				},
			),
			{ numRuns: 50 },
		);
	});
});

describe("enum schemas", () => {
	test("dsModeSchema accepts auto/teleop/test only", () => {
		expect(dsModeSchema.options).toEqual(["auto", "teleop", "test"]);
	});
	test("allianceStationSchema covers six stations", () => {
		expect(allianceStationSchema.options.length).toBe(6);
	});
	test("bridgeConnectionSchema covers three states", () => {
		expect(bridgeConnectionSchema.options.length).toBe(3);
	});
	test("containerStateSchema covers expected states", () => {
		expect(new Set(containerStateSchema.options)).toEqual(
			new Set(["missing", "starting", "running", "stopped", "error"]),
		);
	});
});

describe("lessonModuleSchema / lessonCatalogSchema", () => {
	test("P9 JSON round-trip of a well-formed catalog", () => {
		fc.assert(
			fc.property(
				fc.record({
					schemaVersion: fc.integer({ min: 1, max: 10 }),
					modules: fc
						.array(
							fc.record({
								title: fc.stringMatching(/^.{1,40}$/),
								description: fc.string(),
								subdir: fc.stringMatching(/^modules\/[a-z][a-z0-9-]{0,30}$/),
								kind: fc.constantFrom("plain-java", "robot"),
								order: fc.integer({ min: 0, max: 1000 }),
							}),
							{ maxLength: 6 },
						)
						.map((modules) =>
							modules.map((module, index) => ({
								...module,
								id: `module-${index}`,
							})),
						),
				}),
				(rec) => {
					const parsed = lessonCatalogSchema.parse(rec);
					const round = JSON.parse(JSON.stringify(parsed));
					expect(lessonCatalogSchema.safeParse(round).success).toBe(true);
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	test("P11 JSON round-trip of repo modules", () => {
		fc.assert(
			fc.property(
				fc.record({
					id: fc.stringMatching(/^[a-z][a-z0-9-]{0,30}$/),
					title: fc.stringMatching(/^.{1,40}$/),
					description: fc.string(),
					repo: fc.stringMatching(
						/^[a-z][a-z0-9-]{0,20}\/[a-z][a-z0-9-]{0,20}$/,
					),
					preserveGit: fc.boolean(),
					kind: fc.constantFrom("plain-java", "robot"),
					order: fc.integer({ min: 0, max: 1000 }),
				}),
				(module) => {
					const parsed = lessonModuleSchema.parse(module);
					expect(parsed.subdir).toBeUndefined();
					expect(parsed.preserveGit).toBe(module.preserveGit);
					const round = JSON.parse(JSON.stringify(parsed));
					expect(lessonModuleSchema.safeParse(round).success).toBe(true);
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	test("P10 rejects an unknown module kind and empty id/subdir", () => {
		expect(
			lessonModuleSchema.safeParse({
				id: "x",
				title: "X",
				description: "",
				subdir: "modules/x",
				kind: "console",
				order: 10,
			}).success,
		).toBe(false);
		expect(
			lessonModuleSchema.safeParse({
				id: "",
				title: "X",
				description: "",
				subdir: "modules/x",
				kind: "robot",
				order: 10,
			}).success,
		).toBe(false);
		for (const subdir of [
			"",
			"../escape",
			"/absolute",
			"modules/../escape",
			"modules/hello name",
			"modules/hello;rm",
			"modules/$HOME",
		]) {
			expect(
				lessonModuleSchema.safeParse({
					id: "x",
					title: "X",
					description: "",
					subdir,
					kind: "robot",
					order: 10,
				}).success,
			).toBe(false);
		}
	});
});
