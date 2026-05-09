function defaultId(kind: "uid" | "gid"): string {
  const envName = kind === "uid" ? "FRC_UID" : "FRC_GID";
  const envValue = Bun.env[envName];
  if (envValue) {
    return envValue;
  }

  if (process.platform !== "win32") {
    if (kind === "uid" && typeof process.getuid === "function") {
      return String(process.getuid());
    }
    if (kind === "gid" && typeof process.getgid === "function") {
      return String(process.getgid());
    }
  }

  return "1000";
}

const dockerPath = Bun.env.FRC_DOCKER_PATH ?? "docker";
const image = Bun.env.CODE_IMAGE ?? "frc-code:v2";
const uid = defaultId("uid");
const gid = defaultId("gid");

const args = [
  "build",
  "-f",
  "containers/code/Dockerfile",
  "-t",
  image,
  "--build-arg",
  `FRC_UID=${uid}`,
  "--build-arg",
  `FRC_GID=${gid}`,
  ".",
];

console.log(`Building ${image} with FRC_UID=${uid} FRC_GID=${gid}`);

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
