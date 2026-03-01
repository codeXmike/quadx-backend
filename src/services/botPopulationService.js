const crypto = require("crypto");
const { User } = require("../models/User");
const { Match } = require("../models/Match");
const { PLAYER_STYLES, DEFAULT_ROWS, DEFAULT_COLS } = require("../game/constants");

const FIRST_NAMES = [
  "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Avery", "Quinn", "Dylan", "Logan",
  "Harper", "Skyler", "Elliot", "Emery", "Dakota", "Parker", "Sawyer", "Rowan", "Finley", "Micah"
];
const LAST_NAMES = [
  "Stone", "Rivers", "Blake", "Frost", "Wilder", "Hunter", "Reed", "Cross", "Lane", "Hart",
  "Knight", "West", "Hayes", "Cole", "Fox", "Shaw", "Cruz", "Bennett", "Hayden", "Sloan"
];
const COUNTRY_CODES = ["US", "GB", "CA", "DE", "FR", "ES", "NL", "SE", "BR", "IN", "JP", "KR", "AU", "MX"];
const BOT_STYLES = ["aggressive", "defensive", "tactical", "balanced"];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(values) {
  return values[randomInt(0, values.length - 1)];
}

function gaussianRandom(mean, stdDev) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * stdDev;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomPastDate(daysMin, daysMax) {
  const days = randomInt(daysMin, daysMax);
  const now = Date.now();
  return new Date(now - days * 24 * 60 * 60 * 1000 - randomInt(0, 24 * 60 * 60 * 1000));
}

function randomRecentDate(hoursMax) {
  const now = Date.now();
  return new Date(now - randomInt(1, Math.max(1, hoursMax)) * 60 * 60 * 1000);
}

function generateBotRating() {
  const roll = Math.random();
  if (roll < 0.05) return randomInt(1800, 2250);
  if (roll < 0.2) return randomInt(1400, 1800);
  if (roll < 0.6) return randomInt(1000, 1400);
  const bell = Math.round(gaussianRandom(930, 80));
  return clamp(bell, 800, 1000);
}

function expectedScore(playerRating, opponentRating) {
  return 1 / (1 + 10 ** ((opponentRating - playerRating) / 400));
}

function stableBotK(totalGames) {
  if (totalGames < 20) return 32;
  if (totalGames < 60) return 24;
  return 18;
}

function weightedPick(items, weightFn) {
  const weighted = items.map((item) => ({ item, w: Math.max(0.01, weightFn(item)) }));
  const total = weighted.reduce((sum, x) => sum + x.w, 0);
  let ticket = Math.random() * total;
  for (const x of weighted) {
    ticket -= x.w;
    if (ticket <= 0) return x.item;
  }
  return weighted[weighted.length - 1].item;
}

function botAvatar(username) {
  return `https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${encodeURIComponent(username)}`;
}

async function createMissingBots(targetCount) {
  const existingUsers = await User.find({}).select("username").lean();
  const usedUsernames = new Set(existingUsers.map((u) => String(u.username || "").toLowerCase()));
  const existingBotCount = await User.countDocuments({ isBot: true });
  const missing = Math.max(0, targetCount - existingBotCount);
  if (!missing) return 0;

  const docs = [];
  for (let i = 0; i < missing; i += 1) {
    let username = "";
    let attempts = 0;
    while (!username || usedUsernames.has(username.toLowerCase())) {
      attempts += 1;
      const suffix = randomInt(10, 9999);
      username = `${randomChoice(FIRST_NAMES)}${randomChoice(LAST_NAMES)}${suffix}`;
      if (attempts > 50) username = `Bot${crypto.randomBytes(3).toString("hex")}`;
    }
    usedUsernames.add(username.toLowerCase());

    const createdAt = randomPastDate(90, 360);
    const rating = generateBotRating();
    const lastActiveAt = randomRecentDate(72);

    docs.push({
      username,
      role: "player",
      authProvider: "email",
      emailVerified: true,
      avatarUrl: botAvatar(username),
      countryCode: randomChoice(COUNTRY_CODES),
      isBot: true,
      botProfile: { style: randomChoice(BOT_STYLES) },
      rating,
      provisional: false,
      placementGamesPlayed: 6,
      totalGames: 0,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      lastRatingDelta: 0,
      ratingLastGameAt: lastActiveAt,
      lastActiveAt,
      createdAt,
      updatedAt: lastActiveAt,
      ratingHistory: [{ rating, delta: 0, at: createdAt }]
    });
  }

  if (docs.length) {
    await User.collection.insertMany(docs, { ordered: false });
  }
  return docs.length;
}

function simulateDuelOutcome(a, b) {
  const drawChance = 0.08;
  const drawRoll = Math.random();
  if (drawRoll < drawChance) return { scoreA: 0.5, scoreB: 0.5, winner: null, endedReason: "draw" };
  const pA = expectedScore(a.rating, b.rating);
  const aWins = Math.random() < pA;
  return {
    scoreA: aWins ? 1 : 0,
    scoreB: aWins ? 0 : 1,
    winner: aWins ? a : b,
    endedReason: "connect_four"
  };
}

function simulateMultiOutcome(players) {
  const winner = weightedPick(players, (p) => Math.max(1, p.rating - 700));
  return { winner, endedReason: "connect_four" };
}

async function seedBotHistory() {
  const bots = await User.find({ isBot: true }).sort({ rating: 1 }).lean();
  if (bots.length < 2) return { matchesCreated: 0, botsUpdated: 0 };

  const historyCount = await Match.countDocuments({ roomId: /^BOTSIM_/ });
  if (historyCount > 0) return { matchesCreated: 0, botsUpdated: 0 };

  const state = new Map();
  const targets = new Map();
  for (const bot of bots) {
    state.set(String(bot._id), {
      id: String(bot._id),
      username: bot.username,
      rating: Number(bot.rating || 1000),
      totalGames: Number(bot.totalGames || 0),
      wins: Number(bot.wins || 0),
      losses: Number(bot.losses || 0),
      draws: Number(bot.draws || 0),
      lastRatingDelta: Number(bot.lastRatingDelta || 0),
      ratingHistory: Array.isArray(bot.ratingHistory) ? [...bot.ratingHistory] : [{ rating: Number(bot.rating || 1000), delta: 0, at: bot.createdAt || new Date() }],
      ratingLastGameAt: bot.ratingLastGameAt || bot.updatedAt || new Date(),
      createdAt: bot.createdAt || new Date()
    });
    targets.set(String(bot._id), randomInt(20, 100));
  }

  const allBots = Array.from(state.values());
  const matches = [];
  let simSafety = 0;
  while (simSafety < 50000) {
    simSafety += 1;
    const remaining = allBots.filter((b) => b.totalGames < targets.get(b.id));
    if (!remaining.length) break;

    const modeRoll = Math.random();
    const mode = modeRoll < 0.7 ? 2 : modeRoll < 0.93 ? 3 : 4;
    const candidates = remaining.length >= mode ? remaining : allBots;
    if (candidates.length < mode) break;

    const picked = [];
    const used = new Set();
    while (picked.length < mode) {
      const p = weightedPick(candidates, (bot) => Math.max(1, targets.get(bot.id) - bot.totalGames + 1));
      if (!used.has(p.id)) {
        used.add(p.id);
        picked.push(p);
      }
      if (used.size >= candidates.length) break;
    }
    if (picked.length < mode) continue;

    const playedAt = randomPastDate(1, 300);
    const participants = picked.map((p, idx) => ({
      userId: p.id,
      username: p.username,
      mark: PLAYER_STYLES[idx]?.mark || String(idx),
      color: PLAYER_STYLES[idx]?.color || "#999999",
      eliminated: false
    }));

    const ratingChanges = [];
    if (mode === 2) {
      const [a, b] = picked;
      const beforeA = a.rating;
      const beforeB = b.rating;
      const out = simulateDuelOutcome(a, b);
      const kA = stableBotK(a.totalGames);
      const kB = stableBotK(b.totalGames);
      const expA = expectedScore(beforeA, beforeB);
      const expB = expectedScore(beforeB, beforeA);
      const deltaA = Math.round(kA * (out.scoreA - expA));
      const deltaB = Math.round(kB * (out.scoreB - expB));

      a.rating = clamp(a.rating + deltaA, 100, 2800);
      b.rating = clamp(b.rating + deltaB, 100, 2800);
      a.totalGames += 1;
      b.totalGames += 1;
      a.lastRatingDelta = deltaA;
      b.lastRatingDelta = deltaB;
      a.ratingLastGameAt = playedAt;
      b.ratingLastGameAt = playedAt;
      a.ratingHistory.push({ rating: a.rating, delta: deltaA, at: playedAt });
      b.ratingHistory.push({ rating: b.rating, delta: deltaB, at: playedAt });

      if (out.scoreA === 1) {
        a.wins += 1;
        b.losses += 1;
      } else if (out.scoreB === 1) {
        b.wins += 1;
        a.losses += 1;
      } else {
        a.draws += 1;
        b.draws += 1;
      }

      ratingChanges.push(
        { userId: a.id, username: a.username, before: beforeA, after: a.rating, delta: deltaA, provisionalBefore: false, provisionalAfter: false, placementGamesPlayedAfter: 6 },
        { userId: b.id, username: b.username, before: beforeB, after: b.rating, delta: deltaB, provisionalBefore: false, provisionalAfter: false, placementGamesPlayedAfter: 6 }
      );

      matches.push({
        roomId: `BOTSIM_${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
        maxPlayers: 2,
        boardRows: DEFAULT_ROWS,
        boardCols: DEFAULT_COLS,
        participants,
        moves: [],
        ratingChanges,
        winnerUsername: out.winner ? out.winner.username : null,
        endedReason: out.endedReason,
        createdAt: playedAt,
        updatedAt: playedAt
      });
      continue;
    }

    const out = simulateMultiOutcome(picked);
    for (const p of picked) {
      const before = p.rating;
      const oppAvg = picked.filter((x) => x.id !== p.id).reduce((sum, x) => sum + x.rating, 0) / (picked.length - 1);
      const expected = expectedScore(before, oppAvg);
      const score = p.id === out.winner.id ? 1 : 0;
      const k = stableBotK(p.totalGames);
      const delta = Math.round(k * (score - expected));
      p.rating = clamp(p.rating + delta, 100, 2800);
      p.totalGames += 1;
      p.lastRatingDelta = delta;
      p.ratingLastGameAt = playedAt;
      p.ratingHistory.push({ rating: p.rating, delta, at: playedAt });
      if (score === 1) p.wins += 1;
      else p.losses += 1;
      ratingChanges.push({
        userId: p.id,
        username: p.username,
        before,
        after: p.rating,
        delta,
        provisionalBefore: false,
        provisionalAfter: false,
        placementGamesPlayedAfter: 6
      });
    }

    matches.push({
      roomId: `BOTSIM_${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
      maxPlayers: mode,
      boardRows: DEFAULT_ROWS,
      boardCols: DEFAULT_COLS,
      participants,
      moves: [],
      ratingChanges,
      winnerUsername: out.winner.username,
      endedReason: out.endedReason,
      createdAt: playedAt,
      updatedAt: playedAt
    });
  }

  if (matches.length) {
    await Match.collection.insertMany(matches, { ordered: false });
  }

  const updates = [];
  for (const bot of allBots) {
    const at = randomRecentDate(72);
    updates.push({
      updateOne: {
        filter: { _id: bot.id },
        update: {
          $set: {
            rating: Math.round(bot.rating),
            totalGames: bot.totalGames,
            gamesPlayed: bot.totalGames,
            wins: bot.wins,
            losses: bot.losses,
            draws: bot.draws,
            lastRatingDelta: bot.lastRatingDelta,
            provisional: false,
            placementGamesPlayed: 6,
            ratingLastGameAt: bot.ratingLastGameAt || at,
            lastActiveAt: at,
            updatedAt: at,
            ratingHistory: bot.ratingHistory.slice(-120)
          }
        }
      }
    });
  }

  if (updates.length) {
    await User.bulkWrite(updates);
  }

  return { matchesCreated: matches.length, botsUpdated: updates.length };
}

async function ensureBotPopulation(options = {}) {
  const targetCount = Number(options.targetCount || 50);
  if (!targetCount || targetCount < 1) return { seeded: 0, historyMatches: 0 };

  const totalUsers = await User.countDocuments({});
  let seeded = 0;
  if (totalUsers < targetCount) {
    seeded = await createMissingBots(targetCount);
  }

  const history = await seedBotHistory();
  return { seeded, historyMatches: history.matchesCreated };
}

module.exports = { ensureBotPopulation };
