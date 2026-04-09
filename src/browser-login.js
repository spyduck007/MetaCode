import { hasLoggedInMetaSession, selectMetaCookies, serializeCookieHeader } from "./login-utils.js";

const POLL_INTERVAL_MS = 1200;

async function launchPlayableBrowser(chromium, headless) {
  try {
    return await chromium.launch({ headless, channel: "chrome" });
  } catch {
    try {
      return await chromium.launch({ headless });
    } catch (error) {
      throw new Error(
        `Unable to launch browser. Install browser runtime with "npx playwright install chromium". ${error.message}`
      );
    }
  }
}

async function getMetaCookies(context) {
  return context.cookies(["https://www.meta.ai", "https://meta.ai"]);
}

export async function loginWithBrowser({
  timeoutMs = 5 * 60 * 1000,
  headless = false,
  onStatus,
} = {}) {
  const { chromium } = await import("playwright");
  const browser = await launchPlayableBrowser(chromium, headless);
  const context = await browser.newContext();
  const page = await context.newPage();

  onStatus?.("Opening Meta login page in controlled browser...");
  await page.goto("https://www.meta.ai/api/oidc/start", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  onStatus?.("Complete login in the opened browser window. Waiting for session cookie...");

  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < timeoutMs) {
      const rawCookies = await getMetaCookies(context);
      const metaCookies = selectMetaCookies(rawCookies);

      if (hasLoggedInMetaSession(metaCookies)) {
        const cookieHeader = serializeCookieHeader(metaCookies);
        onStatus?.("Meta session detected. Saving cookies to CLI config...");
        return {
          cookieHeader,
          cookies: metaCookies,
        };
      }

      if (page.isClosed()) {
        throw new Error("Login browser was closed before session cookies were captured.");
      }

      await page.waitForTimeout(POLL_INTERVAL_MS);
    }

    throw new Error("Timed out waiting for Meta login to complete.");
  } finally {
    await browser.close();
  }
}

