import { useEffect, useState } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { AdminApp } from "@/admin/AdminApp";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LoginPage } from "@/routes/LoginPage";
import { ServiceOfflinePage } from "@/routes/ServiceOfflinePage";
import { WorkspaceLayout } from "@/routes/WorkspaceLayout";
import { WorkspacePage } from "@/routes/WorkspacePage";

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
	const [health, setHealth] = useState<"checking" | "online" | "offline">(
		"checking",
	);

	useEffect(() => {
		if (health !== "checking") return;
		const controller = new AbortController();
		fetch("/healthz", { signal: controller.signal })
			.then((res) => setHealth(res.ok ? "online" : "offline"))
			.catch((err) => {
				if (err instanceof DOMException && err.name === "AbortError") return;
				setHealth("offline");
			});
		return () => controller.abort();
	}, [health]);

	if (health === "checking") return null;

	if (health === "offline") {
		return (
			<ThemeProvider defaultTheme="dark">
				<ServiceOfflinePage onRetry={() => setHealth("checking")} />
			</ThemeProvider>
		);
	}

	return (
		<ThemeProvider defaultTheme="dark">
			<TooltipProvider>
				<RouterProvider router={router} />
				<Toaster />
			</TooltipProvider>
		</ThemeProvider>
	);
}
