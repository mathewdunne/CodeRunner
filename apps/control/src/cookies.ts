import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionId } from "@frc-sim/contracts";
import { sessionIdSchema } from "@frc-sim/contracts";

export const SESSION_COOKIE_NAME = "frc_session";

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function signSessionId(sessionId: SessionId, secret: string): string {
  return base64Url(createHmac("sha256", secret).update(sessionId).digest());
}

export function serializeSessionCookie(sessionId: SessionId, secret: string, expiresAt: Date): string {
  const value = `${sessionId}.${signSessionId(sessionId, secret)}`;
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ].join("; ");
}

export function serializeExpiredSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}

export function parseCookies(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName || rawValue.length === 0) {
      continue;
    }
    cookies.set(rawName, rawValue.join("="));
  }

  return cookies;
}

export function parseSignedSessionCookie(cookieHeader: string | null, secret: string): SessionId | null {
  const value = parseCookies(cookieHeader).get(SESSION_COOKIE_NAME);
  if (!value) {
    return null;
  }

  const [sessionId, signature, ...extra] = value.split(".");
  if (!sessionId || !signature || extra.length > 0) {
    return null;
  }

  const parsedSessionId = sessionIdSchema.safeParse(sessionId);
  if (!parsedSessionId.success) {
    return null;
  }

  const expected = signSessionId(parsedSessionId.data, secret);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(signature);
  if (expectedBytes.length !== actualBytes.length) {
    return null;
  }

  if (!timingSafeEqual(expectedBytes, actualBytes)) {
    return null;
  }

  return parsedSessionId.data;
}
