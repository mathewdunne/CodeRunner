import type { Database } from "bun:sqlite";
import { recordAuditEvent } from "./audit";
import {
	listClassroomsNeedingCleanup,
	listGuestIds,
	markClassroomCleaned,
} from "./classrooms";
import { getLogger } from "./logging";
import type { AppStorage } from "./storage";

const log = getLogger("classroom");
const SYSTEM_ACTOR = { userId: "<system>", email: "<system>" };

/** Delete every guest of a classroom and mark it cleaned. Returns the guest count. */
export async function cleanupClassroom(
	db: Database,
	classroomId: string,
	deleteUser: (userId: string) => Promise<void>,
	now = new Date(),
): Promise<number> {
	const guestIds = listGuestIds(db, classroomId);
	for (const userId of guestIds) {
		await deleteUser(userId);
	}
	markClassroomCleaned(db, classroomId, now);
	return guestIds.length;
}

export type ClassroomSweeperOptions = {
	storage: AppStorage;
	deleteUser: (userId: string) => Promise<void>;
	intervalMs?: number;
};

/** Deletes the guests of ended or expired classrooms, once per classroom. */
export class ClassroomSweeper {
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly storage: AppStorage;
	private readonly deleteUser: (userId: string) => Promise<void>;
	private readonly intervalMs: number;

	constructor(options: ClassroomSweeperOptions) {
		this.storage = options.storage;
		this.deleteUser = options.deleteUser;
		this.intervalMs = options.intervalMs ?? 60_000;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.sweep(), this.intervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	async sweep(now = new Date()): Promise<string[]> {
		const cleaned: string[] = [];
		for (const classroom of listClassroomsNeedingCleanup(
			this.storage.db,
			now,
		)) {
			try {
				const guestCount = await cleanupClassroom(
					this.storage.db,
					classroom.id,
					this.deleteUser,
					now,
				);
				recordAuditEvent(this.storage, {
					actor: SYSTEM_ACTOR,
					action: "classroom.cleanup",
					target: { kind: "classroom", id: classroom.id },
					metadata: { guestCount },
				});
				log.info("classroom cleaned up", {
					classroomId: classroom.id,
					guestCount,
				});
				cleaned.push(classroom.id);
			} catch (err) {
				log.warn("classroom cleanup failed", {
					classroomId: classroom.id,
					err: err instanceof Error ? err : new Error(String(err)),
				});
			}
		}
		return cleaned;
	}
}
