import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Tab =
	| "dashboard"
	| "containers"
	| "workspaces"
	| "users"
	| "allowlist"
	| "audit-log";

const tabs: Array<{ id: Tab; label: string }> = [
	{ id: "dashboard", label: "Dashboard" },
	{ id: "containers", label: "Containers" },
	{ id: "workspaces", label: "Workspaces" },
	{ id: "users", label: "Users" },
	{ id: "allowlist", label: "Allowlist" },
	{ id: "audit-log", label: "Audit Log" },
];

export function AdminLayout({
	children,
	activeTab,
	onTabChange,
}: {
	children: ReactNode;
	activeTab: Tab;
	onTabChange: (tab: Tab) => void;
}) {
	return (
		<div className="flex min-h-screen bg-background text-foreground">
			<nav className="w-48 shrink-0 border-r border-zinc-800 p-4">
				<h1 className="mb-6 text-lg font-bold">Admin</h1>
				<ul className="space-y-1">
					{tabs.map((tab) => (
						<li key={tab.id}>
							<Button
								variant={activeTab === tab.id ? "secondary" : "ghost"}
								className="w-full justify-start"
								onClick={() => onTabChange(tab.id)}
							>
								{tab.label}
							</Button>
						</li>
					))}
				</ul>
				<div className="mt-8 border-t border-zinc-800 pt-4">
					<a
						href="/"
						className="text-sm text-muted-foreground hover:text-foreground"
					>
						← Back to workspace
					</a>
				</div>
			</nav>
			<main className="flex-1 p-6">{children}</main>
		</div>
	);
}

export type { Tab };
