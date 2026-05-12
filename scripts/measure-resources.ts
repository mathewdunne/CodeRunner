#!/usr/bin/env bun
/**
 * Measure host resources and container memory usage for sizing decisions.
 *
 * Usage:
 *   bun scripts/measure-resources.ts [--json]
 *
 * Reports:
 *   - Host OS, CPU, total/available RAM, disk space
 *   - Running managed containers with memory usage
 *   - Per-container and total resource consumption
 *   - Extrapolated capacity for 10 students
 */

import { readFile } from "node:fs/promises";
import { cpus, totalmem, freemem, platform, arch, hostname } from "node:os";

const dockerPath = Bun.env.FRC_DOCKER_PATH ?? "docker";
const jsonOutput = process.argv.includes("--json");

type ContainerStats = {
  name: string;
  role: string;
  workspace: string;
  memoryUsageMB: number;
  memoryLimitMB: number;
  memoryPercent: number;
  cpuPercent: number;
  status: string;
};

type HostInfo = {
  hostname: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryGB: number;
  freeMemoryGB: number;
  usedMemoryGB: number;
};

type MeasurementReport = {
  timestamp: string;
  host: HostInfo;
  containers: ContainerStats[];
  totals: {
    codeContainers: number;
    totalMemoryUsedMB: number;
    avgCodeMemoryMB: number;
  };
  extrapolation: {
    studentsActive: number;
    estimatedCodeMemoryGB: number;
    estimatedTotalGB: number;
    headroomGB: number;
    recommendation: string;
  };
};

async function dockerRun(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const subprocess = Bun.spawn([dockerPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(subprocess.stdout).text();
  const exitCode = await subprocess.exited;
  return { stdout, exitCode };
}

function parseMemory(memStr: string): number {
  const trimmed = memStr.trim();
  const match = /^([\d.]+)\s*(B|KiB|MiB|GiB|kB|MB|GB)$/i.exec(trimmed);
  if (!match) return 0;
  const value = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1 / (1024 * 1024),
    kib: 1 / 1024,
    kb: 1 / 1024,
    mib: 1,
    mb: 1,
    gib: 1024,
    gb: 1024,
  };
  return value * (multipliers[unit] ?? 1);
}

async function getContainerStats(): Promise<ContainerStats[]> {
  // Get running managed containers (V1 and V2)
  const list = await dockerRun([
    "container",
    "ls",
    "--filter", "label=frc-sim.managed=true",
    "--filter", "status=running",
    "--format", "{{.Names}}",
  ]);

  if (list.exitCode !== 0 || !list.stdout.trim()) {
    return [];
  }

  const containerNames = list.stdout.trim().split(/\r?\n/).filter(Boolean);
  const stats: ContainerStats[] = [];

  for (const name of containerNames) {
    // Get stats
    const statsResult = await dockerRun([
      "stats", name, "--no-stream",
      "--format", "{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}",
    ]);

    // Get labels
    const inspectResult = await dockerRun([
      "inspect", name,
      "--format", "{{index .Config.Labels \"frc-sim.role\"}}\t{{index .Config.Labels \"frc-sim.workspace\"}}\t{{.State.Status}}",
    ]);

    if (statsResult.exitCode !== 0 || inspectResult.exitCode !== 0) continue;

    const [memUsage = "0MiB / 0MiB", memPercStr = "0%", cpuPercStr = "0%"] = statsResult.stdout.trim().split("\t");
    const [role = "unknown", workspace = "unknown", status = "unknown"] = inspectResult.stdout.trim().split("\t");

    const memParts = memUsage!.split("/").map((s) => s.trim());
    const memoryUsageMB = parseMemory(memParts[0] ?? "0MiB");
    const memoryLimitMB = parseMemory(memParts[1] ?? "0MiB");

    stats.push({
      name,
      role: role!,
      workspace: workspace!,
      memoryUsageMB: Math.round(memoryUsageMB * 10) / 10,
      memoryLimitMB: Math.round(memoryLimitMB * 10) / 10,
      memoryPercent: parseFloat(memPercStr!.replace("%", "")) || 0,
      cpuPercent: parseFloat(cpuPercStr!.replace("%", "")) || 0,
      status: status!,
    });
  }

  return stats;
}

function getHostInfo(): HostInfo {
  const cpuInfo = cpus();
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    cpuModel: cpuInfo[0]?.model ?? "unknown",
    cpuCores: cpuInfo.length,
    totalMemoryGB: Math.round((totalmem() / (1024 ** 3)) * 10) / 10,
    freeMemoryGB: Math.round((freemem() / (1024 ** 3)) * 10) / 10,
    usedMemoryGB: Math.round(((totalmem() - freemem()) / (1024 ** 3)) * 10) / 10,
  };
}

async function getDiskInfo(): Promise<{ totalGB: number; freeGB: number } | null> {
  if (platform() !== "linux" && platform() !== "darwin") {
    return null;
  }
  try {
    const result = Bun.spawn(["df", "-BG", "--output=size,avail", "."], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(result.stdout).text();
    await result.exited;
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) return null;
    const parts = lines[1]!.trim().split(/\s+/);
    return {
      totalGB: parseInt(parts[0] ?? "0"),
      freeGB: parseInt(parts[1] ?? "0"),
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const host = getHostInfo();
  const disk = await getDiskInfo();
  const containers = await getContainerStats();

  const codeContainers = containers.filter((c) => c.role === "code");

  const totalMemUsedMB = containers.reduce((sum, c) => sum + c.memoryUsageMB, 0);

  const avgCodeMB = codeContainers.length > 0
    ? codeContainers.reduce((sum, c) => sum + c.memoryUsageMB, 0) / codeContainers.length
    : 1280; // default estimate for merged code container

  const targetStudents = 10;
  const estimatedCodeGB = (avgCodeMB * targetStudents) / 1024;
  const estimatedTotalGB = estimatedCodeGB;
  const headroomGB = host.totalMemoryGB - estimatedTotalGB - 4; // 4GB for OS/Docker/browser

  let recommendation: string;
  if (headroomGB > 8) {
    recommendation = `Host has ample capacity for ${targetStudents} students (${headroomGB.toFixed(1)} GB headroom).`;
  } else if (headroomGB > 2) {
    recommendation = `Host can support ${targetStudents} students with moderate headroom (${headroomGB.toFixed(1)} GB). Monitor during peak usage.`;
  } else if (headroomGB > 0) {
    recommendation = `Host is tight for ${targetStudents} students (${headroomGB.toFixed(1)} GB headroom). Consider reducing memory limits or student count.`;
  } else {
    recommendation = `Host is insufficient for ${targetStudents} students (${headroomGB.toFixed(1)} GB deficit). Reduce students, lower memory limits, or add RAM.`;
  }

  const report: MeasurementReport = {
    timestamp: new Date().toISOString(),
    host,
    containers,
    totals: {
      codeContainers: codeContainers.length,
      totalMemoryUsedMB: Math.round(totalMemUsedMB),
      avgCodeMemoryMB: Math.round(avgCodeMB),
    },
    extrapolation: {
      studentsActive: targetStudents,
      estimatedCodeMemoryGB: Math.round(estimatedCodeGB * 10) / 10,
      estimatedTotalGB: Math.round(estimatedTotalGB * 10) / 10,
      headroomGB: Math.round(headroomGB * 10) / 10,
      recommendation,
    },
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Human-readable output
  console.log("═══ CodeRunner — Resource Report ═══\n");

  console.log("Host:");
  console.log(`  Hostname:    ${host.hostname}`);
  console.log(`  Platform:    ${host.platform} ${host.arch}`);
  console.log(`  CPU:         ${host.cpuModel} (${host.cpuCores} cores)`);
  console.log(`  RAM:         ${host.usedMemoryGB} GB used / ${host.totalMemoryGB} GB total (${host.freeMemoryGB} GB free)`);
  if (disk) {
    console.log(`  Disk:        ${disk.totalGB - disk.freeGB} GB used / ${disk.totalGB} GB total (${disk.freeGB} GB free)`);
  }

  console.log("\nV2 Containers:");
  if (containers.length === 0) {
    console.log("  No running V2 managed containers found.");
    console.log("  (Start the app and log in with some users to measure actual usage.)");
  } else {
    console.log(`  ${"Name".padEnd(35)} ${"Role".padEnd(5)} ${"Mem Used".padEnd(10)} ${"Mem Limit".padEnd(10)} ${"Mem%".padEnd(7)} CPU%`);
    console.log(`  ${"─".repeat(35)} ${"─".repeat(5)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(7)} ${"─".repeat(7)}`);
    for (const c of containers) {
      console.log(
        `  ${c.name.padEnd(35)} ${c.role.padEnd(5)} ${(c.memoryUsageMB + " MB").padEnd(10)} ${(c.memoryLimitMB + " MB").padEnd(10)} ${(c.memoryPercent + "%").padEnd(7)} ${c.cpuPercent}%`
      );
    }
    console.log(`\n  Total: ${codeContainers.length} code containers, ${Math.round(totalMemUsedMB)} MB memory`);
  }

  console.log("\nExtrapolation for 10 Students:");
  console.log(`  Avg code memory:  ${report.totals.avgCodeMemoryMB} MB × 10 = ${report.extrapolation.estimatedCodeMemoryGB} GB`);
  console.log(`  Estimated total:  ${report.extrapolation.estimatedTotalGB} GB (+ ~4 GB OS/Docker/browser overhead)`);
  console.log(`  Host headroom:    ${report.extrapolation.headroomGB} GB`);
  console.log(`\n  → ${report.extrapolation.recommendation}`);

  console.log("\n═══════════════════════════════════════════");
}

await main();
