import {
	BookOpen,
	ChevronDown,
	ChevronRight,
	Cpu,
	Folder,
	RotateCcw,
	Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SiGithub } from "react-icons/si";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useLessons } from "@/hooks/useLessons";
import { type ProjectSwapKind, useProjectSwap } from "@/hooks/useProjectSwap";
import type { LessonCatalogEntry, LessonModule } from "@/lib/contracts";
import { cn } from "@/lib/utils";
import {
	catalogContainsModule,
	countCatalogModules,
	folderPathKey,
	groupCatalogBlocks,
} from "./module-groups";

interface SwitchProjectDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceSlug: string | null;
	currentModule: string | null;
	/** An empty workspace has nothing to discard, so loads skip the confirm step. */
	projectEmpty: boolean;
	/** Called after a project swap finishes successfully. */
	onSwapComplete: () => void;
}

type Pending =
	| { kind: "lesson"; module: LessonModule }
	| { kind: "reset"; module: LessonModule }
	| { kind: "import"; url: string };

function KindTag({ kind }: { kind: LessonModule["kind"] }) {
	const isRobot = kind === "robot";
	return (
		<Badge
			variant="outline"
			className="gap-1 border-border/70 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
		>
			{isRobot ? <Cpu className="size-3" /> : <Terminal className="size-3" />}
			{isRobot ? "Robot" : "Console"}
		</Badge>
	);
}

interface ModuleCardProps {
	module: LessonModule;
	isCurrent: boolean;
	onChoose: (module: LessonModule) => void;
	onReset: (module: LessonModule) => void;
}

function ModuleCard({ module, isCurrent, onChoose, onReset }: ModuleCardProps) {
	return (
		<div
			className={cn(
				"group relative flex flex-col rounded-lg border bg-card/40 p-3 transition-colors",
				isCurrent
					? "border-primary/60 ring-1 ring-primary/40"
					: "border-border hover:border-border/80 hover:bg-accent/40",
			)}
		>
			<div className="mb-1 flex items-start justify-between gap-2">
				<h4 className="text-[13px] font-semibold leading-tight text-foreground">
					{module.title}
				</h4>
				<KindTag kind={module.kind} />
			</div>
			<p className="mb-3 line-clamp-2 flex-1 text-[11.5px] leading-snug text-muted-foreground">
				{module.description}
			</p>
			<div className="flex items-center justify-between">
				{isCurrent ? (
					<span className="text-[10.5px] font-medium uppercase tracking-wide text-primary">
						Current
					</span>
				) : (
					<span />
				)}
				{isCurrent ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 gap-1.5 px-2 text-[12px]"
						onClick={() => onReset(module)}
					>
						<RotateCcw className="size-3.5" />
						Reset
					</Button>
				) : (
					<Button
						type="button"
						size="sm"
						className="h-7 px-3 text-[12px]"
						onClick={() => onChoose(module)}
					>
						Load
					</Button>
				)}
			</div>
		</div>
	);
}

interface ModuleGridProps {
	modules: LessonModule[];
	currentModule: string | null;
	onChoose: (module: LessonModule) => void;
	onReset: (module: LessonModule) => void;
}

function ModuleGrid({
	modules,
	currentModule,
	onChoose,
	onReset,
}: ModuleGridProps) {
	return (
		<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
			{modules.map((module) => (
				<ModuleCard
					key={module.id}
					module={module}
					isCurrent={module.id === currentModule}
					onChoose={onChoose}
					onReset={onReset}
				/>
			))}
		</div>
	);
}

interface CatalogTreeProps {
	entries: LessonCatalogEntry[];
	path: string[];
	depth: number;
	currentModule: string | null;
	collapsedFolders: Set<string>;
	onToggleFolder: (key: string) => void;
	onChoose: (module: LessonModule) => void;
	onReset: (module: LessonModule) => void;
}

function CatalogTree({
	entries,
	path,
	depth,
	currentModule,
	collapsedFolders,
	onToggleFolder,
	onChoose,
	onReset,
}: CatalogTreeProps) {
	const blocks = groupCatalogBlocks(entries);

	return (
		<div className={cn(depth > 0 && "ml-3 border-l border-border/60 pl-3")}>
			{blocks.map((block, index) => {
				if (block.type === "modules") {
					return (
						<div
							key={`modules-${block.modules[0]?.id}`}
							className={cn(index > 0 && "mt-3")}
						>
							<ModuleGrid
								modules={block.modules}
								currentModule={currentModule}
								onChoose={onChoose}
								onReset={onReset}
							/>
						</div>
					);
				}

				const folderPath = [...path, block.folder.folder];
				const folderKey = folderPathKey(folderPath);
				const expanded = !collapsedFolders.has(folderKey);
				const contentId = `lesson-folder-${encodeURIComponent(folderPath.join("/"))}`;
				const hasCurrent = catalogContainsModule(
					block.folder.modules,
					currentModule,
				);
				return (
					<section
						key={`folder-${folderKey}`}
						className={cn(index > 0 && "mt-3")}
					>
						<button
							type="button"
							aria-expanded={expanded}
							aria-controls={contentId}
							onClick={() => onToggleFolder(folderKey)}
							className="-mx-1 mb-2 flex w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/40"
						>
							{expanded ? (
								<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
							) : (
								<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
							)}
							<Folder className="size-3.5 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[12px] font-semibold text-foreground">
									{block.folder.folder}
								</span>
								{block.folder.description && (
									<span className="block truncate text-[11px] font-normal text-muted-foreground">
										{block.folder.description}
									</span>
								)}
							</span>
							<span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
								{countCatalogModules(block.folder.modules)}
							</span>
							{hasCurrent && (
								<span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-primary">
									Current
								</span>
							)}
						</button>
						{expanded && (
							<div id={contentId}>
								<CatalogTree
									entries={block.folder.modules}
									path={folderPath}
									depth={depth + 1}
									currentModule={currentModule}
									collapsedFolders={collapsedFolders}
									onToggleFolder={onToggleFolder}
									onChoose={onChoose}
									onReset={onReset}
								/>
							</div>
						)}
					</section>
				);
			})}
		</div>
	);
}

export function SwitchProjectDialog({
	open,
	onOpenChange,
	workspaceSlug,
	currentModule,
	projectEmpty,
	onSwapComplete,
}: SwitchProjectDialogProps) {
	const { modules, error, loading } = useLessons(open ? workspaceSlug : null);
	const { state, startSwap, reset } = useProjectSwap(workspaceSlug);

	const [pending, setPending] = useState<Pending | null>(null);
	const [url, setUrl] = useState("");
	const [urlError, setUrlError] = useState("");
	const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
		new Set(),
	);

	const running = state.status === "connecting" || state.status === "running";
	const finished = state.status === "done" || state.status === "error";

	// Notify the parent once a swap lands successfully.
	useEffect(() => {
		if (state.status === "done" && state.success) {
			onSwapComplete();
		}
	}, [state.status, state.success, onSwapComplete]);

	const resetAll = useCallback(() => {
		setPending(null);
		setUrl("");
		setUrlError("");
		setCollapsedFolders(new Set());
		reset();
	}, [reset]);

	const handleClose = useCallback(() => {
		if (running) return; // never close mid-swap
		resetAll();
		onOpenChange(false);
	}, [running, resetAll, onOpenChange]);

	const validateUrl = useCallback((value: string): boolean => {
		const trimmed = value.trim();
		if (!trimmed) {
			setUrlError("Enter a GitHub repository URL.");
			return false;
		}
		if (/^git@/i.test(trimmed)) {
			setUrlError("SSH URLs are not supported. Use an HTTPS GitHub URL.");
			return false;
		}
		try {
			const parsed = new URL(trimmed);
			if (parsed.hostname !== "github.com") {
				setUrlError("Only github.com URLs are supported.");
				return false;
			}
		} catch {
			setUrlError("That doesn't look like a valid URL.");
			return false;
		}
		setUrlError("");
		return true;
	}, []);

	const run = useCallback(
		(next: Pending) => {
			const target: ProjectSwapKind =
				next.kind === "import"
					? { kind: "import", url: next.url }
					: { kind: "lesson", moduleId: next.module.id };
			startSwap(target);
		},
		[startSwap],
	);

	const choose = useCallback(
		(next: Pending) => {
			if (projectEmpty) run(next);
			else setPending(next);
		},
		[projectEmpty, run],
	);

	const chooseModule = useCallback(
		(module: LessonModule) => choose({ kind: "lesson", module }),
		[choose],
	);

	const resetModule = useCallback((module: LessonModule) => {
		setPending({ kind: "reset", module });
	}, []);

	const toggleFolder = useCallback((folder: string) => {
		setCollapsedFolders((previous) => {
			const next = new Set(previous);
			if (next.has(folder)) next.delete(folder);
			else next.add(folder);
			return next;
		});
	}, []);

	const repoName = useMemo(() => {
		if (!pending || pending.kind !== "import") return "";
		const match = /github\.com\/([^/]+\/[^/]+)/i.exec(pending.url);
		return match ? match[1]?.replace(/\.git$/, "") : pending.url;
	}, [pending]);

	const showConfirm = pending !== null && state.status === "idle";
	const showProgress = running || finished;

	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (!v) handleClose();
			}}
		>
			<DialogContent
				className={cn(
					"gap-0 overflow-hidden p-0",
					showProgress || showConfirm ? "sm:max-w-md" : "sm:max-w-2xl",
				)}
				showCloseButton={!running}
			>
				{/* ── Browse ─────────────────────────────────────────────── */}
				{!showConfirm && !showProgress && (
					<>
						<DialogHeader className="border-b border-border px-5 py-4">
							<DialogTitle className="text-[15px]">Switch project</DialogTitle>
							<DialogDescription className="text-[12.5px]">
								Pick a lesson or import a team repo. This replaces what's in
								your workspace.
							</DialogDescription>
						</DialogHeader>

						<ScrollArea className="max-h-[60vh]">
							<div className="px-5 py-4">
								<div className="mb-2.5 flex items-center gap-2">
									<BookOpen className="size-3.5 text-muted-foreground" />
									<h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
										Lessons
									</h3>
								</div>

								{error && (
									<p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
										{error}
									</p>
								)}
								{loading && modules.length === 0 && (
									<p className="py-6 text-center text-[12.5px] text-muted-foreground">
										Loading lessons…
									</p>
								)}
								{!loading && countCatalogModules(modules) === 0 && !error && (
									<p className="py-6 text-center text-[12.5px] text-muted-foreground">
										No lessons are available yet.
									</p>
								)}

								<CatalogTree
									entries={modules}
									path={[]}
									depth={0}
									currentModule={currentModule}
									collapsedFolders={collapsedFolders}
									onToggleFolder={toggleFolder}
									onChoose={chooseModule}
									onReset={resetModule}
								/>

								{/* ── Import from GitHub ─────────────────────────── */}
								<div className="mt-5 border-t border-border pt-4">
									<div className="mb-2.5 flex items-center gap-2">
										<SiGithub className="size-3.5 text-muted-foreground" />
										<h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
											Import from GitHub
										</h3>
									</div>
									<p className="mb-2.5 text-[11.5px] leading-snug text-muted-foreground">
										Load a public team repo for build season. Keeps git history
										so you can push from the editor terminal once you sign in.
									</p>
									<div className="flex items-start gap-2">
										<div className="flex-1">
											<input
												type="url"
												className="flex h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[12.5px] shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
												placeholder="https://github.com/team1234/robot-2026"
												value={url}
												onChange={(e) => {
													setUrl(e.target.value);
													setUrlError("");
												}}
												onKeyDown={(e) => {
													if (e.key === "Enter") {
														if (validateUrl(url))
															choose({ kind: "import", url: url.trim() });
													}
												}}
											/>
											{urlError && (
												<p className="mt-1 text-[11px] text-destructive">
													{urlError}
												</p>
											)}
										</div>
										<Button
											type="button"
											variant="outline"
											size="sm"
											className="h-8 shrink-0 px-3 text-[12.5px]"
											onClick={() => {
												if (validateUrl(url))
													choose({ kind: "import", url: url.trim() });
											}}
										>
											Import
										</Button>
									</div>
								</div>
							</div>
						</ScrollArea>
					</>
				)}

				{/* ── Confirm ────────────────────────────────────────────── */}
				{showConfirm && pending && (
					<div className="p-5">
						<DialogHeader>
							<DialogTitle className="text-[15px]">
								{pending.kind === "reset"
									? "Reset this lesson?"
									: "Discard current work?"}
							</DialogTitle>
							<DialogDescription className="text-[12.5px]">
								{pending.kind === "import" ? (
									<>
										This replaces your workspace with{" "}
										<strong className="text-foreground">{repoName}</strong>.
									</>
								) : pending.kind === "reset" ? (
									<>
										This reloads{" "}
										<strong className="text-foreground">
											{pending.module.title}
										</strong>{" "}
										from scratch (latest version).
									</>
								) : (
									<>
										This loads{" "}
										<strong className="text-foreground">
											{pending.module.title}
										</strong>
										.
									</>
								)}{" "}
								Any changes in your current workspace will be lost.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter className="mt-5">
							<Button
								type="button"
								variant="outline"
								onClick={() => setPending(null)}
							>
								Back
							</Button>
							<Button type="button" onClick={() => run(pending)}>
								{pending.kind === "reset" ? "Reset" : "Continue"}
							</Button>
						</DialogFooter>
					</div>
				)}

				{/* ── Progress ───────────────────────────────────────────── */}
				{showProgress && (
					<div className="p-5">
						<DialogHeader>
							<DialogTitle className="text-[15px]">
								{state.status === "done"
									? state.success
										? "Project ready"
										: "Something went wrong"
									: state.status === "error"
										? "Something went wrong"
										: "Loading project…"}
							</DialogTitle>
							{state.detail && (
								<DialogDescription className="text-[12.5px]">
									{state.detail}
								</DialogDescription>
							)}
						</DialogHeader>

						{running && (
							<div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
								<div className="h-full w-3/5 animate-pulse rounded-full bg-primary" />
							</div>
						)}

						{state.logLines.length > 0 && (
							<ScrollArea className="mt-3 max-h-32 rounded-md border border-border bg-muted/30 p-2">
								<div className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
									{state.logLines.map((line, i) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: append-only log output
										<p key={i}>{line}</p>
									))}
								</div>
							</ScrollArea>
						)}

						{finished && state.message && (
							<p
								className={cn(
									"mt-3 text-[12.5px]",
									state.success ? "text-foreground" : "text-destructive",
								)}
							>
								{state.message}
							</p>
						)}

						{finished && (
							<DialogFooter className="mt-5">
								{!state.success && (
									<Button type="button" variant="outline" onClick={resetAll}>
										Back
									</Button>
								)}
								<Button type="button" onClick={handleClose}>
									{state.success ? "Done" : "Close"}
								</Button>
							</DialogFooter>
						)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
