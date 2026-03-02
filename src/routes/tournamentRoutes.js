const express = require("express");
const { requireAuth } = require("../auth/middleware");
const { Tournament } = require("../models/Tournament");

const router = express.Router();
const APEX_MIN_RATING = 1900;

function swissPair(participants) {
  const sorted = [...participants].sort((a, b) => b.score - a.score || b.buchholz - a.buchholz || a.username.localeCompare(b.username));
  const pairings = [];
  const used = new Set();
  let table = 1;

  for (let i = 0; i < sorted.length; i += 1) {
    if (used.has(sorted[i].userId)) continue;
    let opponentIndex = -1;
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (used.has(sorted[j].userId)) continue;
      if (!sorted[i].opponents.includes(sorted[j].userId)) {
        opponentIndex = j;
        break;
      }
    }
    if (opponentIndex === -1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        if (!used.has(sorted[j].userId)) {
          opponentIndex = j;
          break;
        }
      }
    }

    if (opponentIndex === -1) {
      pairings.push({ table, playerA: sorted[i].userId, playerB: null, result: "bye" });
      used.add(sorted[i].userId);
      table += 1;
      continue;
    }

    pairings.push({
      table,
      playerA: sorted[i].userId,
      playerB: sorted[opponentIndex].userId,
      result: "pending"
    });
    used.add(sorted[i].userId);
    used.add(sorted[opponentIndex].userId);
    table += 1;
  }

  return pairings;
}

function standings(tournament) {
  return [...(tournament.participants || [])]
    .sort((a, b) => b.score - a.score || b.buchholz - a.buchholz || a.username.localeCompare(b.username))
    .map((p, i) => ({
      rank: i + 1,
      userId: p.userId,
      username: p.username,
      score: p.score,
      buchholz: p.buchholz
    }));
}

router.get("/", requireAuth, async (_req, res) => {
  const tournaments = await Tournament.find({}).sort({ createdAt: -1 }).limit(30).lean();
  return res.status(200).json({
    tournaments: tournaments.map((t) => ({
      id: t._id.toString(),
      name: t.name,
      status: t.status,
      players: t.participants.length,
      maxPlayers: t.maxPlayers,
      rounds: t.rounds.length,
      createdAt: t.createdAt
    }))
  });
});

router.post("/", requireAuth, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const maxPlayers = Math.min(64, Math.max(4, Number(req.body.maxPlayers || 16)));
  if (!name) return res.status(400).json({ message: "Tournament name is required" });
  if (Number(req.user?.rating || 0) < APEX_MIN_RATING) {
    return res.status(403).json({ message: "Only Apex and above can create tournaments (1900+ rating required)." });
  }

  const tournament = await Tournament.create({
    name,
    createdBy: req.user._id.toString(),
    status: "open",
    maxPlayers,
    participants: [
      {
        userId: req.user._id.toString(),
        username: req.user.username,
        score: 0,
        buchholz: 0,
        opponents: []
      }
    ]
  });
  return res.status(201).json({ id: tournament._id.toString() });
});

router.post("/:id/join", requireAuth, async (req, res) => {
  const tournament = await Tournament.findById(req.params.id);
  if (!tournament) return res.status(404).json({ message: "Tournament not found" });
  if (tournament.status !== "open") return res.status(400).json({ message: "Tournament is not open" });
  if (tournament.participants.length >= tournament.maxPlayers) return res.status(400).json({ message: "Tournament is full" });
  if (tournament.participants.some((p) => p.userId === req.user._id.toString())) {
    return res.status(409).json({ message: "Already joined" });
  }

  tournament.participants.push({
    userId: req.user._id.toString(),
    username: req.user.username,
    score: 0,
    buchholz: 0,
    opponents: []
  });
  await tournament.save();
  return res.status(200).json({ ok: true });
});

router.post("/:id/start", requireAuth, async (req, res) => {
  const tournament = await Tournament.findById(req.params.id);
  if (!tournament) return res.status(404).json({ message: "Tournament not found" });
  if (tournament.createdBy !== req.user._id.toString()) return res.status(403).json({ message: "Only creator can start" });
  if (tournament.status !== "open") return res.status(400).json({ message: "Tournament already started" });
  if (tournament.participants.length < 4) return res.status(400).json({ message: "Need at least 4 participants" });

  tournament.status = "active";
  tournament.rounds.push({
    number: 1,
    pairings: swissPair(tournament.participants),
    completed: false
  });
  await tournament.save();
  return res.status(200).json({ ok: true });
});

router.patch("/:id/rounds/:roundNumber/report", requireAuth, async (req, res) => {
  const roundNumber = Number(req.params.roundNumber);
  const table = Number(req.body.table);
  const result = String(req.body.result || "").toLowerCase();
  if (!["a", "b", "draw"].includes(result)) return res.status(400).json({ message: "Invalid result" });

  const tournament = await Tournament.findById(req.params.id);
  if (!tournament) return res.status(404).json({ message: "Tournament not found" });
  if (tournament.status !== "active") return res.status(400).json({ message: "Tournament is not active" });

  const round = tournament.rounds.find((r) => r.number === roundNumber);
  if (!round) return res.status(404).json({ message: "Round not found" });
  const pairing = round.pairings.find((p) => p.table === table);
  if (!pairing) return res.status(404).json({ message: "Pairing not found" });
  if (pairing.result !== "pending") return res.status(409).json({ message: "Result already reported" });

  pairing.result = result === "a" ? "A" : result === "b" ? "B" : "draw";
  const pa = tournament.participants.find((p) => p.userId === pairing.playerA);
  const pb = tournament.participants.find((p) => p.userId === pairing.playerB);
  if (pa && pb) {
    pa.opponents.push(pb.userId);
    pb.opponents.push(pa.userId);
    if (pairing.result === "A") pa.score += 1;
    if (pairing.result === "B") pb.score += 1;
    if (pairing.result === "draw") {
      pa.score += 0.5;
      pb.score += 0.5;
    }
  }

  round.completed = round.pairings.every((p) => p.result !== "pending");

  if (round.completed) {
    for (const p of tournament.participants) {
      const opponentScore = p.opponents
        .map((id) => tournament.participants.find((x) => x.userId === id)?.score || 0)
        .reduce((sum, score) => sum + score, 0);
      p.buchholz = opponentScore;
    }

    const maxRounds = Math.max(3, Math.ceil(Math.log2(Math.max(2, tournament.participants.length))));
    if (tournament.rounds.length >= maxRounds) {
      tournament.status = "completed";
    } else {
      tournament.rounds.push({
        number: tournament.rounds.length + 1,
        pairings: swissPair(tournament.participants),
        completed: false
      });
    }
  }

  await tournament.save();
  return res.status(200).json({ ok: true, standings: standings(tournament) });
});

router.get("/:id", requireAuth, async (req, res) => {
  const tournament = await Tournament.findById(req.params.id).lean();
  if (!tournament) return res.status(404).json({ message: "Tournament not found" });

  return res.status(200).json({
    tournament: {
      id: tournament._id.toString(),
      name: tournament.name,
      status: tournament.status,
      maxPlayers: tournament.maxPlayers,
      players: tournament.participants.length,
      rounds: tournament.rounds,
      standings: standings(tournament)
    }
  });
});

module.exports = { tournamentRoutes: router };
