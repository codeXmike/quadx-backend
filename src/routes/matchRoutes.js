const express = require("express");
const { requireAuth, requireRole } = require("../auth/middleware");
const { Match } = require("../models/Match");
const { Report } = require("../models/Report");

const router = express.Router();

router.get("/recent", requireAuth, async (req, res) => {
  const limit = Math.min(25, Math.max(1, Number(req.query.limit || 10)));
  const userId = req.user._id.toString();

  const matches = await Match.find({ "participants.userId": userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return res.status(200).json({
    matches: matches.map((m) => ({
      id: m._id.toString(),
      roomId: m.roomId,
      maxPlayers: m.maxPlayers,
      winnerUsername: m.winnerUsername,
      endedReason: m.endedReason,
      createdAt: m.createdAt,
      participants: m.participants,
      ratingChange: (m.ratingChanges || []).find((c) => c.userId === userId) || null
    }))
  });
});

router.post("/report", requireAuth, async (req, res) => {
  const matchId = String(req.body.matchId || "").trim();
  const reason = String(req.body.reason || "").trim();
  const details = String(req.body.details || "").trim();
  if (!matchId || !reason) {
    return res.status(400).json({ message: "matchId and reason are required" });
  }
  if (reason.length > 80 || details.length > 800) {
    return res.status(400).json({ message: "Report payload too large" });
  }

  const exists = await Match.findById(matchId).lean();
  if (!exists) return res.status(404).json({ message: "Match not found" });

  await Report.create({
    reporterUserId: req.user._id.toString(),
    matchId,
    reason,
    details
  });
  console.warn(`[security] suspicious match report by ${req.user.username} match=${matchId} reason=${reason}`);
  return res.status(201).json({ ok: true });
});

router.get("/reports", requireAuth, requireRole("admin"), async (_req, res) => {
  const reports = await Report.find({}).sort({ createdAt: -1 }).limit(200).lean();
  return res.status(200).json({ reports });
});

module.exports = { matchRoutes: router };
