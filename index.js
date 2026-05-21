// ─────────────────────────────────────────────────────────────────────────────
// index.js — Nexopra WhatsApp Bot (Refactored)
//
// Architecture:
//   scheduler/   → runs periodic collection (jobs/hackathons/X) into shared cache
//   collectors/  → per-source scrapers (Devpost, YC, Greenhouse, Lever,
//                  Wellfound, LinkedIn indexed, Nitter)
//   core/        → pipeline, dedup, users, schema, metrics
//   ai/          → AI filtering + user matching (Groq)
// ─────────────────────────────────────────────────────────────────────────────
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import "dotenv/config";
import TRIGGER_PHRASES from "./trigger.js";
import {
  loadUsers,
  saveUsers,
  getUser,
  setUser,
  getAllUsers,
  userExists,
} from "./core/users.js";
import { loadUserSeen } from "./core/dedup.js";
import { loadMetrics, log } from "./core/metrics.js";
import { getOpportunitiesForUser } from "./core/pipeline.js";
import { startScheduler, getCache } from "./scheduler/index.js";

// ─── Init persistent stores ───────────────────────────────────────────────────
loadUsers();
loadUserSeen();
loadMetrics();

// ─── Conversation sessions ────────────────────────────────────────────────────
// states: awaiting_name | awaiting_field | awaiting_time | awaiting_search_confirm
const sessions = {};

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTER
// ─────────────────────────────────────────────────────────────────────────────
function typeIcon(type) {
  return (
    {
      Job: "💼",
      Internship: "🎓",
      Hackathon: "🏆",
      Grant: "💰",
      Fellowship: "🌟",
      Program: "🚀",
    }[type] || "📌"
  );
}

function formatOpportunities(name, opportunities, user) {
  if (!opportunities || opportunities.length === 0) {
    return `😔 Sorry ${name}, no new opportunities right now. Check back soon!`;
  }

  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: user.timezone || "Africa/Lagos",
  });

  let msg = `🔥 Hey ${name}!\nOpportunities for ${date}:\n────────────────\n\n`;

  function stripHtml(text) {
    if (!text) return "";
    return text
      .replace(/<[^>]+>/g, " ") // remove HTML tags
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ") // collapse whitespace
      .trim();
  }
  opportunities.forEach((opp, i) => {
    msg += `${i + 1}. ${typeIcon(opp.type)} *${opp.title}*\n`;
    msg += `   📍 ${opp.remote ? "Remote" : opp.location || "On-site"} · ${opp.type} · ${opp.source}\n`;
    if (opp.description)
      msg += `   ${stripHtml(opp.description).slice(0, 100)}...\n`;
    if (opp.deadline) msg += `   ⏰ Deadline: ${opp.deadline}\n`;
    if (opp.prize) msg += `   💰 Prize: ${opp.prize}\n`;
    if (opp.salary) msg += `   💵 Salary: ${opp.salary}\n`;
    msg += `   🔗 ${opp.sourceUrl}\n\n`;
  });

  msg += `────────────────\n`;
  // msg += `💡 *now* · *jobs* · *hackathons* · *pause* · *help*\n`;
  msg += "\n*`Powered by Nexopra 🤖`*";
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY DELIVERY SCHEDULER (WhatsApp delivery, not collection)
// ─────────────────────────────────────────────────────────────────────────────
function scheduleDelivery(sock) {
  setInterval(async () => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    for (const [jid, user] of Object.entries(getAllUsers())) {
      if (!user.active || user.deliveryTime !== hhmm) continue;
      try {
        const opps = await getOpportunitiesForUser(user, jid);
        const message = formatOpportunities(user.name, opps, user);
        await sock.sendMessage(jid, { text: message });
        log("info", "Delivery", `Sent to ${jid}`);
      } catch (e) {
        log("error", "Delivery", `Failed for ${jid}: ${e.message}`);
      }
    }
  }, 60_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING FLOW
// ─────────────────────────────────────────────────────────────────────────────
const FIELD_MAP = {
  1: "Frontend Dev",
  2: "Backend Dev",
  3: "Full Stack Dev",
  4: "UI/UX Design",
  5: "Mobile Dev",
  6: "Data Science / AI",
  7: "Cybersecurity",
  8: "DevOps / Cloud",
  9: "Product Management",
  10: "Blockchain / Web3",
};

async function handleOnboarding(sock, sender, text, session) {
  const step = session.step;
  const timeTo24hrs = (time) => {
    let [hours, minutes] = time.split(":").map(Number);

    const period = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;

    return `${hours}:${String(minutes).padStart(2, "0")} ${period}`;
  };

  if (step === "awaiting_name") {
    session.tmpData.name = text.trim();
    session.step = "awaiting_field";
    await sock.sendMessage(sender, {
      text: `Nice to meet you, *${session.tmpData.name}*! 🙌\n\nWhat's your field? Pick one or more (comma-separated):\n\n1️⃣ Frontend Dev\n2️⃣ Backend Dev\n3️⃣ Full Stack Dev\n4️⃣ UI/UX Design\n5️⃣ Mobile Dev\n6️⃣ Data Science / AI\n7️⃣ Cybersecurity\n8️⃣ DevOps / Cloud\n9️⃣ Product Management\n🔟 Blockchain / Web3\n\n_Example: *1,3* for Frontend + Full Stack_`,
    });
    return;
  }

  if (step === "awaiting_field") {
    const picked = text
      .trim()
      .split(",")
      .map((n) => FIELD_MAP[parseInt(n.trim())])
      .filter(Boolean);
    if (!picked.length) {
      await sock.sendMessage(sender, {
        text: "⚠️ Reply with numbers 1–10, comma-separated. E.g. *1,3*",
      });
      return;
    }
    session.tmpData.field = picked.join(", ");
    session.step = "awaiting_time";
    await sock.sendMessage(sender, {
      text: `🔥 Got it:\n${picked.map((f) => `• ${f}`).join("\n")}\n\n⏰ What time for daily delivery? (24hr HH:MM)\nE.g. *08:00* or *18:30*`,
    });
    return;
  }

  if (step === "awaiting_time") {
    const normalized = text.trim().replace(/^(\d):/, "0$1:");
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) {
      await sock.sendMessage(sender, {
        text: "⚠️ Use HH:MM format, e.g. *08:00* or *18:30*",
      });
      return;
    }

    setUser(sender, {
      name: session.tmpData.name,
      field: session.tmpData.field,
      deliveryTime: normalized,
      timezone: "Africa/Lagos",
      active: true,
      remote: true,
      joinedAt: new Date().toISOString(),
    });
    delete sessions[sender];

    const user = getUser(sender);
    await sock.sendMessage(sender, {
      text: `✅ You're set, *${user.name}*!\n\n🤖 I'll deliver opportunities for:\n${user.field
        .split(", ")
        .map((f) => `• ${f}`)
        .join(
          "\n",
        )}\n\nDaily at *${timeTo24hrs(user.deliveryTime)}*.\n\nCommands:\n• *now* — get opportunities instantly\n• *jobs* / *hackathons* / *internships* — filter by type\n• *pause* / *resume* — toggle updates\n• *profile* — your profile\n• *menu* — all commands\n\n🚀 Great opportunities are coming your way!`,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────
const FILTER_MAP = {
  jobs: "Job",
  job: "Job",
  internships: "Internship",
  internship: "Internship",
  hackathons: "Hackathon",
  hackathon: "Hackathon",
  programs: "Program",
  program: "Program",
  grants: "Grant",
  grant: "Grant",
  fellowships: "Fellowship",
  fellowship: "Fellowship",
};

const GREETINGS = new Set([
  "hi",
  "hello",
  "hey",
  "heyy",
  "start",
  "begin",
  "home",
  "yo",
  "sup",
  "howdy",
  "hola",
  "good morning",
  "good afternoon",
  "good evening",
  "gm",
  "hy",
  "hai",
  "nexopra",
  "how far",
  "abeg",
  "👋",
  "👋🏾",
  "👋🏿",
  "test",
  "ping",
]);

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const text = (
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    ""
  ).trim();
  if (!text) return;

  const sender = msg.key.remoteJid;
  const lower = text.toLowerCase().trim();
  const user = getUser(sender);

  // ── Search confirm flow ──
  if (sessions[sender]?.step === "awaiting_search_confirm") {
    const query = sessions[sender].pendingQuery;
    delete sessions[sender];
    if (["yes", "y", "yeah", "yep"].includes(lower)) {
      await sock.sendMessage(sender, {
        text: `🔍 Searching for *"${query}"*...`,
      });
      // Delegate to Groq for quick web-style answer
      const reply = await quickAnswer(query, user);
      await sock.sendMessage(sender, { text: reply });
    } else {
      await sock.sendMessage(sender, {
        text: `No worries! Send *help* to see what I can do. 😊`,
      });
    }
    return;
  }

  // ── Onboarding in progress ──
  if (sessions[sender]) {
    await handleOnboarding(sock, sender, text, sessions[sender]);
    return;
  }

  // ── New user or greeting ──
  if (!user || GREETINGS.has(lower)) {
    if (!user) {
      sessions[sender] = { step: "awaiting_name", tmpData: {} };
      await sock.sendMessage(sender, {
        text: "👋 Welcome to *Nexopra*!\n\nYour AI-powered opportunity scout. Every day I'll deliver:\n• 💼 Tech Jobs\n• 🎓 Internships\n• 🏆 Hackathons\n• 🌟 Fellowships & Grants\n\n...matched to *your skills*, directly on WhatsApp.\n\nLet's get you set up! What's your *name*? 👇",
      });
    } else {
      const pepTalk = [
        "Which opportunity are you applying to today?",
        "Got any applications lined up?",
        "Any hackathons on your radar?",
        "Ready to find your next opportunity?",
      ];
      await sock.sendMessage(sender, {
        text: `👋 Hey *${user.name}*! ${pepTalk[Math.floor(Math.random() * pepTalk.length)]}\n\n• *now* — get today's opportunities\n• *menu* — see all commands`,
      });
    }
    return;
  }

  // ── NOW / MORE ──
  const matchedPhrase = TRIGGER_PHRASES.some((phrase) =>
    lower.includes(phrase),
  );
  if (lower === "now" || lower === "more" || matchedPhrase) {
    await sock.sendMessage(sender, {
      text: `⚡ Fetching the best opportunities for *${user.field}*... hang tight 🙏`,
    });
    const opps = await getOpportunitiesForUser(user, sender);
    await sock.sendMessage(sender, {
      text: formatOpportunities(user.name, opps, user),
    });
    return;
  }

  // ── TYPE FILTERS ──
  if (FILTER_MAP[lower]) {
    const filterType = FILTER_MAP[lower];
    await sock.sendMessage(sender, {
      text: `🔍 Finding *${filterType}* opportunities...`,
    });
    const opps = await getOpportunitiesForUser(user, sender, filterType);
    await sock.sendMessage(sender, {
      text: formatOpportunities(user.name, opps, user),
    });
    return;
  }

  // ── PAUSE ──
  if (lower === "pause") {
    setUser(sender, { active: false });
    await sock.sendMessage(sender, {
      text: `⏸️ Got it, ${user.name}. Daily updates are paused.\nSend *resume* whenever you're ready.`,
    });
    return;
  }
  const timeTo24hrs = (time) => {
    let [hours, minutes] = time.split(":").map(Number);

    const period = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;

    return `${hours}:${String(minutes).padStart(2, "0")} ${period}`;
  };

  // ── RESUME ──
  if (lower === "resume") {
    setUser(sender, { active: true });
    const getNextRunDate = (deliveryTime, timeZone) => {
      const now = new Date(new Date().toLocaleString("en-US", { timeZone }));

      const [hours, minutes] = deliveryTime.split(":").map(Number);

      const target = new Date(now);
      target.setHours(hours, minutes, 0, 0);

      const isPast = target <= now;

      if (isPast) {
        target.setDate(target.getDate() + 1);
      }

      const label = isPast ? "Tomorrow" : "Today";

      return {
        date: target,
        label,
      };
    };
    const { date, label } = getNextRunDate(user.deliveryTime, user.timezone);
    await sock.sendMessage(sender, {
      text: `▶️ Updates resumed! Next opportunities drop *${label} at ${timeTo24hrs(user.deliveryTime)}* 🎯`,
   
    });
    return;
  }

  // ── UPDATE ──
  if (lower === "update") {
    sessions[sender] = { step: "awaiting_name", tmpData: {} };
    await sock.sendMessage(sender, {
      text: `🔄 Let's update your profile!\n\nWhat's your *name*?`,
    });
    return;
  }

  // ── STATUS ──
  if (lower === "status" || lower === "profile") {
    const fields = user.field.split(", ");
    const fieldList = fields.map((f) => `   › ${f}`).join("\n");

    await sock.sendMessage(sender, {
      text: [
        `┌──────────────`,
        `  🤖 *NEXOPRA PROFILE*`,
        `└──────────────`,

        `👤 Username: *${user.name}*`,
        `📅  Joined: ${new Date(user.joinedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`,

        `━━━━━━━━━━━`,
        `🛠  *TECH STACK*`,
        fieldList,

        `━━━━━━━━━━━`,
        `⚙️  *PREFERENCES*`,
        `   › Daily Delivery: *${timeTo24hrs(user.deliveryTime)}*`,
        `   › Timezone: *${user.timezone || "Africa/Lagos"}*`,
        `   › Show Remote: ${user.remote ? "*Yes*" : "*No*"}`,

        `━━━━━━━━━━━`,
        `📬  *STATUS*`,
        `   › Updates: ${user.active ? "*Active*" : "*Paused*"}`,

        `━━━━━━━━━━━`,
        ``,
        `_Type *now* to get today's opportunities_`,
        `_Type *update* to edit your profile_`,
      ].join("\n"),
    });
    return;
  }
  if (lower === "about") {
    await sock.sendMessage(sender, {
      text: [
        `┌──────────────`,
        `  ✨ *ABOUT NEXOPRA*`,
        `└──────────────`,
        ``,
        `*Nexopra* is your AI-powered opportunity scout — delivering the best tech jobs, hackathons, fellowships & grants directly to your WhatsApp, every single day.`,
        ``,
        `━━━━━━━━━━━`,
        `👨‍💻  *THE DEVELOPER*`,
        ``,
        `   *Modred*`,
        `   Full Stack Web Developer`,
        ``,
        `   🌐  https://modred.dev`,
        `   📧  favourdomirin@gmail.com`,
        `   📱  +23279566275`,

        `━━━━━━━━━━━`,
        `🚀  *NEXOPRA*`,
        `   › Version: *1.0.1*`,
        `   › Built with: Node.js · Baileys · Groq`,
        `   › Serving developers across Africa`,

        `━━━━━━━━━━━`,
        `_Built for developers_ 🌍`,
      ].join("\n"),
    });
    return;
  }
  const developerTriggers = [
    "developer",
    "dev",
    "owner",
    "creator",
    "who made you",
    "who built you",
    "who created you",
    "who owns nexopra",
    "who is modred",
    "about developer",
    "about owner",
    "your creator",
    "your developer",
    "made nexopra",
    "built nexopra",
    "build nexopra",
  ];
  const isDeveloperQuery = developerTriggers.some((trigger) =>
    lower.includes(trigger),
  );
  if (isDeveloperQuery) {
    await sock.sendMessage(sender, {
      text: [
        `━━━━━━━━━━━`,
        `👨‍💻  *THE DEVELOPER*`,
        ``,
        `   *Modred*`,
        `   Full Stack Web Developer`,
        ``,
        `   🌐  https://modred.dev`,
        `   📧  favourdomirin@gmail.com`,
        `   📱  +23279566275`,
        ``,
        `━━━━━━━━━━━`,
      ].join("\n"),
    });

    // Send WhatsApp contact card
    await sock.sendMessage(sender, {
      contacts: {
        displayName: "Modred",
        contacts: [
          {
            displayName: "Modred",
            vcard: `BEGIN:VCARD
VERSION:3.0
FN:Modred
TEL;type=CELL;type=VOICE;waid=23279566275:+23279566275
EMAIL:favourdomirin@gmail.com
URL:https://modred.dev
END:VCARD`,
          },
        ],
      },
    });

    return;
  }

  // ── HELP ──
  if (lower === "help" || lower === "menu") {
    await sock.sendMessage(sender, {
      text: [
        `┌──────────────`,
        `  🤖 *NEXOPRA* 🤖`,
        `└──────────────`,
        ``,
        `📡 *OPPORTUNITIES*`,
        `   › *now* — Get fresh opportunities`,
        `   › *jobs* — Jobs only`,
        `   › *internships* — Internships only`,
        `   › *hackathons* — Hackathons only`,
        `   › *fellowships* — Fellowships only`,
        `   › *grants* — Grants only`,
        `   › *programs* — Programs only`,

        `━━━━━━━━━━━`,
        `⚙️  *ACCOUNT*`,
        `   › *profile* — View your profile`,
        `   › *update* — Edit your settings`,
        `   › *pause* — Pause daily updates`,
        `   › *resume* — Resume updates`,

        `━━━━━━━━━━━`,

        `ℹ️  *INFO*`,
        `   › *dev* — About the developer`,
        `   › *about* — About this bot`,
        `   › *menu* — This menu`,

        `━━━━━━━━━━━`,
        `👤  *${user.name}*  ·  \`${user.field}\``,
        `⏰  Daily at *${timeTo24hrs(user.deliveryTime)}*`,
        `━━━━━━━━━━━`,
      ].join("\n"),
    });
    return;
  }

  // // ── DEFAULT: ask before searching ──
  // const confused = [
  //   "Hmm, not sure I got that 🤔",
  //   "I didn't quite catch that 😅",
  //   "That one went over my head 😄",
  // ];
  // sessions[sender] = { step: "awaiting_search_confirm", pendingQuery: text };
  // await sock.sendMessage(sender, {
  //   text: `${confused[Math.floor(Math.random() * confused.length)]}\n\nShould I search the web for *"${text}"*? Reply *yes* or *no*`,
  // });
  const reply = await quickAnswer(lower, user);
  await sock.sendMessage(sender, { text: reply });
}

// ─── Quick Groq answer for search fallback ────────────────────────────────────
import https from "https";

const conversations = new Map();
async function quickAnswer(query, user, sender) {
  return new Promise((resolve) => {
    const history = conversations.get(sender) || [];
    history.push({ role: "user", content: query });
    const trimmedHistory = history.slice(-10);
    const body = JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "system",
          content: `You are Nexopra, a sharp career assistant on WhatsApp helping a ${user?.field || "tech"} professional. Today is ${new Date().toISOString().split("T")[0]}.

Rules:

* Maximum 2 short sentences.
* Do not over explain.
* Go straight to the point.
* No greetings.
* No markdown.
* Sound human, concise, and direct.
* Avoid filler words and motivational talk.
* Only answer what was asked.`,
        },
        ...trimmedHistory,
      ],
      max_tokens: 300,
      temperature: 0.3,
    });

    const options = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const reply =
            parsed.choices?.[0]?.message?.content?.trim() ||
            "Couldn't find anything on that.";
          trimmedHistory.push({ role: "assistant", content: reply });
          conversations.set(sender, trimmedHistory);
          resolve(reply);
        } catch {
          resolve("Couldn't find anything on that. Try rephrasing! 😅");
        }
      });
    });
    req.on("error", () =>
      resolve("Couldn't find anything on that. Try rephrasing! 😅"),
    );
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BOT STARTUP
// ─────────────────────────────────────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    browser: ["Nexopra Bot", "Chrome", "1.0"],
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 Scan this QR code with WhatsApp:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      log("info", "Bot", `Connection closed. Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startBot();
    }

    if (connection === "open") {
      log("info", "Bot", "✅ Nexopra connected 🚀");
      // Start the opportunity collection scheduler
      startScheduler();
      // Start WhatsApp delivery scheduler
      scheduleDelivery(sock);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    try {
      await handleMessage(sock, messages[0]);
    } catch (err) {
      log("error", "Bot", `Handler error: ${err.message}`);
    }
  });
}

startBot();
