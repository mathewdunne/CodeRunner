import coderunnerMascotImg from "@/assets/coderunner-mascot.png";

interface ServiceOfflinePageProps {
	onRetry: () => void;
}

export function ServiceOfflinePage({ onRetry }: ServiceOfflinePageProps) {
	return (
		<div className="flex h-screen w-full overflow-hidden bg-background">
			{/* Left panel — mascot */}
			<div
				className="relative hidden flex-col items-center justify-center lg:flex"
				style={{ width: "55%" }}
			>
				<div
					className="absolute inset-0 bg-card"
					style={{
						background:
							"radial-gradient(ellipse at 50% 60%, oklch(0.24 0 0) 0%, oklch(0.145 0 0) 75%)",
					}}
				/>
				<img
					src={coderunnerMascotImg}
					alt="CodeRunner mascot"
					className="relative z-10 w-150 select-none drop-shadow-2xl"
					draggable={false}
				/>
			</div>

			{/* Divider */}
			<div className="hidden w-px shrink-0 bg-border lg:block" />

			{/* Right panel */}
			<div className="flex flex-1 flex-col items-center justify-center px-8">
				<div className="w-full max-w-[320px]">
					<p className="mb-6 text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
						Service status
					</p>

					<p className="text-[22px] font-semibold text-foreground">
						CodeRunner is Offline
					</p>
					<p className="mt-2 text-[12px] text-muted-foreground">
						This service is currently unavailable. Check back soon or contact an
						administrator.
					</p>

					<div className="mt-6 rounded-lg border border-border bg-card p-2">
						<button
							type="button"
							onClick={onRetry}
							className="flex h-11 w-full items-center justify-center gap-3 rounded-md border border-border bg-white/[0.06] px-4 text-[13px] font-semibold tracking-wide text-foreground transition-all hover:bg-white/[0.11]"
						>
							Retry
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
