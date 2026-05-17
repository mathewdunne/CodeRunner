import { describe, expect, test } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
	test("merges class strings", () => {
		expect(cn("a", "b")).toBe("a b");
	});

	test("falsy values are dropped", () => {
		expect(cn("a", false, null, undefined, "b")).toBe("a b");
	});

	test("tailwind-merge resolves conflicts", () => {
		// tailwind-merge keeps the *last* applicable utility.
		expect(cn("p-2", "p-4")).toBe("p-4");
		expect(cn("text-red-500 text-sm", "text-lg")).toBe("text-red-500 text-lg");
	});

	test("conditional object syntax", () => {
		expect(cn("a", { b: true, c: false })).toBe("a b");
	});
});
