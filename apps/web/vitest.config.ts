import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: { "@": path.resolve(__dirname, "./src") },
	},
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./src/test/setup.ts"],
		css: false,
		include: ["src/**/*.{test,spec}.{ts,tsx}"],
		exclude: [
			"node_modules/**",
			"dist/**",
			// The bun-test file lives next to the source — Vitest can run it too, but
			// exclude here so it doesn't double-run alongside `bun test`.
			"src/lib/keyboard-mapping.test.ts",
			"src/lib/keyboard-mapping.property.test.ts",
		],
	},
});
