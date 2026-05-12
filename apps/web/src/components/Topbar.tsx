import { UserMenu } from "@/components/UserMenu";
import coderunnerHeaderImg from "@/assets/coderunner-header.png";

interface TopbarProps {
  displayName: string;
  email: string;
  isAdmin: boolean;
  workspaceSlug: string | null;
}

export function Topbar({
  displayName,
  email,
  isAdmin,
  workspaceSlug,
}: TopbarProps) {
  return (
    <header className="flex h-[48px] shrink-0 items-center border-b border-border px-4">
      <div className="flex items-center gap-2.5">
        <img src={coderunnerHeaderImg} alt="" className="h-6 w-auto" />
        <strong className="whitespace-nowrap text-[13.5px] font-semibold tracking-tight">
          CodeRunner
        </strong>
      </div>
      <div className="ml-auto flex items-center gap-2.5">
        <UserMenu
          displayName={displayName}
          email={email}
          isAdmin={isAdmin}
          workspaceSlug={workspaceSlug}
        />
      </div>
    </header>
  );
}
