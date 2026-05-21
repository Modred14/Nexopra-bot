// ─────────────────────────────────────────────────────────────────────────────
// collectors/wellfound.js — Wellfound (AngelList) Startup Jobs (Priority 5)
// Uses Playwright since Wellfound is React-rendered.
// ─────────────────────────────────────────────────────────────────────────────
import { playwrightFetch } from "../utils/playwright.js";
import { normalizeOpportunity } from "../core/schema.js";
import { log, recordFound, recordFailed } from "../core/metrics.js";

const SOURCE = "Wellfound";

const ROLE_MAP = {
  "Frontend Dev":       "engineer",
  "Backend Dev":        "engineer",
  "Full Stack Dev":     "engineer",
  "UI/UX Design":       "designer",
  "Mobile Dev":         "engineer",
  "Data Science / AI":  "data-scientist",
  "Cybersecurity":      "engineer",
  "DevOps / Cloud":     "devops",
  "Product Management": "product-manager",
  "Blockchain / Web3":  "engineer",
};

export async function collectWellfound(field = "") {
  try {
    const primaryField = field.split(",")[0].trim();
    const role = ROLE_MAP[primaryField] || "engineer";
    const url = `https://wellfound.com/role/r/${role}`;

    const result = await playwrightFetch(url, {
      source: SOURCE,
      timeout: 20000,
      waitFor: "[data-test='StartupResult']",
    });
    if (!result) throw new Error("Playwright returned null");

    const jobs = parseWellfound(result.html, field);
    recordFound(SOURCE, jobs.length);
    log("info", SOURCE, `Collected ${jobs.length} Wellfound jobs`);
    return jobs;
  } catch (err) {
    recordFailed(SOURCE);
    log("error", SOURCE, `Collection failed: ${err.message}`);
    return [];
  }
}

function parseWellfound(html, field) {
  const results = [];
  const keywords = field.toLowerCase().split(",").map((f) => f.trim().split(" ")[0]);

  // Extract Next.js page data
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const jobListings =
        data?.props?.pageProps?.jobListings ||
        data?.props?.pageProps?.startupRoles ||
        [];

      for (const listing of jobListings.slice(0, 8)) {
        results.push(
          normalizeOpportunity({
            title: listing.title || listing.role,
            company: listing.startup?.name || listing.company?.name || null,
            type: isInternship(listing.title) ? "Internship" : "Job",
            remote: listing.remote || listing.locationTypes?.includes("remote"),
            location: listing.location || null,
            source: SOURCE,
            sourceUrl: listing.url || listing.absoluteUrl || `https://wellfound.com`,
            description: listing.description?.slice(0, 300) || null,
            skills: listing.skills?.map((s) => s.name || s) || [],
            salary: formatSalary(listing),
          })
        );
      }
      return results;
    } catch {
      // fall through to regex
    }
  }

  // Regex fallback
  const jobPattern = /<a[^>]+href="(https?:\/\/wellfound\.com\/jobs\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = jobPattern.exec(html)) !== null && results.length < 6) {
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    if (title.length < 4) continue;
    results.push(
      normalizeOpportunity({
        title,
        type: isInternship(title) ? "Internship" : "Job",
        remote: /remote/i.test(title),
        source: SOURCE,
        sourceUrl: match[1],
      })
    );
  }

  return results;
}

function isInternship(title = "") {
  return /intern|internship/i.test(title);
}

function formatSalary(listing) {
  if (listing.salary) return listing.salary;
  if (listing.minSalary && listing.maxSalary) {
    return `$${Number(listing.minSalary).toLocaleString()} – $${Number(listing.maxSalary).toLocaleString()}`;
  }
  return null;
}
