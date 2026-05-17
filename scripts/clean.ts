#!/usr/bin/env bun
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const targets = ["apps/web/dist", "dist/advantagescope"];

for (const target of targets) {
	const path = resolve(repoRoot, target);
	await rm(path, { recursive: true, force: true });
	console.log(`removed ${target}`);
}
