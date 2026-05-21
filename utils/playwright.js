// ─────────────────────────────────────────────────────────────────────────────
// utils/playwright.js — Shared Playwright Browser Utility
// ─────────────────────────────────────────────────────────────────────────────
// Install: npm install playwright
// npx playwright install chromium
import { chromium } from "playwright";
import { log } from "../core/metrics.js";

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browser;
}

/**
 * Fetch a URL with Playwright.
 * Returns: { html, url } or null on failure.
 *
 * Options:
 *   retries     — number of retry attempts (default 2)
 *   timeout     — ms per attempt (default 15000)
 *   delayMin    — min anti-block delay ms (default 1000)
 *   delayMax    — max anti-block delay ms (default 3000)
 *   waitFor     — CSS selector to wait for before returning
 */
export async function playwrightFetch(url, options = {}) {
  const {
    retries = 2,
    timeout = 15000,
    delayMin = 1000,
    delayMax = 3000,
    waitFor = null,
    source = "playwright",
  } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let page = null;
    try {
      const b = await getBrowser();
      const context = await b.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        locale: "en-US",
        timezoneId: "America/New_York",
      });

      page = await context.newPage();

      // Anti-bot: randomize delay before request
      const delay = delayMin + Math.random() * (delayMax - delayMin);
      await sleep(delay);

      await page.goto(url, { timeout, waitUntil: "domcontentloaded" });

      if (waitFor) {
        await page.waitForSelector(waitFor, { timeout: 5000 }).catch(() => {});
      }

      const html = await page.content();
      const finalUrl = page.url();
      await context.close();

      return { html, url: finalUrl };
    } catch (err) {
      log("warn", source, `Attempt ${attempt + 1} failed: ${err.message}`);
      if (page) await page.close().catch(() => {});
      if (attempt < retries) await sleep(2000 * (attempt + 1));
    }
  }

  log("error", source, `All ${retries + 1} attempts failed for: ${url}`);
  return null;
}

/**
 * Fetch a URL with basic node-fetch (no JS rendering).
 * Faster, use for APIs and simple HTML pages.
 */
export async function simpleFetch(url, options = {}) {
  const { headers = {}, source = "simpleFetch", timeout = 20000 } = options;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Nexopra/1.0)",
        Accept: "application/json, text/html",
        ...headers,
      },
      signal: controller.signal,
    });
    clearTimeout(id);
    return res;
  } catch (err) {
    log("error", source, `simpleFetch failed for ${url}: ${err.message}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function closeBrowser() {
  if (browser) await browser.close();
  browser = null;
}
