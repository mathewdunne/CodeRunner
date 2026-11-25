import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Default RAF/CAF — jsdom omits these. Tests that need finer control should
// override via vi.spyOn(window, "requestAnimationFrame").
if (typeof globalThis.requestAnimationFrame !== "function") {
	globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number =>
		setTimeout(() => cb(performance.now()), 16) as unknown as number;
	globalThis.cancelAnimationFrame = (id: number): void =>
		clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

afterEach(() => {
	cleanup();
});

// Node 22+ defines a `localStorage` global that is inert unless the process was
// started with `--localstorage-file`, and jsdom does not overwrite it. Zustand's
// persist middleware then captures an undefined storage and every write throws.
// Install a minimal in-memory Storage so the store tests exercise the real
// persistence path regardless of the Node flags.
if (typeof globalThis.localStorage === "undefined") {
	class MemoryStorage implements Storage {
		private readonly items = new Map<string, string>();

		get length(): number {
			return this.items.size;
		}

		clear(): void {
			this.items.clear();
		}

		getItem(key: string): string | null {
			return this.items.get(key) ?? null;
		}

		key(index: number): string | null {
			return [...this.items.keys()][index] ?? null;
		}

		removeItem(key: string): void {
			this.items.delete(key);
		}

		setItem(key: string, value: string): void {
			this.items.set(key, value);
		}
	}

	Object.defineProperty(globalThis, "localStorage", {
		value: new MemoryStorage(),
		configurable: true,
		writable: true,
	});
}
