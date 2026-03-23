import { expect } from "vitest";

export const expectSessionCookieCleared = (setCookieHeader: string | null, cookieName = "mc_session") => {
  expect(setCookieHeader).not.toBeNull();

  const setCookie = setCookieHeader ?? "";
  expect(setCookie).toContain(`${cookieName}=;`);
  expect(setCookie).toContain("Max-Age=0");
  expect(setCookie).toContain("Path=/");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toMatch(/SameSite=lax/i);
};
