import { useCallback, useEffect, useState } from "react";
import type { LessonCatalogEntry } from "@/lib/contracts";
import { lessonCatalogResponseSchema } from "@/lib/contracts";

interface UseLessonsReturn {
	modules: LessonCatalogEntry[];
	error: string | null;
	loading: boolean;
	refetch: () => void;
}

/**
 * Loads the lesson catalog (`GET /api/lessons`). The control plane always
 * returns a catalog (remote or bundled), so an empty `modules` array with a
 * non-null `error` is the "catalog temporarily unavailable" state.
 */
export function useLessons(workspaceSlug: string | null): UseLessonsReturn {
	const [modules, setModules] = useState<LessonCatalogEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [nonce, setNonce] = useState(0);

	const refetch = useCallback(() => setNonce((n) => n + 1), []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is a manual refetch trigger.
	useEffect(() => {
		if (!workspaceSlug) return;
		let cancelled = false;
		setLoading(true);

		void (async () => {
			try {
				const response = await fetch(`/u/${workspaceSlug}/api/lessons`, {
					credentials: "same-origin",
				});
				const parsed = lessonCatalogResponseSchema.parse(await response.json());
				if (cancelled) return;
				setModules(parsed.modules);
				setError(parsed.error ?? null);
			} catch (err) {
				if (cancelled) return;
				setModules([]);
				setError(
					err instanceof Error ? err.message : "Unable to load lessons.",
				);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [workspaceSlug, nonce]);

	return { modules, error, loading, refetch };
}
