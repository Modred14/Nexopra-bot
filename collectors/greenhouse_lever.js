// ─────────────────────────────────────────────────────────────────────────────
// collectors/greenhouse.js — Greenhouse Public Job Board Collector (Priority 3)
// ─────────────────────────────────────────────────────────────────────────────
import { simpleFetch } from "../utils/playwright.js";
import { normalizeOpportunity } from "../core/schema.js";
import { log, recordFound, recordFailed } from "../core/metrics.js";

const SOURCE = "Greenhouse";

// Curated list of well-known tech companies using Greenhouse
const GREENHOUSE_COMPANIES = [
  "stripe", "figma", "linear", "vercel", "supabase",
  "notion", "loom", "mercury", "ramp", "brex",
  "retool", "airtable", "gusto", "lattice", "checkr",
];

/**
 * Fetch jobs from Greenhouse's public API for curated companies.
 * @param {string} field — space-separated keywords to filter
 */
export async function collectGreenhouse(field = "") {
  const keywords = fieldToKeywords(field);
  const allJobs = [];

  // Sample a subset of companies per run to stay fast
  const companies = shuffle(GREENHOUSE_COMPANIES).slice(0, 5);

  for (const company of companies) {
    try {
      const url = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs?content=true`;
      const res = await simpleFetch(url, { source: LEVER_SOURCE, timeout: 20000 });
      if (!res || !res.ok) continue;

      const data = await res.json();
      if (!data.jobs) continue;

      const matched = data.jobs
        .filter((job) => matchesKeywords(job, keywords))
        .slice(0, 3);

      for (const job of matched) {
        allJobs.push(normalizeOpportunity({
          title: job.title,
          company: capitalize(company),
          type: isInternship(job.title) ? "Internship" : "Job",
          remote: isRemote(job),
          location: job.location?.name || null,
          source: SOURCE,
          sourceUrl: job.absolute_url || `https://boards.greenhouse.io/${company}`,
          description: stripHtml(job.content || "").slice(0, 300) || null,
          skills: extractDepartment(job),
          postedAt: job.updated_at || null,
        }));
      }
    } catch (err) {
      recordFailed(SOURCE);
      log("warn", SOURCE, `Failed for ${company}: ${err.message}`);
    }
  }

  recordFound(SOURCE, allJobs.length);
  log("info", SOURCE, `Collected ${allJobs.length} Greenhouse jobs`);
  return allJobs;
}

// ─────────────────────────────────────────────────────────────────────────────
// collectors/lever.js — Lever Public Job Board Collector (Priority 4)
// ─────────────────────────────────────────────────────────────────────────────
const LEVER_SOURCE = "Lever";

const LEVER_COMPANIES = [
  "netflix", "scale-ai", "openai", "anthropic", "databricks",
  "huggingface", "cohere", "mistral", "perplexity", "runway",
  "replit", "cursor", "codeium", "anyscale", "modal",
];

/**
 * Fetch jobs from Lever's public API for curated companies.
 */
export async function collectLever(field = "") {
  const keywords = fieldToKeywords(field);
  const allJobs = [];

  const companies = shuffle(LEVER_COMPANIES).slice(0, 5);

  for (const company of companies) {
    try {
      const url = `https://api.lever.co/v0/postings/${company}?mode=json`;
      const res = await simpleFetch(url, { source: LEVER_SOURCE });
      if (!res || !res.ok) continue;

      const jobs = await res.json();
      if (!Array.isArray(jobs)) continue;

      const matched = jobs
        .filter((job) => matchesKeywords(job, keywords))
        .slice(0, 3);

      for (const job of matched) {
        allJobs.push(normalizeOpportunity({
          title: job.text,
          company: capitalize(company),
          type: isInternship(job.text) ? "Internship" : "Job",
          remote: job.workplaceType === "remote" || isRemoteLever(job),
          location: job.categories?.location || null,
          source: LEVER_SOURCE,
          sourceUrl: job.hostedUrl || `https://jobs.lever.co/${company}`,
          description: stripHtml(job.descriptionPlain || "").slice(0, 300) || null,
          skills: [job.categories?.team, job.categories?.commitment].filter(Boolean),
          postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
        }));
      }
    } catch (err) {
      recordFailed(LEVER_SOURCE);
      log("warn", LEVER_SOURCE, `Failed for ${company}: ${err.message}`);
    }
  }

  recordFound(LEVER_SOURCE, allJobs.length);
  log("info", LEVER_SOURCE, `Collected ${allJobs.length} Lever jobs`);
  return allJobs;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function fieldToKeywords(field) {
  return field
    .toLowerCase()
    .split(",")
    .map((f) =>
      f
        .trim()
        .replace("frontend dev", "frontend")
        .replace("backend dev", "backend")
        .replace("full stack dev", "fullstack full-stack")
        .replace("data science / ai", "data machine learning ai")
        .replace("devops / cloud", "devops cloud infrastructure")
        .replace("blockchain / web3", "blockchain web3 solidity")
        .replace("mobile dev", "mobile ios android")
        .replace("ui/ux design", "design ui ux")
        .replace("product management", "product manager")
        .replace("cybersecurity", "security")
    )
    .join(" ")
    .split(" ")
    .filter(Boolean);
}

function matchesKeywords(job, keywords) {
  if (!keywords.length) return true;
  const haystack = `${job.title || job.text || ""} ${JSON.stringify(job.categories || {})}`.toLowerCase();
  return keywords.some((kw) => haystack.includes(kw));
}

function isInternship(title = "") {
  return /intern|internship/i.test(title);
}

function isRemote(job) {
  return /remote/i.test(job.location?.name || "");
}

function isRemoteLever(job) {
  return /remote/i.test(JSON.stringify(job.categories || {}));
}

function extractDepartment(job) {
  return [job.departments?.[0]?.name].filter(Boolean);
}

  function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")     // remove HTML tags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")         // collapse whitespace
    .trim();
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}
