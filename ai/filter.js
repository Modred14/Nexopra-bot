// ─────────────────────────────────────────────────────────────────────────────
// ai/filter.js — AI Opportunity Filtering + Classification
// ─────────────────────────────────────────────────────────────────────────────
import https from "https";
import { log, recordAI } from "../core/metrics.js";

/**
 * Run AI filtering on a batch of opportunities.
 * Returns only accepted opportunities with enriched fields.
 *
 * Each accepted opportunity gets:
 *   - type (corrected)
 *   - skills (extracted)
 *   - experienceLevel
 *   - studentFriendly
 *   - urgency
 *   - confidenceScore (0-1)
 */
export async function aiFilterBatch(opportunities) {
  if (!opportunities.length) return [];

  // Process in chunks of 5 to stay within token limits
  const CHUNK = 5;
  const accepted = [];
  let totalRejected = 0;

  for (let i = 0; i < opportunities.length; i += CHUNK) {
    const chunk = opportunities.slice(i, i + CHUNK);
    const results = await classifyChunk(chunk);
    accepted.push(...results.accepted);
    totalRejected += results.rejected;
  }

  recordAI(accepted.length, totalRejected);
  log("info", "AIFilter", `Accepted: ${accepted.length}, Rejected: ${totalRejected}`);
  return accepted;
}

async function classifyChunk(opportunities) {
  const simplified = opportunities.map((opp, i) => ({
    idx: i,
    title: opp.title,
    company: opp.company,
    type: opp.type,
    description: (opp.description || "").slice(0, 200),
    source: opp.source,
    sourceUrl: opp.sourceUrl,
  }));

  const prompt = `You are a strict quality filter for a tech opportunity platform. Analyze these opportunities and classify each.

OPPORTUNITIES:
${JSON.stringify(simplified, null, 2)}

For each opportunity, respond with a JSON array. Each item must have:
- idx: (same index as input)
- real: true/false (is this a real, legitimate opportunity?)
- type: "Job" | "Internship" | "Hackathon" | "Grant" | "Fellowship" | "Program"
- skills: string[] (up to 5 relevant tech skills inferred)
- experienceLevel: "entry" | "mid" | "senior" | "any"
- studentFriendly: true/false
- urgency: "high" | "medium" | "low"
- confidenceScore: 0.0 to 1.0

RULES:
- Mark real:false if: spam, duplicate-sounding, vague, non-tech, broken URL pattern, or suspiciously generic
- Be strict. When in doubt, mark real:false
- confidenceScore reflects quality + relevance (1.0 = high signal, well-structured listing)

Respond ONLY with a valid JSON array. No preamble, no markdown.`;

  try {
    const raw = await callGroq(prompt, true);
    if (!raw) throw new Error("No AI response");

    const clean = raw.replace(/```json|```/g, "").trim();
    const classifications = JSON.parse(clean);

    const accepted = [];
    let rejected = 0;

    for (const cls of classifications) {
      if (!cls.real || cls.confidenceScore < 0.45) {
        rejected++;
        continue;
      }
      const opp = opportunities[cls.idx];
      if (!opp) continue;

      accepted.push({
        ...opp,
        type: cls.type || opp.type,
        skills: cls.skills?.length ? cls.skills : opp.skills,
        confidenceScore: cls.confidenceScore,
        // Store extra AI metadata
        _ai: {
          experienceLevel: cls.experienceLevel,
          studentFriendly: cls.studentFriendly,
          urgency: cls.urgency,
        },
      });
    }

    return { accepted, rejected };
  } catch (err) {
    log("error", "AIFilter", `Classification failed: ${err.message}`);
    // On AI failure, pass through all with a default score
    return {
      accepted: opportunities.map((o) => ({ ...o, confidenceScore: 0.5 })),
      rejected: 0,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ai/match.js — User Matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score and filter opportunities for a specific user profile.
 * Returns only high-relevance matches, sorted by score.
 *
 * @param {Object} user — { field, skills, region, preferredTypes, remote }
 * @param {Object[]} opportunities
 * @param {number} minScore — minimum relevance threshold (default 0.5)
 */
export function matchOpportunitiesForUser(user, opportunities, minScore = 0.5) {
  const userKeywords = buildUserKeywords(user);
  const preferredTypes = user.preferredTypes || null; // null = all types

  return opportunities
    .map((opp) => {
      const score = scoreOpportunity(opp, userKeywords, user, preferredTypes);
      return { ...opp, _matchScore: score };
    })
    .filter((opp) => opp._matchScore >= minScore)
    .sort((a, b) => b._matchScore - a._matchScore);
}

function buildUserKeywords(user) {
  // Handle "Frontend Dev, Full Stack Dev" — split by comma first
  const fields = user.field.split(",").map((f) => f.trim());
  
  const keywordMap = {
    "Frontend Dev":       "frontend javascript react css html vue",
    "Backend Dev":        "backend nodejs python api database express",
    "Full Stack Dev":     "fullstack frontend backend javascript python",
    "Data Science / AI":  "data ml ai python tensorflow pytorch",
    "DevOps / Cloud":     "devops aws gcp azure docker kubernetes",
    "Blockchain / Web3":  "blockchain web3 solidity ethereum",
    "Mobile Dev":         "mobile ios android react-native flutter",
    "UI/UX Design":       "design figma ux ui prototype",
    "Product Management": "product manager roadmap agile",
    "Cybersecurity":      "security pentesting ctf vulnerability",
  };

  const keywords = fields.flatMap((f) =>
    (keywordMap[f] || f.toLowerCase()).split(" ")
  );

  const userSkills = (user.skills || []).map((s) => s.toLowerCase());
  return [...new Set([...keywords, ...userSkills])].filter(Boolean);
}

function scoreOpportunity(opp, userKeywords, user, preferredTypes) {
  let score = opp.confidenceScore || 0.5;

  // Type match
  if (preferredTypes && !preferredTypes.includes(opp.type)) score -= 0.3;

  // Skills/keyword overlap
  const oppText = `${opp.title} ${opp.description} ${opp.skills?.join(" ")}`.toLowerCase();
  const overlap = userKeywords.filter((kw) => oppText.includes(kw)).length;
  score += Math.min(overlap * 0.08, 0.3);

  // Remote preference
  if (user.remote && opp.remote) score += 0.1;
  if (user.remote === false && !opp.remote && opp.location) score += 0.1;

  // Region match (loose)
  if (user.region && opp.location) {
    const regionLower = user.region.toLowerCase();
    const locLower = opp.location.toLowerCase();
    if (locLower.includes(regionLower) || regionLower.includes(locLower)) {
      score += 0.15;
    }
  }

  // Student-friendly bonus
  if (opp._ai?.studentFriendly) score += 0.05;

  return Math.min(Math.max(score, 0), 1);
}

// ─── Groq helper ─────────────────────────────────────────────────────────────
async function callGroq(prompt, jsonMode = false) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1500,
      temperature: 0.1,
      ...(jsonMode && { response_format: { type: "json_object" } }),
    });

    const options = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.choices?.[0]?.message?.content?.trim() || null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}
