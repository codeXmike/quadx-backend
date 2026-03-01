const express = require("express");
const { requireAuth } = require("../auth/middleware");
const { User } = require("../models/User");
const { Match } = require("../models/Match");

const router = express.Router();

function periodStart(period) {
  const now = new Date();
  if (period === "daily") return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (period === "weekly") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return null;
}

router.get("/leaderboard", requireAuth, async (req, res) => {
  const period = String(req.query.period || "all").toLowerCase();
  const limit = Math.min(100, Math.max(5, Number(req.query.limit || 50)));
  const start = periodStart(period);

  const users = await User.find({})
    .where("provisional").ne(true)
    .sort({ rating: -1, wins: -1 })
    .limit(limit)
    .select("username avatarUrl rating wins losses draws gamesPlayed provisional placementGamesPlayed")
    .lean();

  if (!start) {
    return res.status(200).json({
      period: "all",
      players: users.map((u, i) => ({
        rank: i + 1,
        username: u.username,
        avatarUrl: u.avatarUrl || "",
        rating: u.rating || 1000,
        provisional: Boolean(u.provisional),
        placementGamesPlayed: u.placementGamesPlayed || 0,
        placementTotal: 6,
        wins: u.wins || 0,
        losses: u.losses || 0,
        draws: u.draws || 0,
        gamesPlayed: u.gamesPlayed || 0
      }))
    });
  }

  const matches = await Match.find({ createdAt: { $gte: start } }).select("participants winnerUsername endedReason").lean();
  const bucket = new Map();
  for (const user of users) {
    bucket.set(user.username, { wins: 0, losses: 0, draws: 0, games: 0 });
  }

  for (const match of matches) {
    for (const p of match.participants || []) {
      if (!bucket.has(p.username)) continue;
      const b = bucket.get(p.username);
      b.games += 1;
      if (match.endedReason === "draw") b.draws += 1;
      else if (match.winnerUsername === p.username) b.wins += 1;
      else b.losses += 1;
    }
  }

  return res.status(200).json({
    period,
    players: users.map((u, i) => ({
      rank: i + 1,
      username: u.username,
      avatarUrl: u.avatarUrl || "",
      rating: u.rating || 1000,
      provisional: Boolean(u.provisional),
      placementGamesPlayed: u.placementGamesPlayed || 0,
      placementTotal: 6,
      wins: bucket.get(u.username)?.wins || 0,
      losses: bucket.get(u.username)?.losses || 0,
      draws: bucket.get(u.username)?.draws || 0,
      gamesPlayed: bucket.get(u.username)?.games || 0
    }))
  });
});

router.get("/profile/:username", requireAuth, async (req, res) => {
  const username = String(req.params.username || "").trim();
  const user = await User.findOne({ username: new RegExp(`^${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
  if (!user) return res.status(404).json({ message: "User not found" });

  const matches = await Match.find({ "participants.userId": user._id.toString() })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  return res.status(200).json({
    profile: {
      id: user._id.toString(),
      username: user.username,
      avatarUrl: user.avatarUrl || "",
      rating: user.rating || 1000,
      provisional: Boolean(user.provisional),
      placementGamesPlayed: user.placementGamesPlayed || 0,
      placementTotal: 6,
      totalGames: user.totalGames || 0,
      lastRatingDelta: user.lastRatingDelta || 0,
      wins: user.wins || 0,
      losses: user.losses || 0,
      draws: user.draws || 0,
      gamesPlayed: user.gamesPlayed || 0,
      ratingHistory: (user.ratingHistory || []).slice(-60)
    },
    recentMatches: matches.map((m) => ({
      id: m._id.toString(),
      roomId: m.roomId,
      maxPlayers: m.maxPlayers,
      winnerUsername: m.winnerUsername,
      endedReason: m.endedReason,
      createdAt: m.createdAt,
      ratingChange: (m.ratingChanges || []).find((c) => c.userId === user._id.toString()) || null
    }))
  });
});

module.exports = { ratingRoutes: router };

