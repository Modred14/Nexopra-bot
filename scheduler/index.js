// scheduler/index.js
import { collectDevpost } from "../collectors/devpost.js";
import { collectYCJobs } from "../collectors/ycjobs.js";
import {
  collectGreenhouse,
  collectLever,
} from "../collectors/greenhouse_lever.js";
import { collectWellfound } from "../collectors/wellfound.js";
import { collectLinkedInIndexed } from "../collectors/linkedin_indexed.js";
import { collectNitter } from "../collectors/nitter.js";
import { aiFilterBatch } from "../ai/filter.js";
import { deduplicateGlobal, loadDedup } from "../core/dedup.js";
import { log, recordRun, recordDuplicates } from "../core/metrics.js";
import { loadUsers, getAllUsers } from "../core/users.js";

let opportunityCache = {
  jobs: [],
  hackathons: [],
  all: [],
  lastUpdated: null,
};

export function getCache() {
  return opportunityCache;
}

function settled(result) {
  return result.status === "fulfilled" ? result.value : [];
}

function getActiveFields() {
  const users = getAllUsers();
  const fields = new Set();
  for (const user of Object.values(users)) {
    if (user.active && user.field) {
      user.field.split(", ").forEach((f) => fields.add(f.trim()));
    }
  }
  return fields.size > 0 ? [...fields].join(", ") : "software engineer";
}

function mergeAll() {
  const merged = [...opportunityCache.jobs, ...opportunityCache.hackathons];
  return [...new Map(merged.map((o) => [o.sourceUrl || o.id, o])).values()];
}

async function runJobsCollection() {
  const fieldHint = getActiveFields();
  log("info", "Scheduler", "▶ Running jobs collection...");
  const start = Date.now();

  const [yc, greenhouse, lever, wellfound, linkedin] = await Promise.allSettled(
    [
      collectYCJobs(fieldHint),
      collectGreenhouse(fieldHint),
      collectLever(fieldHint),
      collectWellfound(fieldHint),
      collectLinkedInIndexed({ field: fieldHint, remote: true }),
    ],
  );

  const raw = [
    ...settled(yc),
    ...settled(greenhouse),
    ...settled(lever),
    ...settled(wellfound),
    ...settled(linkedin),
  ];

  const beforeDedup = raw.length;
  const deduped = deduplicateGlobal(raw);
  recordDuplicates(beforeDedup - deduped.length);

  const filtered = await aiFilterBatch(deduped);

  opportunityCache.jobs = filtered;
  opportunityCache.all = mergeAll();
  opportunityCache.lastUpdated = new Date().toISOString();

  recordRun({
    type: "jobs",
    raw: beforeDedup,
    deduped: deduped.length,
    filtered: filtered.length,
    duration: Date.now() - start,
  });

  log("info", "Scheduler", `✓ Jobs: ${filtered.length} cached`);
}

async function runHackathonCollection() {
  const fieldHint = getActiveFields();
  log("info", "Scheduler", "▶ Running hackathon collection...");
  const start = Date.now();

  const raw = await collectDevpost(fieldHint);

  const beforeDedup = raw.length;
  const deduped = deduplicateGlobal(raw);
  recordDuplicates(beforeDedup - deduped.length);

  const filtered = await aiFilterBatch(deduped);

  opportunityCache.hackathons = filtered;
  opportunityCache.all = mergeAll();
  opportunityCache.lastUpdated = new Date().toISOString();

  recordRun({
    type: "hackathons",
    raw: beforeDedup,
    deduped: deduped.length,
    filtered: filtered.length,
    duration: Date.now() - start,
  });

  log("info", "Scheduler", `✓ Hackathons: ${filtered.length} cached`);
}

async function runXMonitoring() {
  log("info", "Scheduler", "▶ Running X/Nitter monitoring...");
  const start = Date.now();

  const raw = await collectNitter();

  const beforeDedup = raw.length;
  const deduped = deduplicateGlobal(raw);
  recordDuplicates(beforeDedup - deduped.length);

  const filtered = await aiFilterBatch(deduped);

  opportunityCache.all = [
    ...new Map(
      [...opportunityCache.all, ...filtered].map((o) => [o.sourceUrl, o]),
    ).values(),
  ];
  opportunityCache.lastUpdated = new Date().toISOString();

  recordRun({
    type: "x_monitoring",
    raw: beforeDedup,
    deduped: deduped.length,
    filtered: filtered.length,
    duration: Date.now() - start,
  });

  log("info", "Scheduler", `✓ X monitoring: ${filtered.length} cached`);
}

export function startScheduler() {
  loadDedup();
  log("info", "Scheduler", "🚀 Nexopra Scheduler starting...");

  // Run immediately on boot
  runJobsCollection().catch((e) => log("error", "Scheduler", e.message));
  runHackathonCollection().catch((e) => log("error", "Scheduler", e.message));
//   runXMonitoring().catch((e) => log("error", "Scheduler", e.message));

  // Jobs: every 30 minutes
  setInterval(
    () => {
      runJobsCollection().catch((e) => log("error", "Scheduler", e.message));
    },
    30 * 60 * 1000,
  );

  // Hackathons: every 60 minutes
  setInterval(
    () => {
      runHackathonCollection().catch((e) =>
        log("error", "Scheduler", e.message),
      );
    },
    60 * 60 * 1000,
  );

  // X monitoring: every 2 hours
  setInterval(
    () => {
    //   runXMonitoring().catch((e) => log("error", "Scheduler", e.message));
    },
    2 * 60 * 60 * 1000,
  );
}
