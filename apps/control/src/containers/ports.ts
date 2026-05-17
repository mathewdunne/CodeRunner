import { createServer } from "node:net";
import type { WorkspaceId } from "@frc-sim/contracts";
import type { AppStorage } from "../storage";

export async function portIsFree(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolvePort) => {
		const server = createServer();
		let settled = false;

		const settle = (free: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			if (free) {
				server.close(() => resolvePort(true));
			} else {
				resolvePort(false);
			}
		};

		// Bun's node:net runtime exposes EventEmitter methods, but its Server type
		// currently omits them.
		const eventedServer = server as unknown as {
			once(event: "error", listener: () => void): void;
		};
		eventedServer.once("error", () => settle(false));
		server.listen({ host: "127.0.0.1", port }, () => settle(true));
	});
}

export async function allocatePortFromRange(
	storage: AppStorage,
	portAvailable: (port: number) => Promise<boolean>,
	role: "sim" | "code" | "halsim",
	workspaceId: WorkspaceId,
	preferredPort: number | null,
	rejectedPorts: Set<number>,
): Promise<number> {
	const range =
		role === "sim"
			? storage.config.simPortRange
			: role === "halsim"
				? storage.config.halsimPortRange
				: storage.config.vscodePortRange;
	const leasedPorts = new Set(storage.listLeasedPorts(role, workspaceId));
	const candidates: number[] = [];
	if (preferredPort !== null) {
		candidates.push(preferredPort);
	}
	for (let port = range.start; port <= range.end; port += 1) {
		candidates.push(port);
	}

	for (const port of candidates) {
		if (port < range.start || port > range.end) {
			continue;
		}
		if (rejectedPorts.has(port)) {
			continue;
		}
		if (leasedPorts.has(port)) {
			continue;
		}
		if (await portAvailable(port)) {
			return port;
		}
	}

	throw new Error(
		`No free ${role} ports are available in ${range.start}-${range.end}.`,
	);
}
