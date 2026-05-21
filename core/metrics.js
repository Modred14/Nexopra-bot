// ─────────────────────────────────────────────────────────────────────────────
// core/metrics.js — Logging + Source Metrics
// ─────────────────────────────────────────────────────────────────────────────
import fs from "fs";

const METRICS_FILE = "metrics.json";

const defaults = {
  totalFound: 0,
  duplicatesRemoved: 0,
  aiAccepted: 0,
  aiRejected: 0,
  failedScrapes: 0,
  bySource: {},
  runs: [],
};

let metrics = { ...defaults };

export function loadMetrics() {
  if (fs.existsSync(METRICS_FILE)) {
    metrics = { ...defaults, ...JSON.parse(fs.readFileSync(METRICS_FILE, "utf8")) };
  }
}

function save() {
  fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
}

export function recordFound(source, count) {
  metrics.totalFound += count;
  if (!metrics.bySource[source]) metrics.bySource[source] = { found: 0, failed: 0 };
  metrics.bySource[source].found += count;
  save();
}

export function recordDuplicates(count) {
  metrics.duplicatesRemoved += count;
  save();
}

export function recordAI(accepted, rejected) {
  metrics.aiAccepted += accepted;
  metrics.aiRejected += rejected;
  save();
}

export function recordFailed(source) {
  metrics.failedScrapes += 1;
  if (!metrics.bySource[source]) metrics.bySource[source] = { found: 0, failed: 0 };
  metrics.bySource[source].failed += 1;
  save();
}

export function recordRun(summary) {
  metrics.runs.push({ ...summary, ts: new Date().toISOString() });
  if (metrics.runs.length > 100) metrics.runs = metrics.runs.slice(-100);
  save();
}

export function getMetrics() {
  return { ...metrics };
}

export function log(level, source, msg, extra = {}) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [${source}] ${msg}`;
  if (Object.keys(extra).length) {
    console.log(line, extra);
  } else {
    console.log(line);
  }
}
