// ─────────────────────────────────────────────────────────────────────────────
// collectors/devpost.js — Devpost Hackathon Collector (Priority 1)
// ─────────────────────────────────────────────────────────────────────────────
import { simpleFetch } from "../utils/playwright.js";
import { normalizeOpportunity } from "../core/schema.js";
import { log, recordFound, recordFailed } from "../core/metrics.js";

const SOURCE = "Devpost";

/**
 * Fetch upcoming hackathons from Devpost public API.
 * @param {string} field — user field for relevance search
 * @returns {NormalizedOpportunity[]}
 */
export async function collectDevpost(field = "") {
  try {
    const query = encodeURIComponent(field.split(",")[0].trim());
    const url = `https://devpost.com/api/hackathons?search=${query}&status=upcoming&order_by=deadline&per_page=15`;
    const res = await simpleFetch(url, { source: SOURCE });
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status}`);

    const data = await res.json();
    if (!data.hackathons || !Array.isArray(data.hackathons)) return [];

    const today = new Date();
    const results = [];

    for (const h of data.hackathons) {
      // Parse deadline
      const parts = h.submission_period_dates?.split(" - ") || [];
      const deadlineRaw = parts[parts.length - 1] || null;
      let deadline = null;
      if (deadlineRaw) {
        const d = new Date(deadlineRaw);
        if (!isNaN(d) && d > today) {
          deadline = d.toLocaleDateString("en-US", {
            month: "long",
            day: "2-digit",
            year: "numeric",
          });
        } else if (isNaN(d)) {
          deadline = deadlineRaw; // keep raw string
        } else {
          continue; // skip past deadlines
        }
      }

      let prize = null;
      if (h.prize_amount && h.prize_amount > 0) {
        prize = `$${Number(h.prize_amount).toLocaleString()}`;
      }

      results.push(
        normalizeOpportunity({
          title: h.title,
          company: h.organization_name || null,
          type: "Hackathon",
          remote:
            h.online_only === true ||
            h.displayed_location?.location === "Online",
          location: h.displayed_location?.location || null,
          source: SOURCE,
          sourceUrl: h.url || "https://devpost.com/hackathons",
          description: h.tagline || null,
          skills: extractTags(h.themes || []),
          deadline,
          prize,
          postedAt: h.submission_period_dates || null,
        }),
      );
    }

    recordFound(SOURCE, results.length);
    log("info", SOURCE, `Collected ${results.length} hackathons`);
    return results;
  } catch (err) {
    recordFailed(SOURCE);
    log("error", SOURCE, `Collection failed: ${err.message}`);
    return [];
  }
}

function extractTags(themes) {
  if (!Array.isArray(themes)) return [];
  return themes
    .map((t) => t.name || t)
    .filter(Boolean)
    .slice(0, 5);
}
