import { useState } from "react";
import { AdminLayout, type Tab } from "./AdminLayout";
import { Dashboard } from "./pages/Dashboard";
import { Users } from "./pages/Users";
import { Allowlist } from "./pages/Allowlist";

export function AdminApp() {
  const [tab, setTab] = useState<Tab>("dashboard");

  return (
    <AdminLayout activeTab={tab} onTabChange={setTab}>
      {tab === "dashboard" && <Dashboard />}
      {tab === "users" && <Users />}
      {tab === "allowlist" && <Allowlist />}
    </AdminLayout>
  );
}
