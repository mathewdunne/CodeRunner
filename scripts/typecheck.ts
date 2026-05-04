const projects = [
  "packages/contracts/tsconfig.json",
  "apps/control/tsconfig.json",
  "apps/web/tsconfig.json",
  "scripts/tsconfig.json",
];

for (const project of projects) {
  console.log(`typecheck ${project}`);
  const result = Bun.spawnSync(["bunx", "tsc", "-p", project], {
    stdout: "inherit",
    stderr: "inherit",
  });

  if (!result.success) {
    process.exit(result.exitCode ?? 1);
  }
}
