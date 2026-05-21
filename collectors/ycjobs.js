// ─────────────────────────────────────────────────────────────────────────────
// collectors/ycjobs.js — YC Jobs Collector (Priority 2)
// ─────────────────────────────────────────────────────────────────────────────
import { playwrightFetch } from "../utils/playwright.js";
import { normalizeOpportunity } from "../core/schema.js";
import { log, recordFound, recordFailed } from "../core/metrics.js";

const SOURCE = "YC Jobs";
const BASE_URL = "https://www.ycombinator.com/jobs";

/**
 * Scrape YC Jobs for startup jobs & internships.
 * Uses Playwright since the page is React-rendered.
 */
export async function collectYCJobs(field = "") {
  try {
    const result = await playwrightFetch(BASE_URL, {
      source: SOURCE,
      waitFor: '[class*="JobsList"]',
      timeout: 20000,
    });
    if (!result) throw new Error("Playwright returned null");

    const { html } = result;
    const jobs = parseYCJobsHTML(html, field);

    recordFound(SOURCE, jobs.length);
    log("info", SOURCE, `Collected ${jobs.length} YC jobs`);
    return jobs;
  } catch (err) {
    recordFailed(SOURCE);
    log("error", SOURCE, `Collection failed: ${err.message}`);
    return [];
  }
}

function parseYCJobsHTML(html, field) {
  // Extract JSON data embedded in page (YC often embeds window.__NEXT_DATA__)
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!nextDataMatch) return fallbackParse(html, field);

  try {
    const nextData = JSON.parse(nextDataMatch[1]);
    const jobs = nextData?.props?.pageProps?.jobs || [];
    const fieldKeywords = field.toLowerCase().split(",").map((f) => f.trim());

    return jobs
      .filter((job) => {
        if (!fieldKeywords.length) return true;
        const haystack = `${job.title} ${job.tags?.join(" ")} ${job.role}`.toLowerCase();
        return fieldKeywords.some((kw) => haystack.includes(kw.split(" ")[0].toLowerCase()));
      })
      .slice(0, 8)
      .map((job) =>
        normalizeOpportunity({
          title: job.title,
          company: job.company?.name || null,
          type: isInternship(job.title) ? "Internship" : "Job",
          remote: job.remote || false,
          location: job.location || null,
          source: SOURCE,
          sourceUrl: job.url || `https://www.ycombinator.com/jobs/${job.id}`,
          description: job.description || null,
          skills: job.tags || [],
          salary: job.salary || null,
        })
      );
  } catch {
    return fallbackParse(html, field);
  }
}

function fallbackParse(html, field) {
  // Simple regex fallback for job title + link extraction
  const results = [];
  const jobPattern = /<a[^>]+href="(\/jobs\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = jobPattern.exec(html)) !== null && results.length < 6) {
    const url = `https://www.ycombinator.com${match[1]}`;
    const rawTitle = match[2].replace(/<[^>]+>/g, "").trim();
    if (rawTitle.length < 3) continue;
    results.push(
      normalizeOpportunity({
        title: rawTitle,
        type: isInternship(rawTitle) ? "Internship" : "Job",
        source: SOURCE,
        sourceUrl: url,
        remote: rawTitle.toLowerCase().includes("remote"),
      })
    );
  }
  return results;
}

function isInternship(title = "") {
  return /intern|internship/i.test(title);
}
