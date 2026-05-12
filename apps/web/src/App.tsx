import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { WorkspaceLayout } from "@/routes/WorkspaceLayout";
import { WorkspacePage } from "@/routes/WorkspacePage";
import { LoginPage } from "@/routes/LoginPage";
import { AdminApp } from "@/admin/AdminApp";

const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/admin/*",
    element: <AdminApp />,
  },
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

function FallbackRedirect() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const slug = parts[0] === "u" ? parts[1] : undefined;
  if (slug) {
    return <Navigate to={`/u/${slug}`} replace />;
  }
  return <Navigate to="/login" replace />;
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
