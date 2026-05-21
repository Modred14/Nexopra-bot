// ─────────────────────────────────────────────────────────────────────────────
// core/pipeline.js — Per-User Opportunity Pipeline
//
// This is called when a user requests opportunities (on-demand or scheduled).
// It pulls from the shared scheduler cache, applies user matching,
// and returns a curated, deduplicated list for that user.
// ─────────────────────────────────────────────────────────────────────────────
import { getCache } from "../scheduler/index.js";
import { matchOpportunitiesForUser } from "../ai/filter.js";
import { filterUnseenForUser } from "./dedup.js";
import { log } from "./metrics.js";
import { collectDevpost } from "../collectors/devpost.js";
import { collectYCJobs } from "../collectors/ycjobs.js";
import { collectGreenhouse } from "../collectors/greenhouse_lever.js";

/**
 * Get curated opportunities for a specific user.
 *
 * @param {Object} user — user profile from users.js
 * @param {string} jid  — WhatsApp JID for per-user dedup
 * @param {string|null} filterType — "Job" | "Hackathon" | null (all)
 * @param {number} limit — max results to return
 */
export async function getOpportunitiesForUser(
  user,
  jid,
  filterType = null,
  limit = 6,
) {
  const cache = getCache();

  // Select pool by type
  let pool = [];
  if (filterType === "Hackathon") {
    pool = cache.hackathons || [];
  } else if (filterType === "Job" || filterType === "Internship") {
    pool = (cache.jobs || []).filter((o) =>
      filterType ? o.type === filterType : true,
    );
  } else {
    pool = cache.all || [];
  }

 if (!pool.length) {
    log("warn", "Pipeline", `Cache empty for ${jid} — fetching directly`);
    pool = await fetchDirectly(user, filterType);
  }

  if (!pool.length) return null;

  // User profile matching
  const userProfile = {
    field: user.field || "",
    skills: user.skills || [],
    region:
      user.region || user.timezone?.split("/")[1]?.replace("_", " ") || "",
    remote: user.remote ?? true,
    preferredTypes: filterType ? [filterType] : null,
  };

  const matched = matchOpportunitiesForUser(userProfile, pool, 0.3);

  // Per-user unseen filter
  const fresh = filterUnseenForUser(jid, matched);

  // Prefer unseen, fall back to top matched if all seen
  const results = fresh.length > 0 ? fresh : matched;

  return results.slice(0, limit);
}
async function fetchDirectly(user, filterType) {
  try {
    const isHackathon = filterType === "Hackathon";
    const isJob = filterType === "Job" || !filterType;

    const [hackathons, jobs, greenhouse] = await Promise.allSettled([
      isHackathon || !filterType ? collectDevpost(user.field) : [],
      isJob ? collectYCJobs(user.field) : [],
      isJob ? collectGreenhouse(user.field) : [],
    ]);

    return [
      ...(hackathons.status === "fulfilled" ? hackathons.value : []),
      ...(jobs.status === "fulfilled" ? jobs.value : []),
      ...(greenhouse.status === "fulfilled" ? greenhouse.value : []),
    ];
  } catch (err) {
    log("error", "Pipeline", `Direct fetch failed: ${err.message}`);
    return [];
  }
}