// ─────────────────────────────────────────────────────────────────────────────
// collectors/nitter.js — Nitter/X Monitoring for Curated Accounts (Priority 7)
// Monitors curated tech/hiring accounts. NO global tweet scraping.
// ─────────────────────────────────────────────────────────────────────────────
import { simpleFetch, playwrightFetch } from "../utils/playwright.js";
import { normalizeOpportunity } from "../core/schema.js";
import { log, recordFound, recordFailed } from "../core/metrics.js";

const SOURCE = "X/Twitter";

// ─── Curated accounts to monitor ─────────────────────────────────────────────
// Edit this list to add/remove signal sources.
export const MONITORED_ACCOUNTS = [
  "ycombinator", // YC jobs, startups
  "hackathonhacks", // hackathon aggregator
  "github", // GitHub Octernships, programs
  "vercel", // Vercel hiring
  "netlify", // Netlify hiring
  "mlhacks", // MLH hackathons
  "producthunt", // startup launches, hiring
  "levelsio", // remote jobs, indie hacking
  "buildspace", // programs & fellowships
  "devpost", // hackathon announcements
  "techstars", // accelerator programs
  "googledevs", // Google programs
];

// ─── Nitter instances (use first available) ───────────────────────────────────
const NITTER_INSTANCES = [
  "https://nitter.privacydev.net",
  "https://nitter.poast.org",
  "https://nitter.1d4.us",
  "https://nitter.kavin.rocks",
  "https://nitter.unixfox.eu",
];

// ─── Keywords that signal an opportunity post ─────────────────────────────────
const OPPORTUNITY_SIGNALS = {
  Hackathon: ["hackathon", "hack the", "build-a-thon", "hacking", "hackfest"],
  Internship: [
    "internship",
    "intern applications",
    "summer intern",
    "intern cohort",
  ],
  Job: [
    "we're hiring",
    "we are hiring",
    "job opening",
    "job opportunity",
    "apply now",
    "join our team",
    "open role",
  ],
  Grant: ["grant", "funding", "apply for funding", "grant applications"],
  Fellowship: ["fellowship", "fellows program", "apply to be a fellow"],
  Program: ["program", "cohort", "applications open", "residency", "bootcamp"],
};

/**
 * Detect opportunity type from post text.
 */
function detectOpportunityType(text) {
  const lower = text.toLowerCase();
  for (const [type, signals] of Object.entries(OPPORTUNITY_SIGNALS)) {
    if (signals.some((s) => lower.includes(s))) return type;
  }
  return null; // not an opportunity post
}

/**
 * Extract links from post text.
 */
function extractLink(text) {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

/**
 * Scrape a single Nitter profile page.
 */
async function scrapeNitterProfile(account, instance) {
  // Try RSS first — much more stable than HTML scraping
  const rssUrl = `${instance}/${account}/rss`;
  const result = await simpleFetch(rssUrl, { source: SOURCE, timeout: 10000 });

  if (result && result.ok) {
    const xml = await result.text();
    return parseRSS(xml, account);
  }
  return [];
}

function parseRSS(xml, account) {
  const posts = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1];

    const titleMatch = block.match(
      /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/,
    );
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const dateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);

    const text = titleMatch?.[1]?.trim() || "";
    if (!text) continue;

    const type = detectOpportunityType(text);
    if (!type) continue;

    posts.push(
      normalizeOpportunity({
        title: text.slice(0, 100),
        company: `@${account}`,
        type,
        remote: /remote/i.test(text),
        source: SOURCE,
        sourceUrl: linkMatch?.[1]?.trim() || `https://twitter.com/${account}`,
        description: text,
        postedAt: dateMatch?.[1]?.trim() || null,
      }),
    );
  }

  return posts;
}
function parseNitterPosts(html, account) {
  const posts = [];

  // Extract tweet items
  const itemPattern =
    /<div class="timeline-item[^"]*">([\s\S]*?)<\/div>\s*(?=<div class="timeline-item|$)/gi;
  let match;

  while ((match = itemPattern.exec(html)) !== null) {
    const block = match[1];

    // Extract text content
    const textMatch = block.match(
      /<div class="tweet-content[^"]*">([\s\S]*?)<\/div>/i,
    );
    if (!textMatch) continue;
    const text = textMatch[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const type = detectOpportunityType(text);
    if (!type) continue; // skip non-opportunity posts

    // Extract timestamp
    const timeMatch = block.match(/datetime="([^"]+)"/);
    const timestamp = timeMatch ? timeMatch[1] : null;

    // Extract post link
    const linkMatch = block.match(/href="\/[^/]+\/status\/(\d+)"/);
    const postUrl = linkMatch
      ? `https://twitter.com/${account}/status/${linkMatch[1]}`
      : `https://twitter.com/${account}`;

    const externalLink = extractLink(text);

    posts.push(
      normalizeOpportunity({
        title: text.slice(0, 100),
        company: `@${account}`,
        type,
        remote: /remote/i.test(text),
        source: SOURCE,
        sourceUrl: externalLink || postUrl,
        description: text,
        postedAt: timestamp,
      }),
    );
  }

  return posts;
}

/**
 * Try all Nitter instances for an account, return first success.
 */
async function scrapeWithFallback(account) {
  for (const instance of NITTER_INSTANCES) {
    try {
      const results = await scrapeNitterProfile(account, instance);
      if (results.length > 0) return results;
    } catch (err) {
      log(
        "warn",
        SOURCE,
        `Instance ${instance} failed for @${account}: ${err.message}`,
      );
    }
  }
  return [];
}

/**
 * Main collector: monitor all curated accounts.
 * @param {string[]} [accounts] — override the default list
 */
export async function collectNitter(accounts = MONITORED_ACCOUNTS) {
  const allPosts = [];

  for (const account of accounts) {
    try {
      const posts = await scrapeWithFallback(account);
      allPosts.push(...posts);
      await sleep(2000 + Math.random() * 2000);
    } catch (err) {
      log("warn", SOURCE, `Failed for @${account}: ${err.message}`);
    }
  }
  if (allPosts.length === 0) {
    log(
      "warn",
      SOURCE,
      "All Nitter instances down — skipping X monitoring this run",
    );
    return [];
  }
  recordFound(SOURCE, allPosts.length);
  log("info", SOURCE, `Collected ${allPosts.length} opportunity posts from X`);
  return allPosts;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
