/**
 * Email allowlist — load and validate an allowlist of emails and domains.
 *
 * File location: data/allowlist.json (gitignored).
 * Schema: { "emails": ["a@b.com"], "domains": ["b.com"] }
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type AllowlistData = {
  emails: string[];
  domains: string[];
};

const EMPTY: AllowlistData = { emails: [], domains: [] };

let cached: AllowlistData = EMPTY;
let allowlistPath = "";

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export function setAllowlistPath(dataDir: string): void {
  allowlistPath = resolve(dataDir, "allowlist.json");
}

export async function loadAllowlist(): Promise<AllowlistData> {
  if (!allowlistPath) return EMPTY;
  try {
    const raw = await readFile(allowlistPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AllowlistData>;
    cached = {
      emails: (parsed.emails ?? []).map(normalize),
      domains: (parsed.domains ?? []).map(normalize),
    };
  } catch {
    // File missing or invalid — treat as empty allowlist (blocks everyone).
    cached = EMPTY;
  }
  return cached;
}

export function reloadAllowlist(): Promise<AllowlistData> {
  return loadAllowlist();
}

export function getAllowlist(): AllowlistData {
  return cached;
}

export function isEmailAllowed(email: string): boolean {
  // If no allowlist is configured (both lists empty), allow everyone (dev mode).
  if (cached.emails.length === 0 && cached.domains.length === 0) {
    return true;
  }

  const normalizedEmail = normalize(email);
  if (cached.emails.includes(normalizedEmail)) {
    return true;
  }

  const domain = normalizedEmail.split("@")[1];
  if (domain && cached.domains.includes(domain)) {
    return true;
  }

  return false;
}

export async function saveAllowlist(data: AllowlistData): Promise<void> {
  if (!allowlistPath) throw new Error("Allowlist path not set");
  const sorted: AllowlistData = {
    emails: [...data.emails].sort(),
    domains: [...data.domains].sort(),
  };
  await writeFile(allowlistPath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  cached = sorted;
}

export async function addAllowlistEntry(kind: "email" | "domain", value: string): Promise<AllowlistData> {
  const current = { ...cached, emails: [...cached.emails], domains: [...cached.domains] };
  const normalized = normalize(value);
  const list = kind === "email" ? current.emails : current.domains;
  if (!list.includes(normalized)) {
    list.push(normalized);
  }
  await saveAllowlist(current);
  return current;
}

export async function removeAllowlistEntry(kind: "email" | "domain", value: string): Promise<AllowlistData> {
  const current = { ...cached, emails: [...cached.emails], domains: [...cached.domains] };
  const normalized = normalize(value);
  if (kind === "email") {
    current.emails = current.emails.filter((e) => e !== normalized);
  } else {
    current.domains = current.domains.filter((d) => d !== normalized);
  }
  await saveAllowlist(current);
  return current;
}
