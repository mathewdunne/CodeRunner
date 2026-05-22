import { describe, expect, test } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import {
	defaultLogFormat,
	formatRecordJson,
	parseLogFormatEnv,
} from "../logging";

function makeRecord(overrides: Partial<LogRecord>): LogRecord {
	return {
		timestamp: Date.UTC(2026, 4, 20, 14, 23, 1, 482),
		level: "info",
		category: ["control", "runs"],
		message: ["hello"],
		properties: {},
		rawMessage: "hello",
		...overrides,
	} as LogRecord;
}

describe("formatRecordJson", () => {
	test("emits a single-line JSON object with reserved fields", () => {
		const line = formatRecordJson(
			makeRecord({
				message: ["run started"],
				properties: { workspaceId: "alice-1", runId: "run_abc" },
			}),
		);
		expect(line).not.toContain("\n");
		const parsed = JSON.parse(line);
		expect(parsed).toEqual({
			timestamp: "2026-05-20T14:23:01.482Z",
			level: "info",
			category: "control.runs",
			message: "run started",
			workspaceId: "alice-1",
			runId: "run_abc",
		});
	});

	test("renders Error properties as {message, stack}", () => {
		const err = new Error("boom");
		err.stack = "Error: boom\n    at <anonymous>";
		const line = formatRecordJson(
			makeRecord({ level: "error", properties: { cause: err } }),
		);
		const parsed = JSON.parse(line);
		expect(parsed.level).toBe("error");
		expect(parsed.cause).toEqual({
			message: "boom",
			stack: "Error: boom\n    at <anonymous>",
		});
	});

	test("reserved fields win over colliding property keys", () => {
		const line = formatRecordJson(
			makeRecord({
				properties: {
					timestamp: "spoofed",
					level: "spoofed",
					category: "spoofed",
					message: "spoofed",
					workspaceId: "real",
				},
			}),
		);
		const parsed = JSON.parse(line);
		expect(parsed.timestamp).toBe("2026-05-20T14:23:01.482Z");
		expect(parsed.level).toBe("info");
		expect(parsed.category).toBe("control.runs");
		expect(parsed.message).toBe("hello");
		expect(parsed.workspaceId).toBe("real");
	});

	test("nested category arrays join with dots", () => {
		const line = formatRecordJson(
			makeRecord({ category: ["control", "containers", "docker"] }),
		);
		expect(JSON.parse(line).category).toBe("control.containers.docker");
	});

	test("falls back to string coercion when properties have circular refs", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		const line = formatRecordJson(
			makeRecord({ properties: { obj: cyclic, workspaceId: "alice-1" } }),
		);
		const parsed = JSON.parse(line);
		expect(parsed.timestamp).toBe("2026-05-20T14:23:01.482Z");
		expect(parsed.workspaceId).toBe("alice-1");
		expect(typeof parsed.obj).toBe("string");
	});
});

describe("parseLogFormatEnv", () => {
	test("accepts text and json (case-insensitive, trimmed)", () => {
		expect(parseLogFormatEnv("text")).toBe("text");
		expect(parseLogFormatEnv("JSON")).toBe("json");
		expect(parseLogFormatEnv("  Json  ")).toBe("json");
	});

	test("returns null for unset or invalid values", () => {
		expect(parseLogFormatEnv(undefined)).toBeNull();
		expect(parseLogFormatEnv("")).toBeNull();
		expect(parseLogFormatEnv("logfmt")).toBeNull();
	});
});

describe("defaultLogFormat", () => {
	test("falls back to text when LOG_FORMAT is unset", () => {
		const original = process.env.LOG_FORMAT;
		delete process.env.LOG_FORMAT;
		try {
			expect(defaultLogFormat()).toBe("text");
		} finally {
			if (original !== undefined) process.env.LOG_FORMAT = original;
		}
	});

	test("honors LOG_FORMAT=json", () => {
		const original = process.env.LOG_FORMAT;
		process.env.LOG_FORMAT = "json";
		try {
			expect(defaultLogFormat()).toBe("json");
		} finally {
			if (original === undefined) delete process.env.LOG_FORMAT;
			else process.env.LOG_FORMAT = original;
		}
	});
});
