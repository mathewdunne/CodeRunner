import {
	configure,
	getLogger as getLogTapeLogger,
	isLogLevel,
	type Logger,
	type LogLevel,
	type LogRecord,
	type Sink,
} from "@logtape/logtape";

export type { Logger, LogLevel };

const VALID_LEVELS = [
	"trace",
	"debug",
	"info",
	"warning",
	"error",
	"fatal",
] as const;

const ROOT_CATEGORY = "control";

const ANSI = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
} as const;

const LEVEL_DISPLAY: Record<LogLevel, string> = {
	trace: "TRACE",
	debug: "DEBUG",
	info: "INFO ",
	warning: "WARN ",
	error: "ERROR",
	fatal: "FATAL",
};

const LEVEL_COLOR: Record<LogLevel, string> = {
	trace: ANSI.gray,
	debug: ANSI.blue,
	info: ANSI.green,
	warning: ANSI.yellow,
	error: ANSI.red,
	fatal: ANSI.magenta,
};

const CATEGORY_PAD = 22;

let useColor = false;

export function parseLogLevelEnv(value: string | undefined): LogLevel | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "warn") return "warning";
	return isLogLevel(normalized) ? normalized : null;
}

export function defaultLogLevel(): LogLevel {
	const fromEnv = parseLogLevelEnv(
		typeof Bun !== "undefined" ? Bun.env.LOG_LEVEL : process.env.LOG_LEVEL,
	);
	if (fromEnv) return fromEnv;
	const nodeEnv =
		(typeof Bun !== "undefined" ? Bun.env.NODE_ENV : process.env.NODE_ENV) ??
		"";
	if (nodeEnv === "test" || process.env.E2E_TEST === "1") return "warning";
	return "debug";
}

function pad(str: string, width: number): string {
	return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	const ms = String(d.getMilliseconds()).padStart(3, "0");
	return `${hh}:${mm}:${ss}.${ms}`;
}

function renderMessage(message: readonly unknown[]): string {
	let out = "";
	for (let i = 0; i < message.length; i++) {
		if (i % 2 === 0) {
			out += String(message[i] ?? "");
		} else {
			out += formatValue(message[i]);
		}
	}
	return out;
}

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NEEDS_QUOTE = /[\s"=]|^$/;

function formatValue(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return value;
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return String(value);
	}
	if (value instanceof Error) return value.message;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function formatAttrValue(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") {
		return NEEDS_QUOTE.test(value) ? JSON.stringify(value) : value;
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return String(value);
	}
	if (value instanceof Error) {
		return JSON.stringify(value.message);
	}
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify(String(value));
	}
}

function formatAttrs(
	properties: Record<string, unknown>,
	includeStack: boolean,
): { inline: string; trailing: string } {
	const keys = Object.keys(properties);
	if (keys.length === 0) return { inline: "", trailing: "" };

	const parts: string[] = [];
	let trailing = "";

	for (const key of keys) {
		const value = properties[key];
		if (value instanceof Error) {
			parts.push(`${renderKey(key)}=${formatAttrValue(value)}`);
			if (includeStack && value.stack) {
				const indent = "    ";
				trailing +=
					"\n" +
					value.stack
						.split("\n")
						.map((line) => indent + line)
						.join("\n");
			}
			continue;
		}
		parts.push(`${renderKey(key)}=${formatAttrValue(value)}`);
	}

	return { inline: parts.join(" "), trailing };
}

function renderKey(key: string): string {
	return SAFE_KEY.test(key) ? key : JSON.stringify(key);
}

function colorize(text: string, code: string): string {
	return useColor ? `${code}${text}${ANSI.reset}` : text;
}

const STACK_LEVELS = new Set<LogLevel>(["warning", "error", "fatal"]);

function formatRecord(record: LogRecord): string {
	const ts = colorize(formatTimestamp(record.timestamp), ANSI.dim);
	const level = colorize(
		LEVEL_DISPLAY[record.level],
		LEVEL_COLOR[record.level],
	);
	const categoryStr = `[${record.category.join(".")}]`;
	const category = colorize(pad(categoryStr, CATEGORY_PAD), ANSI.dim);
	const message = renderMessage(record.message);
	const { inline, trailing } = formatAttrs(
		record.properties,
		STACK_LEVELS.has(record.level),
	);
	const attrs = inline ? ` ${colorize(inline, ANSI.dim)}` : "";
	return `${ts} ${level} ${category} ${message}${attrs}${trailing}`;
}

function createSink(): Sink {
	return (record: LogRecord) => {
		const line = `${formatRecord(record)}\n`;
		if (record.level === "error" || record.level === "fatal") {
			process.stderr.write(line);
		} else {
			process.stdout.write(line);
		}
	};
}

let configured = false;

export async function configureLogging(level: LogLevel): Promise<void> {
	useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== "1";
	await configure({
		reset: true,
		sinks: { console: createSink() },
		loggers: [
			{ category: ROOT_CATEGORY, sinks: ["console"], lowestLevel: level },
			{
				category: ["logtape", "meta"],
				sinks: ["console"],
				lowestLevel: "warning",
			},
		],
	});
	configured = true;
}

export function getLogger(...subcategory: string[]): Logger {
	if (!configured) {
		// Lazy fallback so importing modules before configureLogging() runs doesn't crash.
		// Records are dropped until configureLogging() is invoked.
	}
	return getLogTapeLogger([ROOT_CATEGORY, ...subcategory]);
}

export const VALID_LOG_LEVELS = VALID_LEVELS;
