import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import fs from "fs";
import https from "https";
import http from "http";
import fetch from "node-fetch";
import "dotenv/config";

// ─────────────────────────────────────────
// PERSISTENT USER STORE
// ─────────────────────────────────────────
const USERS_FILE = "users.json";
const SEEN_FILE = "seen_opportunities.json";

function loadSeen() {
  if (fs.existsSync(SEEN_FILE)) {
    return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
  }
  return {};
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

let seenOpportunities = loadSeen();

function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  }
  return {};
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

let users = loadUsers();

// ─────────────────────────────────────────
// CONVERSATION STATE
// ─────────────────────────────────────────
// states: idle | awaiting_name | awaiting_field | awaiting_time | active
const sessions = {}; // { jid: { step, tmpData } }

// ─────────────────────────────────────────
// OPPORTUNITY FETCHER (Claude AI via Anthropic API)
// ─────────────────────────────────────────
// ─── Devpost: Free real-time hackathon search ───────────────────────────────
async function fetchFromDevpost(field) {
  try {
    const query = encodeURIComponent(field);
    const res = await fetch(
      `https://devpost.com/api/hackathons?search=${query}&status=upcoming&order_by=deadline`,
    );
    const data = await res.json();

    if (!data.hackathons || !Array.isArray(data.hackathons)) return [];

    const today = new Date();

    return data.hackathons
      .filter((h) => {
        if (!h.submission_period_dates) return true;
        // Try to parse deadline from the date string
        const parts = h.submission_period_dates.split(" - ");
        const deadlineStr = parts[parts.length - 1];
        const deadline = new Date(deadlineStr);
        return isNaN(deadline) || deadline > today; // keep if unparseable or future
      })
      .slice(0, 3)
      .map((h) => {
        // Parse deadline display string
        const parts = h.submission_period_dates?.split(" - ") || [];
        const deadlineRaw = parts[parts.length - 1] || null;
        let deadlineFormatted = null;
        if (deadlineRaw) {
          const d = new Date(deadlineRaw);
          if (!isNaN(d)) {
            deadlineFormatted = d.toLocaleDateString("en-US", {
              month: "long",
              day: "2-digit",
              year: "numeric",
            });
          }
        }

        // Prize pool
        let prize = null;
        if (h.prize_amount && h.prize_amount > 0) {
          prize = `$${Number(h.prize_amount).toLocaleString()}`;
        }

        return {
          title: h.title || "Untitled Hackathon",
          type: "Hackathon",
          remote:
            h.displayed_location?.location === "Online" ||
            h.online_only === true,
          deadline: deadlineFormatted,
          prize,
          applyUrl: h.url || `https://devpost.com/hackathons`,
          source: "Devpost",
          summary: h.tagline || "A hackathon on Devpost.",
        };
      });
  } catch (e) {
    console.error("Devpost fetch error:", e.message);
    return [];
  }
}

// ─── Groq API helper ───────────────────────────────────────────────────────
async function callGroq(prompt, jsonMode = false) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1500,
      temperature: 0.3,
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
          const text = parsed.choices?.[0]?.message?.content || "";
          resolve(text.trim());
        } catch (e) {
          console.error("Groq parse error:", e.message);
          resolve(null);
        }
      });
    });

    req.on("error", (e) => {
      console.error("Groq request error:", e.message);
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

function filterUnseen(jid, opportunities) {
  if (!seenOpportunities[jid]) seenOpportunities[jid] = [];

  const seen = new Set(seenOpportunities[jid]);

  const fresh = opportunities.filter((opp) => {
    const key = opp.title?.toLowerCase().trim();
    return !seen.has(key);
  });

  // Save newly seen ones
  fresh.forEach((opp) => {
    const key = opp.title?.toLowerCase().trim();
    seenOpportunities[jid].push(key);
  });

  // Cap seen list at 200 per user so it doesn't grow forever
  if (seenOpportunities[jid].length > 200) {
    seenOpportunities[jid] = seenOpportunities[jid].slice(-200);
  }

  saveSeen(seenOpportunities);
  return fresh;
}
// ─── Gemini: Jobs, Internships, Programs (+ non-hackathon web search) ────────
// ─── Jobicy: Real remote jobs ─────────────────────────────────────────────
async function fetchFromJobicy(field) {
  try {
    const skillMap = {
      "Frontend Dev": "javascript",
      "Backend Dev": "nodejs",
      "Full Stack Dev": "javascript",
      "UI/UX Design": "design",
      "Mobile Dev": "react-native",
      "Data Science / AI": "python",
      Cybersecurity: "security",
      "DevOps / Cloud": "devops",
      "Product Management": "product",
      "Blockchain / Web3": "web3",
    };

    const results = [];

    for (const f of field.split(", ")) {
      const tag = skillMap[f.trim()] || "javascript";
      // fetch more jobs and randomly offset
      const res = await fetch(
        `https://jobicy.com/api/v2/remote-jobs?count=20&tag=${tag}`,
        { headers: { Accept: "application/json" } },
      );
      const data = await res.json();
      if (!data.jobs || !Array.isArray(data.jobs)) continue;

      // shuffle then pick 3
      const shuffled = data.jobs.sort(() => Math.random() - 0.5);
      for (const job of shuffled.slice(0, 3)) {
        results.push({
          title: job.jobTitle,
          type: "Job",
          remote: true,
          deadline: null,
          prize: null,
          applyUrl: job.url,
          source: "Jobicy",
          summary: `${job.jobType} at ${job.companyName} — ${job.jobIndustry?.[0] || "Tech"}.`,
        });
      }
    }

    return results;
  } catch (e) {
    console.error("Jobicy fetch error:", e.message);
    return [];
  }
}
async function fetchFromArbeitnow(field) {
  try {
    const tagMap = {
      "Frontend Dev": "frontend",
      "Backend Dev": "backend",
      "Full Stack Dev": "fullstack",
      "UI/UX Design": "design",
      "Mobile Dev": "mobile",
      "Data Science / AI": "data-science",
      Cybersecurity: "security",
      "DevOps / Cloud": "devops",
      "Product Management": "product-management",
      "Blockchain / Web3": "blockchain",
    };

    const results = [];

    for (const f of field.split(", ").slice(0, 2)) {
      const tag = tagMap[f.trim()] || "software-engineer";
      const res = await fetch(
        `https://www.arbeitnow.com/api/job-board-api?tags[]=${tag}`,
      );
      const data = await res.json();
      if (!data.data || !Array.isArray(data.data)) continue;

      const shuffled = data.data.sort(() => Math.random() - 0.5);
      for (const job of shuffled.slice(0, 3)) {
        results.push({
          title: job.title,
          type: "Job",
          remote: job.remote || false,
          deadline: null,
          prize: null,
          applyUrl: job.url,
          source: "Arbeitnow",
          summary: `${job.job_types?.[0] || "Full-time"} at ${job.company_name}.`,
        });
      }
    }

    return results;
  } catch (e) {
    console.error("Arbeitnow fetch error:", e.message);
    return [];
  }
}
async function fetchFromRemotive(field) {
  try {
    const categoryMap = {
      "Frontend Dev": "software-dev",
      "Backend Dev": "software-dev",
      "Full Stack Dev": "software-dev",
      "UI/UX Design": "design",
      "Mobile Dev": "software-dev",
      "Data Science / AI": "data",
      Cybersecurity: "devops-sysadmin",
      "DevOps / Cloud": "devops-sysadmin",
      "Product Management": "product",
      "Blockchain / Web3": "software-dev",
    };

    const results = [];

    for (const f of field.split(", ").slice(0, 2)) {
      const cat = categoryMap[f.trim()] || "software-dev";
      const res = await fetch(
        `https://remotive.com/api/remote-jobs?category=${cat}&limit=20`,
      );
      const data = await res.json();
      if (!data.jobs || !Array.isArray(data.jobs)) continue;

      // shuffle then pick 2
      const shuffled = data.jobs.sort(() => Math.random() - 0.5);
      for (const job of shuffled.slice(0, 2)) {
        results.push({
          title: job.title,
          type: "Job",
          remote: true,
          deadline: null,
          prize: null,
          applyUrl: job.url,
          source: "Remotive",
          summary: `${job.job_type} at ${job.company_name}.`,
        });
      }
    }

    return results;
  } catch (e) {
    console.error("Remotive fetch error:", e.message);
    return [];
  }
}

// ─── Main export: merges both sources ────────────────────────────────────────
async function fetchOpportunitiesForUser(user, filterType = null) {
  const isHackathonOnly = filterType === "Hackathon";
  const isJobOnly = filterType === "Job";
  const includeHackathons = !filterType || filterType === "Hackathon";
  const includeJobs = !filterType || filterType === "Job";

  const [devpostResults, jobicyResults, remotiveResults, arbeitnowResults] =
    await Promise.all([
      includeHackathons ? fetchFromDevpost(user.field) : [],
      includeJobs ? fetchFromJobicy(user.field) : [],
      includeJobs ? fetchFromRemotive(user.field) : [],
      includeJobs ? fetchFromArbeitnow(user.field) : [],
    ]);

  const jobResults = [...jobicyResults, ...remotiveResults, ...arbeitnowResults]
    .sort(() => Math.random() - 0.5)
    .slice(0, 5);

  let merged;
  if (isHackathonOnly) {
    merged = devpostResults;
  } else if (isJobOnly) {
    merged = jobResults;
  } else {
    merged = [...jobResults, ...devpostResults];
  }

  const seen = new Set();
  const deduped = merged.filter((op) => {
    const key = op.title?.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.length > 0 ? deduped : null;
}

async function askGemini(userMessage, user) {
  const currentDate = new Date().toISOString().split("T")[0];

  const prompt = `You are Nexopra, a sharp AI assistant on WhatsApp helping ${user.name}, a ${user.field} professional/student. Today is ${currentDate}.

User said: "${userMessage}"

RULES:
- Reply like a smart human, not an AI.
- Never greet or use the user's name.
- Start immediately with the answer.
- Max 2-4 short sentences.
- No markdown, no headers.
- Use emojis sparingly.
- If career/opportunity related, give the most relevant current info.`;

  const reply = await callGroq(prompt);
  return reply || "I couldn't find anything on that. Try rephrasing! 😅";
}

// ─────────────────────────────────────────
// MESSAGE FORMATTER
// ─────────────────────────────────────────
function typeIcon(type) {
  const map = {
    Job: "💼",
    Internship: "🎓",
    Hackathon: "🏆",
    Program: "🚀",
  };
  return map[type] || "📌";
}

function formatOpportunities(name, opportunities, user) {
  if (!opportunities || opportunities.length === 0) {
    return `😔 Sorry ${name}, I couldn't find opportunities right now. I'll try again tomorrow!`;
  }

  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: user.timezone || "Africa/Lagos",
  });

  let msg = `🔥 Hello ${name}!\n`;
  msg += `Here are your opportunities for ${date}:\n`;
  msg += `────────────────\n\n`;

  opportunities.forEach((opp, i) => {
    msg += `${i + 1}. ${typeIcon(opp.type)} *${opp.title}*\n`;
    msg += `   📍 ${opp.remote ? "Remote" : "On-site"} · ${opp.type}${opp.source ? ` · ${opp.source}` : ""}\n`;
    if (opp.summary) msg += `   ${opp.summary}\n`;
    if (opp.deadline) msg += `   ⏰ Deadline: ${opp.deadline}\n`;
    if (opp.prize) msg += `   💰 Prize: ${opp.prize}\n`;
    msg += `   🔗 Apply: ${opp.applyUrl}\n\n`;
  });

  msg += `────────────────\n`;
  msg += `💡 Reply *more* for extra listings or *pause* to stop daily updates.\n`;
  msg += `\n*Powered by Nexopra 🤖*`;

  return msg;
}

// ─────────────────────────────────────────
// DAILY DELIVERY SCHEDULER
// ─────────────────────────────────────────
function scheduleDelivery(sock) {
  // Check every minute if any user's delivery time matches now
  setInterval(async () => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(
      now.getMinutes(),
    ).padStart(2, "0")}`;
    for (const [jid, user] of Object.entries(users)) {
      if (user.active && user.deliveryTime === hhmm) {
        const opps = await fetchOpportunitiesForUser(user);
        const allOpps = opps || [];
        const freshOpps = filterUnseen(jid, allOpps);
        const message = formatOpportunities(
          user.name,
          freshOpps.length > 0 ? freshOpps : allOpps,
          user,
        );
        try {
          await sock.sendMessage(jid, { text: message });
        } catch (e) {
          console.error(`Failed to deliver to ${jid}:`, e.message);
        }
      }
    }
  }, 60_000);
}

// ─────────────────────────────────────────
// ONBOARDING FLOW
// ─────────────────────────────────────────
async function handleOnboarding(sock, sender, text, session) {
  const step = session.step;

  if (step === "awaiting_name") {
    session.tmpData.name = text.trim();
    session.step = "awaiting_field";
    await sock.sendMessage(sender, {
      text: `Nice to meet you, *${session.tmpData.name}*! 🙌\n\nWhat's your field or skill? Pick *one or more* by replying with numbers separated by commas:\n\n1️⃣ Frontend Dev\n2️⃣ Backend Dev\n3️⃣ Full Stack Dev\n4️⃣ UI/UX Design\n5️⃣ Mobile Dev\n6️⃣ Data Science / AI\n7️⃣ Cybersecurity\n8️⃣ DevOps / Cloud\n9️⃣ Product Management\n🔟 Blockchain / Web3\n\n_Example: *1,3* for Frontend + Full Stack_`,
    });
    return;
  }

  if (step === "awaiting_field") {
    const fieldMap = {
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

    const inputs = text
      .trim()
      .split(",")
      .map((s) => s.trim());
    const picked = inputs.map((n) => fieldMap[parseInt(n)]).filter(Boolean); // remove invalid entries

    if (picked.length === 0) {
      await sock.sendMessage(sender, {
        text: `⚠️ Please reply with numbers from *1 to 10*, separated by commas.\n\nExample: *1,3* for Frontend Dev + Full Stack Dev`,
      });
      return;
    }
    const fieldResponses = {
      "Frontend Dev": "Oooh a Frontend Dev 🎨 Clean UIs incoming!",
      "Backend Dev": "Backend Dev 💪 The real MVPs fr.",
      "Full Stack Dev": "Full Stack?! You do it all 🤯",
      "UI/UX Design": "UI/UX — you make things beautiful ✨",
      "Mobile Dev": "Mobile Dev 📱 Building the next big app?",
      "Data Science / AI": "Data Science / AI 🤖 The future is yours.",
      Cybersecurity:
        "Cybersecurity 🔐 Protecting the internet one line at a time.",
      "DevOps / Cloud": "DevOps / Cloud ☁️ The backbone of everything.",
      "Product Management":
        "Product Manager 📋 The glue that holds it all together.",
      "Blockchain / Web3": "Web3 builder ⛓️ Decentralize everything!",
    };
    session.tmpData.field = picked.join(", ");
    session.step = "awaiting_time";

    await sock.sendMessage(sender, {
      text: `🔥 Nice combo! You picked:\n${picked.map((f) => `• ${f}`).join("\n")}\n\nAlmost done! ⏰ What time should I drop your daily opportunities?\n\nType in *HH:MM* (24hr), e.g.:\n• 07:00 → 7am\n• 18:00 → 6pm`,
    });
    return;
  }

  if (step === "awaiting_time") {
    const normalizedTime = text.trim().replace(/^(\d):/, "0$1:");
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(normalizedTime)) {
      await sock.sendMessage(sender, {
        text: "⚠️ Please use HH:MM format, e.g. *08:00* or *18:30*",
      });
      return;
    }

    // Save user
    users[sender] = {
      name: session.tmpData.name,
      field: session.tmpData.field,
      deliveryTime: normalizedTime,
      timezone: "Africa/Lagos",
      active: true,
      joinedAt: new Date().toISOString(),
    };
    saveUsers(users);
    delete sessions[sender];

    await sock.sendMessage(sender, {
      text: `✅ You're all set, *${users[sender].name}*!\n\n🤖 Nexopra will deliver opportunities for:\n${users[
        sender
      ].field
        .split(", ")
        .map((f) => `• ${f}`)
        .join(
          "\n",
        )}\n\nDaily at *${users[sender].deliveryTime}*.\n\nCommands you can use anytime:\n• *now* — get today's opportunities instantly\n• *pause* — pause daily updates\n• *resume* — resume updates\n• *update* — change your settings\n• *help* — show all commands\n\nHang tight — great opportunities are coming your way! 🚀`,
    });
    return;
  }
}

// ─────────────────────────────────────────
// MAIN MESSAGE HANDLER
// ─────────────────────────────────────────
async function handleMessage(sock, msg) {
  if (!msg.message) return;
  if (msg.key.fromMe) return; // ignore own messages

  const text = (
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    ""
  ).trim();

  const sender = msg.key.remoteJid;
  const lower = text.toLowerCase();

  if (!text) return;
  const user = users[sender];
  // console.log(`📩 [${sender}]: ${text}`);
  if (sessions[sender]?.step === "awaiting_search_confirm") {
    const query = sessions[sender].pendingQuery;
    delete sessions[sender];

    if (
      lower === "yes" ||
      lower === "y" ||
      lower === "yeah" ||
      lower === "yep"
    ) {
      //   await sock.sendMessage(sender, {
      //     text: `🔍 On it, searching that for you...`,
      //   });
      const aiReply = await askGemini(query, user);
      await sock.sendMessage(sender, { text: aiReply });
    } else {
      await sock.sendMessage(sender, {
        text: `No worries! 😊 Send *help* to see what I can do.`,
      });
    }
    return;
  }
  // ── ONBOARDING IN PROGRESS ──
  if (sessions[sender]) {
    await handleOnboarding(sock, sender, text, sessions[sender]);
    return;
  }

  // ── NEW USER OR GREETINGS ──
  const greetings = [
    // Basic hi
    "hi",
    "hello",
    "hey",
    "heyy",
    "heyyy",
    "heyyyy",
    "hiii",
    "hiiii",
    "helo",
    "helo",
    "hullo",
    "hiya",
    "hiya",
    "hy",
    "hai",
    "hai",
    "haffa",

    // Start/begin
    "start",
    "begin",
    "go",
    "launch",
    "open",
    "run",
    "init",
    "initialize",
    "started",
    "starting",
    "lets go",
    "let's go",
    "let go",
    "letsgo",

    // Hey variations
    "hey there",
    "hey bot",
    "hey nexopra",
    "heya",
    "heyya",
    "hey hey",

    // Hello variations
    "hello there",
    "hello bot",
    "hello nexopra",
    "helloo",
    "hellooo",
    "helloo",
    "hell0",
    "h3llo",
    "helo there",

    // Greetings
    "hola",
    "hola amigo",
    "bonjour",
    "ciao",
    "salut",
    "oi",
    "ola",
    "olá",
    "namaste",
    "salam",
    "salaam",
    "sawubona",
    "howzit",

    // Nigerian/African slangs
    "how far",
    "howfar",
    "how far na",
    "guy",
    "oya",
    "abeg",
    "abeg help me",
    "bros",
    "sis",
    "bro",
    "na me",
    "wetin dey",
    "whats up naija",
    "sup naija",

    // Sup/what's up
    "sup",
    "supp",
    "suppp",
    "whats up",
    "what's up",
    "wassup",
    "wasup",
    "watsup",
    "wazzup",
    "whasup",
    "whaddup",
    "waddup",
    "wdup",
    "sup bro",
    "sup guy",
    "sup fam",

    // Yo
    "yo",
    "yoo",
    "yooo",
    "yo yo",
    "yolo",
    "ayo",
    "ayoo",

    // How are you
    "how are you",
    "how r u",
    "how ru",
    "how are u",
    "how r you",
    "how you doing",
    "how you dey",
    "how are you doing",
    "how do you do",

    // Good morning/afternoon/evening/night
    "good morning",
    "good afternoon",
    "good evening",
    "good night",
    "gm",
    "gn",
    "ga",
    "ge",
    "gud morning",
    "gud afternoon",
    "gud evening",
    "gud night",
    "morning",
    "afternoon",
    "evening",
    "night",
    "mornin",
    "evenin",

    // Punctuation only attempts
    ".",
    "..",
    "...",
    "!",
    "!!",
    "?",
    "??",
    "/",
    "//",

    // Testing
    "test",
    "testing",
    "hello test",
    "test bot",
    "testing bot",
    "check",
    "checking",
    "ping",
    "pong",
    "hello?",
    "anyone there",
    "is this working",
    "is it working",
    "it working",
    "working",

    // Wake up
    "wake up",
    "wake",
    "wakeup",
    "rise",
    "rise and shine",
    "oi wake up",

    // Commands to start
    "menu",
    "main menu",
    "home",
    "back",
    "restart",
    "reset",
    "setup",
    "register",
    "signup",
    "sign up",
    "join",
    "subscribe",
    "onboard",

    // Emojis as starters
    "👋",
    "👋🏾",
    "👋🏿",
    "🙋",
    "🙋🏾",
    "🙋🏿",
    "🖐️",
    "✋",
    "🤚",
    "😊",
    "😁",
    "🔥",
    "🚀",
    "💼",
    "💯",
    "👍",
    "🤝",

    // Numbers accidentally sent
    "1",
    "0",
    "00",
    "000",

    // Name of the bot
    "nexopra",
    "nexpra",
    "nexpora",
    "nexopra bot",
    "hey nexopra",
    "hi nexopra",
    "hello nexopra",
    "nexopra!",

    // Casual conversation starters
    //   "okay", "ok", "k", "kk", "kkk", "cool", "nice", "alright",
    //   "aight", "bet", "sure", "yep", "yeah", "yea", "yes", "no",
    //   "nope", "nah", "lol", "lmao", "haha", "hahaha", "😂", "🤣",

    // Pidgin
    "how body",
    "how body na",
    "i dey",
    "make we start",
    "abeg start",
    "help me",
    "i need help",
    "assist me",

    // Formal
    "good day",
    "greetings",
    "salutations",
    "dear nexopra",
    "to whom it may concern",
    "hi there",
    "hello there",

    // Random things people type
    "ugh",
    "hmm",
    "hm",
    "umm",
    "um",
    "uhh",
    "uh",
    "err",
    "ehh",
    "meh",
    "blah",
    "bla",
    "yo bro",
    "bro hi",
    "fam",
    "g",
    "gee",
  ];
  const greetingsPep = [
    "Hope you're doing okay.",
    "Hope you're good.",
    "Which opportunity are you applying to today?",
    "Got any applications lined up today?",
    "Any hackathons catching your eye lately?",
    "Which role are you shooting for this week?",
    "Have you sent out any applications recently?",
    "Any internship on your radar right now?",
    "Any exciting opportunities you're looking forward to?",
    "Got a goal you're chasing this week?",
  ];

  const randomGreeting =
    greetingsPep[Math.floor(Math.random() * greetingsPep.length)];
  if (!users[sender] || greetings.includes(lower)) {
    if (!users[sender]) {
      sessions[sender] = { step: "awaiting_name", tmpData: {} };
      await sock.sendMessage(sender, {
        text: "👋 Welcome to *Nexopra*!\n\nI'm your personal AI-powered opportunity scout. Every day I'll deliver:\n• 💼 Tech Jobs\n• 🎓 Internships\n• 🏆 Hackathons\n• 🚀 Career Programs\n\n...matched to *your skills*, directly on WhatsApp.\n\nLet's get you set up! What's your *name*? 👇\n\n`Built by Modred · https://modred.dev\`",
      });
    } else {
      await sock.sendMessage(sender, {
        text: `👋 Hey *${users[sender].name}*! ${randomGreeting}\n\nTry:\n• *now* — get today's opportunities\n• *help* — see all commands`,
      });
    }
    return;
  }

  // ── COMMANDS ──

  // NOW — instant delivery
  if (lower === "now" || lower === "more") {
    const loadingMessages = [
      `👀 On it! Scanning for *${user.field}* opportunities... might take a moment ⏳`,
      `🔍 Digging through the internet for you, *${user.name}*... hang tight 🙏`,
      `⚡ Finding the best ones for *${user.field}*... this may take a few secs ⏳`,
      `🤖 On it *${user.name}* 🙌 — give me a moment, searching live...`,
    ];
    const randomLoad =
      loadingMessages[Math.floor(Math.random() * loadingMessages.length)];
    await sock.sendMessage(sender, { text: randomLoad });
    const opps = await fetchOpportunitiesForUser(user);
    const allOpps = opps || [];
    const freshOpps = filterUnseen(sender, allOpps);
    const message = formatOpportunities(
      user.name,
      freshOpps.length > 0 ? freshOpps : allOpps,
      user,
    );

    await sock.sendMessage(sender, { text: message });
    return;
  }
  // DEV
  if (lower === "dev") {
    await sock.sendMessage(sender, {
      text: `👨‍💻 *About the Developer*\n\n🙋 *Modred*\n🌐 Website: modred.dev\n\nNexopra was designed and built by Modred — a developer passionate about building tools that help students and young professionals discover opportunities faster.\n\n_Got feedback or ideas? Reach out at modred.dev_ 💡`,
    });
    return;
  }
  const filterMap = {
    jobs: "Job",
    job: "Job",
    internships: "Internship",
    internship: "Internship",
    hackathons: "Hackathon",
    hackathon: "Hackathon",
    programs: "Program",
    program: "Program",
  };
  if (filterMap[lower]) {
    const filterType = filterMap[lower];
    const loadingMessages = [
      `🔍 Finding *${filterType}* opportunities for you...`,
      `⚡ Scanning for *${filterType}s* right now...`,
      `👀 On it! Looking for *${filterType}s* for *${user.name}*...`,
    ];
    await sock.sendMessage(sender, {
      text: loadingMessages[Math.floor(Math.random() * loadingMessages.length)],
    });
    // FILTER command
    const opps = await fetchOpportunitiesForUser(user, filterType);
    const allOpps = opps || [];
    const freshOpps = filterUnseen(sender, allOpps);
    const message = formatOpportunities(
      user.name,
      freshOpps.length > 0 ? freshOpps : allOpps,
      user,
    );
    await sock.sendMessage(sender, { text: message });
    return;
  }

  // PAUSE
  if (lower === "pause") {
    users[sender].active = false;
    saveUsers(users);
    await sock.sendMessage(sender, {
      text: `⏸️ Daily updates paused, ${user.name}.\nSend *resume* whenever you're ready to continue.`,
    });
    return;
  }

  // RESUME
  if (lower === "resume") {
    users[sender].active = true;
    saveUsers(users);
    await sock.sendMessage(sender, {
      text: `▶️ Daily updates resumed! You'll get your next batch at *${user.deliveryTime}* 🎯`,
    });
    return;
  }

  // UPDATE — restart onboarding
  if (lower === "update") {
    sessions[sender] = { step: "awaiting_name", tmpData: {} };
    await sock.sendMessage(sender, {
      text: `🔄 Let's update your profile!\n\nWhat's your *name*? (or press your current name: ${user.name})`,
    });
    return;
  }

  // STATUS
  if (lower === "status") {
    await sock.sendMessage(sender, {
      text: `📊 *Your Nexopra Profile*\n\n👤 Name: ${user.name}\n🛠 Field: ${user.field}\n⏰ Daily delivery: ${user.deliveryTime}\n📬 Updates: ${user.active ? "Active ✅" : "Paused ⏸️"}\n\nSend *now* to get today's opportunities!`,
    });
    return;
  }

  // HELP
  if (lower === "help") {
    await sock.sendMessage(sender, {
      text: `🤖 *Nexopra Commands*\n\n*now* — Get mixed opportunities\n*jobs* — Jobs only\n*internships* — Internships only\n*hackathons* — Hackathons only\n*programs* — Programs only\n*pause* — Pause daily updates\n*resume* — Resume daily updates\n*status* — View your profile\n*update* — Change your settings\n*dev* — About the developer\n*help* — Show this menu\n\nYou're subscribed as: *${user.name}* (${user.field})\nDaily delivery at: *${user.deliveryTime}*`,
    });
    return;
  }
  // ── SEARCH CONFIRMATION ──

  //   DEFAULT — ask before searching
  const confusedResponses = [
    `Hmm, not sure I got that 🤔`,
    `I didn't quite catch that 😅`,
    `That one went over my head 😄`,
  ];
  const randomConfused =
    confusedResponses[Math.floor(Math.random() * confusedResponses.length)];

  sessions[sender] = { step: "awaiting_search_confirm", pendingQuery: text };

  await sock.sendMessage(sender, {
    text: `${randomConfused}\n\nShould I search the web for *"${text}"*? Reply *yes* or *no* 🔍`,
  });
  //   const aiReply = await askGemini(text, user);
  //   await sock.sendMessage(sender, {
  //     text: `${aiReply}\n\n💡 Type *help* to see all commands.`,
  //   });
}

// ─────────────────────────────────────────
// BOT STARTUP
// ─────────────────────────────────────────
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
      console.log(`🔌 Connection closed. Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startBot();
    }

    if (connection === "open") {
      console.log("✅ Nexopra Bot connected successfully 🚀");
      scheduleDelivery(sock);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    const msg = messages[0];
    try {
      await handleMessage(sock, msg);
    } catch (err) {
      console.error("Handler error:", err);
    }
  });
}

startBot();
