// ─────────────────────────────────────────────────────────────────────────────
// core/dedup.js — Global Deduplication Store
// ─────────────────────────────────────────────────────────────────────────────
import fs from "fs";
import { fingerprint } from "./schema.js";

const DEDUP_FILE = "dedup_store.json";
const MAX_ENTRIES = 5000;

let store = new Set();

export function loadDedup() {
  if (fs.existsSync(DEDUP_FILE)) {
    const arr = JSON.parse(fs.readFileSync(DEDUP_FILE, "utf8"));
    store = new Set(arr);
  }
}

export function saveDedup() {
  const arr = [...store].slice(-MAX_ENTRIES);
  fs.writeFileSync(DEDUP_FILE, JSON.stringify(arr, null, 2));
}

/**
 * Filter an array of normalized opportunities, removing already-seen ones.
 * Adds new ones to the store and persists.
 */
export function deduplicateGlobal(opportunities) {
  const fresh = [];
  for (const opp of opportunities) {
    const fp = fingerprint(opp);
    if (!store.has(fp)) {
      store.add(fp);
      fresh.push(opp);
    }
  }
  if (fresh.length) saveDedup();
  return fresh;
}

/**
 * Per-user seen tracking (for WhatsApp "don't resend to same user").
 */
const SEEN_FILE = "seen_opportunities.json";
let userSeen = {};

export function loadUserSeen() {
  if (fs.existsSync(SEEN_FILE)) {
    userSeen = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
  }
}

export function filterUnseenForUser(jid, opportunities) {
  if (!userSeen[jid]) userSeen[jid] = [];
  const seen = new Set(userSeen[jid]);

  const fresh = opportunities.filter((opp) => {
    const key = (opp.sourceUrl || opp.title || "").toLowerCase().trim();
    return !seen.has(key);
  });

  fresh.forEach((opp) => {
    const key = (opp.sourceUrl || opp.title || "").toLowerCase().trim();
    userSeen[jid].push(key);
  });

  if (userSeen[jid].length > 500) userSeen[jid] = userSeen[jid].slice(-500);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(userSeen, null, 2));
  return fresh;
}