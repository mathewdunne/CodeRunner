import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { WorkspaceLayout } from "@/routes/WorkspaceLayout";
import { WorkspacePage } from "@/routes/WorkspacePage";

const router = createBrowserRouter([
  {
    path: "/u/:slug",
    element: <WorkspaceLayout />,
    children: [
      {
        index: true,
        element: <WorkspacePage />,
      },
    ],
  },
  {
    path: "*",
    element: <FallbackRedirect />,
  },
]);

/**
 * Fallback route: extract workspace slug from the current URL (the proxy
 * always places us under /u/<slug>/) and redirect into the router. If no
 * slug is found, render a simple error.
 */
function FallbackRedirect() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const slug = parts[0] === "u" ? parts[1] : undefined;
  if (slug) {
    return <Navigate to={`/u/${slug}`} replace />;
  }
  return (
    <div className="flex h-screen items-center justify-center text-muted-foreground">
      No workspace found in URL.
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}

