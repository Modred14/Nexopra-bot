import { getCache } from "../scheduler/index.js";
import { matchOpportunitiesForUser } from "../ai/filter.js";
import { filterUnseenForUser } from "./dedup.js";
import { log } from "./metrics.js";
import { collectDevpost } from "../collectors/devpost.js";
import { collectYCJobs } from "../collectors/ycjobs.js";
import { collectGreenhouse, collectLever } from "../collectors/greenhouse_lever.js";

export async function getOpportunitiesForUser(user, jid, filterType = null, limit = 6) {
  const cache = getCache();

  // Build pool based on filter type
  let pool = [];

  if (filterType === "Hackathon") {
    pool = cache.hackathons || [];
  } else if (filterType === "Internship") {
    pool = (cache.jobs || []).filter((o) => o.type === "Internship");
  } else if (filterType === "Job") {
    pool = (cache.jobs || []).filter((o) => o.type === "Job");
  } else if (filterType === "Grant") {
    pool = (cache.all || []).filter((o) => o.type === "Grant");
  } else if (filterType === "Fellowship") {
    pool = (cache.all || []).filter((o) => o.type === "Fellowship");
  } else if (filterType === "Program") {
    pool = (cache.all || []).filter((o) => o.type === "Program");
  } else {
    pool = cache.all || [];
  }

  // If cache empty or filtered pool empty, fetch directly
  if (!pool.length) {
    log("warn", "Pipeline", `Cache empty for type:${filterType} — fetching directly`);
    pool = await fetchDirectly(user, filterType);
  }

  if (!pool.length) return null;

  // Apply location filter
  pool = applyLocationFilter(pool, user);

  const userProfile = {
    field: user.field || "",
    skills: user.skills || [],
    region: user.region || "",
    remote: user.remote ?? true,
    preferredTypes: filterType ? [filterType] : null,
  };

  const matched = matchOpportunitiesForUser(userProfile, pool, 0.3);
  const fresh = filterUnseenForUser(jid, matched);
  const results = fresh.length > 0 ? fresh : matched.filter((o) => {
    // Last resort fallback — still respect location
    return true;
  });

  return results.slice(0, limit);
}

/**
 * Filter by location:
 * - remote jobs: always included
 * - on-site/hybrid: only include if location matches user region or is unset
 */
function applyLocationFilter(opportunities, user) {
  const userRegion = (user.region || user.timezone?.split("/")[1]?.replace("_", " ") || "").toLowerCase();

  return opportunities.filter((opp) => {
    // Always include remote
    if (opp.remote === true) return true;

    // No location data — include it (can't filter)
    if (!opp.location) return true;

    // On-site/hybrid — only include if region matches
    if (userRegion) {
      const loc = opp.location.toLowerCase();
      return (
        loc.includes(userRegion) ||
        userRegion.includes(loc) ||
        loc.includes("worldwide") ||
        loc.includes("global") ||
        loc.includes("anywhere")
      );
    }

    return true;
  });
}

async function fetchDirectly(user, filterType) {
  try {
    const results = await Promise.allSettled([
      collectDevpost(user.field),
      collectYCJobs(user.field),
      collectGreenhouse(user.field),
      collectLever(user.field),
    ]);

    let all = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value);

    // Filter by type if specified
    if (filterType) {
      const filtered = all.filter((o) => o.type === filterType);
      // If nothing matches the type, return everything and let user matching handle it
      return filtered.length > 0 ? filtered : all;
    }

    return all;
  } catch (err) {
    log("error", "Pipeline", `Direct fetch failed: ${err.message}`);
    return [];
  }
}