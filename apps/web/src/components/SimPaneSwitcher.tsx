import type { TabsTab } from "@base-ui/react/tabs";
import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import advantagescopeLogo from "@/assets/advantagescope-logo.png";
import pathplannerLogo from "@/assets/pathplanner-logo.png";
import {
	Tabs,
	TabsContent,
	TabsIndicator,
	TabsList,
	TabsTrigger,
} from "@/components/ui/tabs";

type SimPaneTab = "scope" | "pathplanner" | "preview";

const STORAGE_KEY = "coderunner:sim-pane-tab";

function readStoredTab(): SimPaneTab {
	try {
		const stored = sessionStorage.getItem(STORAGE_KEY);
		// AdvantageScope stays the default for anything unrecognised, including
		// values written by an older build.
		return stored === "pathplanner" || stored === "preview" ? stored : "scope";
	} catch {
		return "scope";
	}
}

function asTab(value: TabsTab.Value): SimPaneTab {
	return value === "pathplanner" || value === "preview" ? value : "scope";
}

interface SimPaneTabsProps {
	className?: string;
	children: ReactNode;
	/** Notified whenever Preview becomes the active tab, to gate its first fetch. */
	onPreviewActivated?: () => void;
}

/**
 * Tabs root for the right-hand pane: AdvantageScope (default), PathPlanner or
 * Preview. The selector lives in the topbar and the panels live in the pane, so
 * the root has to wrap both — hence a page-level provider.
 * The choice persists for the session.
 */
export function SimPaneTabs({
	className,
	children,
	onPreviewActivated,
}: SimPaneTabsProps) {
	const [tab, setTab] = useState<SimPaneTab>(readStoredTab);

	// Keyed on the tab rather than on the change handler, so a session that
	// *starts* on Preview (restored from sessionStorage) activates it too.
	useEffect(() => {
		if (tab === "preview") onPreviewActivated?.();
	}, [tab, onPreviewActivated]);

	const onValueChange = useCallback((value: TabsTab.Value) => {
		const next = asTab(value);
		setTab(next);
		try {
			sessionStorage.setItem(STORAGE_KEY, next);
		} catch {
			// Session storage unavailable (private mode); the toggle still works.
		}
	}, []);

	return (
		<Tabs value={tab} onValueChange={onValueChange} className={className}>
			{children}
		</Tabs>
	);
}

/** Pill toggle rendered in the topbar. Must sit inside `SimPaneTabs`. */
export function SimPaneTabSelector({
	onReveal,
}: {
	onReveal?: () => void;
} = {}) {
	return (
		<TabsList aria-label="Right pane" variant="pill" className="p-[3px]">
			<TabsIndicator />
			<TabsTrigger
				value="scope"
				onClick={onReveal}
				onFocus={onReveal}
				className="px-3 text-[12.5px]"
			>
				<img src={advantagescopeLogo} alt="" className="size-4 shrink-0" />
				AdvantageScope
			</TabsTrigger>
			<TabsTrigger
				value="pathplanner"
				onClick={onReveal}
				onFocus={onReveal}
				className="px-3 text-[12.5px]"
			>
				<img src={pathplannerLogo} alt="" className="size-4 shrink-0" />
				PathPlanner
			</TabsTrigger>
			<TabsTrigger
				value="preview"
				onClick={onReveal}
				onFocus={onReveal}
				className="px-3 text-[12.5px]"
			>
				<FileText className="size-4 shrink-0" aria-hidden="true" />
				Preview
			</TabsTrigger>
		</TabsList>
	);
}

interface SimPanePanelsProps {
	scope: ReactNode;
	pathplanner: ReactNode;
	preview: ReactNode;
}

/**
 * The three right-pane panels. All stay mounted (`keepMounted`) — the hidden
 * iframes hold live state (an AdvantageScope session, PathPlanner's in-memory
 * working copy and save queue, Preview's selected document and scroll position)
 * that unmounting would discard.
 *
 * Preview is hidden differently. The default `hidden` attribute means
 * `display: none`, which collapses the document iframe's viewport and resets its
 * scroll to the top. The frame is cross-origin (sandboxed), so the shell cannot
 * save and restore that scroll itself. Instead the inactive Preview stays laid
 * out at full size, stacked out of flow and `invisible` (still `inert`).
 * AdvantageScope and PathPlanner keep `display: none` so their hidden apps stay
 * throttled.
 */
export function SimPanePanels({
	scope,
	pathplanner,
	preview,
}: SimPanePanelsProps) {
	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<TabsContent value="scope" keepMounted className="min-h-0 flex-1">
				{scope}
			</TabsContent>
			<TabsContent value="pathplanner" keepMounted className="min-h-0 flex-1">
				{pathplanner}
			</TabsContent>
			<TabsContent
				value="preview"
				keepMounted
				hidden={false}
				className="min-h-0 flex-1 data-hidden:invisible data-hidden:absolute data-hidden:inset-0"
			>
				{preview}
			</TabsContent>
		</div>
	);
}
