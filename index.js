import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import fs from "fs";
import https from "https";
import http from "http";
import "dotenv/config";

// ─────────────────────────────────────────
// PERSISTENT USER STORE
// ─────────────────────────────────────────
const USERS_FILE = "users.json";

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
async function fetchOpportunitiesForUser(user) {
  const currentDate = new Date().toISOString().split("T")[0];
  const prompt = `You are Nexopra, an AI opportunity scout. Today's date is ${currentDate}.

Find 3–5 real, CURRENT opportunities for someone skilled in: ${user.field}.

STRICT RULES:
- Only include opportunities posted in 2025 or later.
- Deadlines must be AFTER ${currentDate}. Never include expired listings.
- No opportunities from 2023 or 2024.
- Include hackathons with prize pools when relevant.
- Prefer remote-friendly roles.
- Use real, plausible apply URLs (e.g. linkedin.com, devpost.com, wellfound.com, unstop.com).
- No duplicates.

Return ONLY a JSON array with this shape (no markdown fences):
[
  {
    "title": "...",
    "type": "Job | Internship | Hackathon | Program",
    "remote": true,
    "deadline": "Month DD, YYYY or null",
    "prize": "$... or null",
    "applyUrl": "https://...",
    "summary": "One sentence description."
  }
]`;

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    });

    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
          const clean = text.replace(/```json|```/g, "").trim();
          const opportunities = JSON.parse(clean);
          resolve(opportunities);
        } catch (e) {
          console.error("Parse error:", e.message);
          resolve(null);
        }
      });
    });

    req.on("error", (e) => {
      console.error("API request error:", e.message);
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}
async function askGemini(userMessage, user) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const currentDate = new Date().toISOString().split("T")[0];

  return new Promise((resolve) => {
    const body = JSON.stringify({
      tools: [{ google_search: {} }],
      contents: [
        {
          parts: [
            {
              text: `You are Nexopra, a friendly AI assistant on WhatsApp helping ${user.name}, a ${user.field} professional/student. Today is ${currentDate}.

The user said: "${userMessage}"

Reply in a conversational, helpful WhatsApp tone — short, clear, no markdown headers. Use emojis naturally. If it's opportunity or career related, search and give current info. If it's a greeting or casual message, respond warmly. Keep it under 200 words.`,
            },
          ],
        },
      ],
    });

    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text =
            parsed.candidates?.[0]?.content?.parts
              ?.filter((p) => p.text)
              .map((p) => p.text)
              .join("") || "I couldn't find anything on that. Try rephrasing!";
          resolve(text.trim());
        } catch (e) {
          console.error("askGemini parse error:", e.message);
          resolve("Hmm, I ran into an issue searching that 😅 Try again!");
        }
      });
    });

    req.on("error", (e) => {
      console.error("askGemini request error:", e.message);
      resolve("I couldn't reach the internet right now 😅 Try again shortly!");
    });

    req.write(body);
    req.end();
  });
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
    msg += `   📍 ${opp.remote ? "Remote" : "On-site"} · ${opp.type}\n`;
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
        // console.log(`📬 Delivering to ${user.name} (${jid})`);
        const opps = await fetchOpportunitiesForUser(user);
        const message = formatOpportunities(user.name, opps, user);
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
      text: `Nice to meet you, *${session.tmpData.name}*! 🙌\n\nWhat's your field or skill? Reply with a *number*:\n\n1️⃣ Frontend Dev\n2️⃣ Backend Dev\n3️⃣ Full Stack Dev\n4️⃣ UI/UX Design\n5️⃣ Mobile Dev\n6️⃣ Data Science / AI\n7️⃣ Cybersecurity\n8️⃣ DevOps / Cloud\n9️⃣ Product Management\n🔟 Blockchain / Web3`,
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

    const picked = fieldMap[text.trim()];
    if (!picked) {
      await sock.sendMessage(sender, {
        text: `⚠️ Please reply with a number from *1 to 10* to pick your field.`,
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
    session.tmpData.field = picked;
    session.step = "awaiting_time";

    await sock.sendMessage(sender, {
      text: `${fieldResponses[picked]}\n\nAlmost done! ⏰ What time should I drop your daily opportunities?\n\nType in *HH:MM* (24hr), e.g.:\n• 07:00 → 7am\n• 18:00 → 6pm`,
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
      text: `✅ You're all set, *${users[sender].name}*!\n\n🤖 Nexopra will deliver *${users[sender].field}* opportunities to you daily at *${users[sender].deliveryTime}*.\n\nCommands you can use anytime:\n• *now* — get today's opportunities instantly\n• *pause* — pause daily updates\n• *resume* — resume updates\n• *update* — change your settings\n• *help* — show all commands\n\nHang tight — great opportunities are coming your way! 🚀`,
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
    "e don do",
    "oya",
    "abeg",
    "abeg help me",
    "bros",
    "sis",
    "bro",
    "na me",
    "i don reach",
    "wetin dey",
    "whats up naija",
    "sup naija",
    "e go better",

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
    "e don do",
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
  if (lower === "now") {
    const loadingMessages = [
      `👀 On it! Scanning for *${user.field}* opportunities...`,
      `🔍 Digging through the internet for you, *${user.name}*...`,
      `⚡ Give me a sec — finding the best ones for *${user.field}*...`,
      `🤖 Searching... I got you *${user.name}* 🙌`,
    ];
    const randomLoad =
      loadingMessages[Math.floor(Math.random() * loadingMessages.length)];

    await sock.sendMessage(sender, { text: randomLoad });
    const opps = await fetchOpportunitiesForUser(user);
    const message = formatOpportunities(user.name, opps, user);
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
      text: `🤖 *Nexopra Commands*\n\n*now* — Get today's opportunities instantly\n*pause* — Pause daily updates\n*resume* — Resume daily updates\n*status* — View your profile\n*update* — Change your settings\n*dev* — About the developer\n*help* — Show this menu\n\nYou're subscribed as: *${user.name}* (${user.field})\nDaily delivery at: *${user.deliveryTime}*`,
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
