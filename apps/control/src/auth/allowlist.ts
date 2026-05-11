/**
 * Email allowlist — load and validate an allowlist of emails and domains.
 *
 * File location: data/allowlist.json (gitignored).
 * Schema: { "emails": ["a@b.com"], "domains": ["b.com"] }
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

function normalizeEntry(kind: "email" | "domain", value: string): string {
  const normalized = normalize(value);
  if (!normalized) {
    throw new Error("Allowlist value is required.");
  }

  if (kind === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
      throw new Error("Allowlist email must be a valid email address.");
    }
    return normalized;
  }

  const domain = normalized.startsWith("@") ? normalized.slice(1) : normalized;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(domain)) {
    throw new Error("Allowlist domain must be a valid domain, e.g. frcteam.org.");
  }
  return domain;
}

export function setAllowlistPath(dataDir: string): void {
  allowlistPath = resolve(dataDir, "allowlist.json");
}

export async function loadAllowlist(): Promise<AllowlistData> {
  if (!allowlistPath) return EMPTY;
  let raw: string;
  try {
    raw = await readFile(allowlistPath, "utf8");
  } catch (error) {
    // First-boot bootstrap: missing file is normal, fall back to empty.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      cached = EMPTY;
      return cached;
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as Partial<AllowlistData>;
  cached = {
    emails: (parsed.emails ?? []).map((entry) => normalizeEntry("email", entry)),
    domains: (parsed.domains ?? []).map((entry) => normalizeEntry("domain", entry)),
  };
  return cached;
}

export function reloadAllowlist(): Promise<AllowlistData> {
  return loadAllowlist();
}

export function getAllowlist(): AllowlistData {
  return cached;
}

export function isEmailAllowed(email: string): boolean {
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
    emails: [...new Set(data.emails.map((entry) => normalizeEntry("email", entry)))].sort(),
    domains: [...new Set(data.domains.map((entry) => normalizeEntry("domain", entry)))].sort(),
  };
  await mkdir(dirname(allowlistPath), { recursive: true });
  const tempPath = `${allowlistPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  await rename(tempPath, allowlistPath);
  cached = sorted;
}

export async function addAllowlistEntry(kind: "email" | "domain", value: string): Promise<AllowlistData> {
  const current = { ...cached, emails: [...cached.emails], domains: [...cached.domains] };
  const normalized = normalizeEntry(kind, value);
  const list = kind === "email" ? current.emails : current.domains;
  if (!list.includes(normalized)) {
    list.push(normalized);
  }
  await saveAllowlist(current);
  return current;
}

export async function removeAllowlistEntry(kind: "email" | "domain", value: string): Promise<AllowlistData> {
  const current = { ...cached, emails: [...cached.emails], domains: [...cached.domains] };
  const normalized = normalizeEntry(kind, value);
  if (kind === "email") {
    current.emails = current.emails.filter((e) => e !== normalized);
  } else {
    current.domains = current.domains.filter((d) => d !== normalized);
  }
  await saveAllowlist(current);
  return current;
}
