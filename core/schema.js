// ─────────────────────────────────────────────────────────────────────────────
// core/schema.js — Normalized Opportunity Schema + Fingerprint
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";

/**
 * Normalize any raw opportunity object into the canonical Nexopra schema.
 * Missing fields default to null.
 */
export function normalizeOpportunity(raw) {
  return {
    id: raw.id || generateId(raw),
    title: raw.title?.trim() || null,
    company: raw.company?.trim() || null,
    type: raw.type || "Job", // Job | Internship | Hackathon | Grant | Fellowship | Program
    location: raw.location?.trim() || null,
    remote: raw.remote ?? null,
    source: raw.source || null,
    sourceUrl: raw.sourceUrl || raw.applyUrl || null,
    description: raw.description || raw.summary || null,
    skills: Array.isArray(raw.skills) ? raw.skills : [],
    deadline: raw.deadline || null,
    salary: raw.salary || null,
    prize: raw.prize || null,
    postedAt: raw.postedAt || null,
    confidenceScore: raw.confidenceScore ?? null,
  };
}

/**
 * Generate a deterministic fingerprint for deduplication.
 * Based on: normalized title + company + sourceUrl
 */
export function fingerprint(opp) {
  const title = (opp.title || "").toLowerCase().replace(/\s+/g, " ").trim();
  const company = (opp.company || "").toLowerCase().trim();
  const raw = `${title}||${company}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

function generateId(raw) {
  return fingerprint(raw);
}

export const OPPORTUNITY_TYPES = {
  JOB: "Job",
  INTERNSHIP: "Internship",
  HACKATHON: "Hackathon",
  GRANT: "Grant",
  FELLOWSHIP: "Fellowship",
  PROGRAM: "Program",
};
