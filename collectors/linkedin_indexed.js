// ─────────────────────────────────────────────────────────────────────────────
// collectors/linkedin_indexed.js — LinkedIn via Google Indexed Search (Priority 6)
// No login. No LinkedIn scraping. Google-indexed public pages only.
// ─────────────────────────────────────────────────────────────────────────────
import { playwrightFetch } from "../utils/playwright.js";
import { normalizeOpportunity } from "../core/schema.js";
import { log, recordFound, recordFailed } from "../core/metrics.js";

const SOURCE = "LinkedIn (Google)";

/**
 * Build Google search queries for LinkedIn job posts.
 * Uses site:linkedin.com/jobs — public Google index only.
 */
function buildQueries(user) {
  const fields = user.field.split(",").map((f) => f.trim()).slice(0, 2);
  const region = user.region || "remote";
  const remote = user.remote ?? true;

  const queries = [];

  for (const field of fields) {
    // Jobs
    queries.push(`site:linkedin.com/jobs "${field}" "${region}"`);
    if (remote) queries.push(`site:linkedin.com/jobs "${field}" "remote"`);

    // Internships
    queries.push(`site:linkedin.com/jobs "${field}" intern "${region}"`);

    // Opportunity posts (hiring posts, hackathon announcements)
    queries.push(`site:linkedin.com/posts "${field}" "we are hiring"`);
    queries.push(`site:linkedin.com/posts hackathon internship "${field}"`);
  }

  return queries.slice(0, 4); // cap to avoid rate limits
}

/**
 * Perform a single Google search and extract result URLs + metadata.
 * Uses Playwright to render the Google results page.
 */
async function googleSearch(query) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=8`;
  const result = await playwrightFetch(url, {
    source: SOURCE,
    timeout: 15000,
    delayMin: 2000,
    delayMax: 5000,
  });
  if (!result) return [];

  return parseGoogleResults(result.html, query);
}

function parseGoogleResults(html, query) {
  const results = [];
  // Match Google result entries: <h3>title</h3> near an <a href="...">
  const entryPattern = /<a[^>]+href="(https?:\/\/(?:www\.)?linkedin\.com\/(?:jobs|posts)\/[^"&]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;

  let match;
  while ((match = entryPattern.exec(html)) !== null && results.length < 5) {
    const url = match[1].split("&")[0]; // strip Google tracking params
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    if (!title || title.length < 4) continue;

    const isPost = url.includes("/posts/");
    const isInternship = /intern/i.test(title + query);
    const isHackathon = /hackathon/i.test(title + query);

    results.push(
      normalizeOpportunity({
        title,
        type: isHackathon ? "Hackathon" : isInternship ? "Internship" : "Job",
        remote: /remote/i.test(title + query),
        source: SOURCE,
        sourceUrl: url,
        description: isPost
          ? "LinkedIn post — may contain hiring or opportunity announcement."
          : "LinkedIn job listing.",
      })
    );
  }

  return results;
}

/**
 * Main collector: run multiple Google-indexed LinkedIn queries.
 */
export async function collectLinkedInIndexed(user) {
  const queries = buildQueries(user);
  const allResults = [];

  for (const query of queries) {
    try {
      const results = await googleSearch(query);
      allResults.push(...results);
      // Polite delay between Google queries
      await sleep(3000 + Math.random() * 2000);
    } catch (err) {
      recordFailed(SOURCE);
      log("warn", SOURCE, `Query failed: "${query}" — ${err.message}`);
    }
  }

  // Deduplicate by URL within this batch
  const seen = new Set();
  const deduped = allResults.filter((opp) => {
    if (seen.has(opp.sourceUrl)) return false;
    seen.add(opp.sourceUrl);
    return true;
  });

  recordFound(SOURCE, deduped.length);
  log("info", SOURCE, `Collected ${deduped.length} LinkedIn indexed results`);
  return deduped;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
