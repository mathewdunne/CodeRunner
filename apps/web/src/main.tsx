import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isWorkspaceSlug } from "@frc-sim/contracts";
import "./style.css";

function App() {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const slug = pathParts[0] === "u" ? pathParts[1] : undefined;
  const workspaceLabel = slug && isWorkspaceSlug(slug) ? slug : "not selected";

  return (
    <main className="app">
      <header>
        <p className="eyebrow">V1 scaffold</p>
        <h1>FRC Web Simulator</h1>
      </header>
      <section className="workspace">
        <span>Workspace</span>
        <strong>{workspaceLabel}</strong>
      </section>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
