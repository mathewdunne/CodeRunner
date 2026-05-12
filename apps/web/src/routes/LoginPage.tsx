import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { SiGithub, SiGoogle } from "react-icons/si";
import { authClient } from "@/lib/auth-client";
import { authProvidersResponseSchema, type AuthProvider } from "@/lib/contracts";
import { cn } from "@/lib/utils";
import coderunnerMascotImg from "@/assets/coderunner-mascot.png";

interface OAuthButtonProps {
  provider: "github" | "google";
  disabled: boolean;
  onClick: () => void;
}

function OAuthButton({ provider, disabled, onClick }: OAuthButtonProps) {
  const isGitHub = provider === "github";
  return (
    <div className="rounded-lg border border-border bg-card p-2">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "flex h-11 w-full items-center justify-center gap-3 rounded-md border px-4 text-[13px] font-semibold tracking-wide transition-all disabled:cursor-not-allowed disabled:opacity-45",
          isGitHub
            ? "border-border bg-white/[0.06] text-foreground hover:bg-white/[0.11] hover:shadow-[0_0_18px_rgba(34,197,94,0.12)]"
            : "border-border bg-white/[0.03] text-foreground hover:bg-white/[0.06]",
        )}
      >
        {isGitHub ? (
          <SiGithub className="size-[18px] shrink-0" />
        ) : (
          <SiGoogle className="size-[18px] shrink-0" />
        )}
        {isGitHub ? "Sign in with GitHub" : "Sign in with Google"}
      </button>
    </div>
  );
}

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState<AuthProvider[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);

  const rawError = searchParams.get("error");
  const friendlyError =
    rawError === "forbidden" || rawError?.toLowerCase().includes("roster")
      ? "You're not on the roster yet. Ask your coach to add you."
      : rawError?.replaceAll("_", " ") ?? null;
  const availableProviders = providers ?? [];

  useEffect(() => {
    const controller = new AbortController();

    async function loadProviders() {
      try {
        const response = await fetch("/api/auth/providers", {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Auth provider discovery failed with status ${response.status}`);
        }
        const parsed = authProvidersResponseSchema.parse(await response.json());
        setProviders(parsed.providers);
        setProvidersError(null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setProviders([]);
        setProvidersError("Sign-in is unavailable right now. Please refresh and try again.");
      }
    }

    void loadProviders();

    return () => {
      controller.abort();
    };
  }, []);

  async function signIn(provider: "github" | "google") {
    setLoading(true);
    setSignInError(null);
    try {
      await authClient.signIn.social({
        provider,
        callbackURL: "/",
        errorCallbackURL: "/login",
      });
    } catch (error) {
      setLoading(false);
      setSignInError(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Couldn't start sign-in. Please try again.",
      );
    }
  }

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

      {/* Right panel — sign in */}
      <div
        className="flex flex-1 flex-col items-center justify-center px-8"
      >
        <div className="w-full max-w-[320px]">
          {/* DS-style section label */}
          <p className="mb-6 text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Sign in to continue
          </p>

          {/* Error */}
          {friendlyError && (
            <div className="mb-5 rounded-md border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[12px] text-red-300">
              {friendlyError}
            </div>
          )}
          {providersError && (
            <div className="mb-5 rounded-md border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[12px] text-red-300">
              {providersError}
            </div>
          )}
          {signInError && (
            <div className="mb-5 rounded-md border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[12px] text-red-300">
              {signInError}
            </div>
          )}

          {/* Buttons */}
          <div className="flex flex-col gap-2">
            {providers === null ? (
              <div className="rounded-lg border border-border bg-card px-4 py-3 text-[12px] text-muted-foreground">
                Checking sign-in options...
              </div>
            ) : providersError ? null : availableProviders.length > 0 ? (
              availableProviders.map((provider) => (
                <OAuthButton
                  key={provider}
                  provider={provider}
                  disabled={loading}
                  onClick={() => signIn(provider)}
                />
              ))
            ) : (
              <div className="rounded-lg border border-border bg-card px-4 py-3 text-[12px] text-muted-foreground">
                Sign-in isn&apos;t configured yet. Ask your coach to enable a sign-in provider.
              </div>
            )}
          </div>

          {/* Fine print */}
          <p className="mt-6 text-[10.5px] leading-relaxed text-muted-foreground">
            Not on the roster?{" "}
            <span className="text-foreground/60">Ask your coach to add you.</span>
          </p>
        </div>
      </div>
    </div>
  );
}
