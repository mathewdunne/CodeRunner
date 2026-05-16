const dockerPath = Bun.env.FRC_DOCKER_PATH ?? "docker";
const image = Bun.env.CODE_IMAGE ?? "coderunner-workspace";

const args = [
  "build",
  "-f",
  "containers/code/Dockerfile",
  "-t",
  image,
  ".",
];

console.log(`Building ${image}`);

const subprocess = Bun.spawn([dockerPath, ...args], {
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await subprocess.exited;
if (exitCode !== 0) {
  console.error(`docker ${args.join(" ")} failed with exit code ${exitCode}`);
  process.exit(exitCode);
}

export {};
