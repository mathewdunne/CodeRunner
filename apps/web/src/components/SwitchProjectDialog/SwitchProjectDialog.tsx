import { BookOpen, Cpu, RotateCcw, Terminal } from "lucide-react";
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
import type { LessonModule } from "@/lib/contracts";
import { cn } from "@/lib/utils";

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
								{!loading && modules.length === 0 && !error && (
									<p className="py-6 text-center text-[12.5px] text-muted-foreground">
										No lessons are available yet.
									</p>
								)}

								<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
									{modules.map((module, index) => {
										const isCurrent = module.id === currentModule;
										return (
											<div
												key={module.id}
												className={cn(
													"group relative flex flex-col rounded-lg border bg-card/40 p-3 transition-colors",
													isCurrent
														? "border-primary/60 ring-1 ring-primary/40"
														: "border-border hover:border-border/80 hover:bg-accent/40",
												)}
											>
												<div className="mb-1 flex items-start justify-between gap-2">
													<h4 className="text-[13px] font-semibold leading-tight text-foreground">
														{index + 1}. {module.title}
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
															onClick={() =>
																setPending({ kind: "reset", module })
															}
														>
															<RotateCcw className="size-3.5" />
															Reset
														</Button>
													) : (
														<Button
															type="button"
															size="sm"
															className="h-7 px-3 text-[12px]"
															onClick={() => choose({ kind: "lesson", module })}
														>
															Load
														</Button>
													)}
												</div>
											</div>
										);
									})}
								</div>

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
