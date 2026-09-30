import { FileText, Replace } from "lucide-react";
import type { ReactNode } from "react";
import coderunnerHeaderImg from "@/assets/coderunner-header.png";
import { SimPaneTabSelector } from "@/components/SimPaneSwitcher";
import { UserMenu } from "@/components/UserMenu";
import { Button } from "@/components/ui/button";

interface TopbarProps {
	displayName: string;
	email: string;
	avatarUrl: string | null;
	isAdmin: boolean;
	onSwitchProject: () => void;
	/** Only for layouts that render the sim pane; requires a `SimPaneTabs` root. */
	showSimPaneTabs?: boolean;
	/**
	 * Console (`plain-java`) lessons have no pane selector, so Preview gets a
	 * plain show/hide button in the same slot. Undefined hides the control.
	 */
	previewOpen?: boolean;
	onTogglePreview?: () => void;
	layoutMenu?: ReactNode;
	onRevealRightPane?: () => void;
	/** Forwarded to the user menu for classroom guests. */
	guest?: { endsAt: string; workspaceSlug: string };
}

export function Topbar({
	displayName,
	email,
	avatarUrl,
	isAdmin,
	onSwitchProject,
	showSimPaneTabs = false,
	previewOpen,
	onTogglePreview,
	layoutMenu,
	guest,
	onRevealRightPane,
}: TopbarProps) {
	return (
		<header className="flex min-h-[48px] shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1">
			<div className="flex items-center gap-2.5">
				<img src={coderunnerHeaderImg} alt="" className="h-6 w-auto" />
				<strong className="whitespace-nowrap text-[13.5px] font-semibold tracking-tight">
					CodeRunner
				</strong>
			</div>
			<div className="ml-auto flex flex-wrap items-center gap-2 min-[1100px]:gap-5">
				{showSimPaneTabs && <SimPaneTabSelector onReveal={onRevealRightPane} />}
				{!showSimPaneTabs && onTogglePreview && (
					<Button
						type="button"
						variant={previewOpen ? "secondary" : "outline"}
						size="sm"
						className="h-8 gap-1.5 px-2.5 text-[12.5px]"
						onClick={onTogglePreview}
						aria-pressed={previewOpen}
					>
						<FileText className="size-[15px] text-muted-foreground" />
						Preview
					</Button>
				)}
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-8 gap-1.5 px-2.5 text-[12.5px]"
					onClick={onSwitchProject}
				>
					<Replace className="size-[15px] text-muted-foreground" />
					Switch project
				</Button>
				<UserMenu
					displayName={displayName}
					email={email}
					avatarUrl={avatarUrl}
					isAdmin={isAdmin}
					layoutMenu={layoutMenu}
					guest={guest}
				/>
			</div>
		</header>
	);
}
