import { UserMenu } from "@/components/UserMenu";

interface TopbarProps {
  displayName: string;
  email: string;
  workspaceSlug: string | null;
}

export function Topbar({ displayName, email, workspaceSlug }: TopbarProps) {
  return (
    <header className="flex h-[48px] shrink-0 items-center border-b border-border px-4">
      <div className="flex items-baseline gap-2">
        <strong className="whitespace-nowrap text-[13.5px] font-semibold tracking-tight">
          FRC Web Simulator
        </strong>
      </div>
      <div className="ml-auto flex items-center gap-2.5">
        <UserMenu
          displayName={displayName}
          email={email}
          workspaceSlug={workspaceSlug}
        />
      </div>
    </header>
  );
}
