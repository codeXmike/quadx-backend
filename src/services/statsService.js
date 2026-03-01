const { Match } = require("../models/Match");
const { User } = require("../models/User");

const BASELINE_RATING = 1000;
const PROVISIONAL_GAMES = 6;
const PROVISIONAL_K_SCHEDULE = [220, 190, 160, 140, 120, 100];
const CERTAINTY_GAMES_TARGET = 40;
const INACTIVITY_FULL_DAYS = 90;
const ESTABLISHED_K_MIN = 16;
const ESTABLISHED_K_MAX = 40;
const MAX_ESTABLISHED_DELTA = 45;

function modeRatingMultiplier(maxPlayers) {
  const mode = Number(maxPlayers || 2);
  if (mode >= 4) return 1.35;
  if (mode === 3) return 1.2;
  return 1;
}

function expectedScore(playerRating, opponentRating) {
  return 1 / (1 + 10 ** ((opponentRating - playerRating) / 400));
}

function clampRating(value) {
  return Math.max(100, Math.round(value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function daysSince(date, now = new Date()) {
  if (!date) return INACTIVITY_FULL_DAYS;
  const diff = now.getTime() - new Date(date).getTime();
  return Math.max(0, diff / (24 * 60 * 60 * 1000));
}

function scoreForParticipant(room, participant) {
  if (room.endedReason === "draw") return 0.5;

  const winnerUsername = room.winner?.username;
  if (winnerUsername && participant.username === winnerUsername) return 1;

  if (room.maxPlayers <= 2) return 0;

  // Multiplayer: active non-winners count as mid placement.
  return participant.eliminated ? 0 : 0.5;
}

function uncertaintyForUser(user, now = new Date()) {
  if (user.provisional) return 1;

  const games = Number(user.totalGames || 0);
  const gamesUncertainty = 1 - clamp(games / CERTAINTY_GAMES_TARGET, 0, 1);
  const inactivity = clamp(daysSince(user.ratingLastGameAt || user.updatedAt || user.createdAt, now) / INACTIVITY_FULL_DAYS, 0, 1);

  return clamp(gamesUncertainty * 0.65 + inactivity * 0.55, 0.05, 1);
}

function opponentReliability(opponent, now = new Date()) {
  const uncertainty = uncertaintyForUser(opponent, now);
  return clamp(1 - uncertainty * 0.9, 0.1, 1);
}

function effectiveOpponentRating(opponent, now = new Date()) {
  const rating = Number(opponent.rating || BASELINE_RATING);
  const reliability = opponentReliability(opponent, now);
  // Uncertain opponents are pulled closer to baseline so they affect rating less.
  return BASELINE_RATING + (rating - BASELINE_RATING) * reliability;
}

function baseKForUser(user, now = new Date()) {
  if (user.provisional) {
    const gameNo = Math.min(PROVISIONAL_GAMES, Math.max(1, Number(user.placementGamesPlayed || 0) + 1));
    return PROVISIONAL_K_SCHEDULE[gameNo - 1];
  }

  const uncertainty = uncertaintyForUser(user, now);
  const inactivity = clamp(daysSince(user.ratingLastGameAt || user.updatedAt || user.createdAt, now) / INACTIVITY_FULL_DAYS, 0, 1);
  const k = ESTABLISHED_K_MIN + uncertainty * 16 + inactivity * 8;
  return Math.round(clamp(k, ESTABLISHED_K_MIN, ESTABLISHED_K_MAX));
}

function adjustedKForMatchup(user, opponents, now = new Date()) {
  const baseK = baseKForUser(user, now);
  if (!opponents.length) return baseK;

  const reliabilityAvg = opponents
    .map((op) => opponentReliability(op, now))
    .reduce((sum, value) => sum + value, 0) / opponents.length;

  const multiplier = user.provisional
    ? 0.7 + reliabilityAvg * 0.3
    : 0.35 + reliabilityAvg * 0.65;

  let k = Math.round(baseK * multiplier);
  if (!user.provisional) {
    if (reliabilityAvg < 0.35) k = Math.min(k, 10);
    if (reliabilityAvg < 0.2) k = Math.min(k, 8);
  }
  return clamp(k, 6, 240);
}

function updateSandbaggingFlags(user, score, opponentAvg, expected) {
  const myRating = Number(user.rating || BASELINE_RATING);
  const suspiciousLoss = score === 0 && (myRating - opponentAvg) >= 250 && expected >= 0.7;

  if (suspiciousLoss) {
    user.sandbaggingFlags = Math.min(10, Number(user.sandbaggingFlags || 0) + 1);
  } else {
    user.sandbaggingFlags = Math.max(0, Number(user.sandbaggingFlags || 0) - 1);
  }
}

function applyResultCounters(user, score) {
  if (score === 1) user.wins = (user.wins || 0) + 1;
  else if (score === 0) user.losses = (user.losses || 0) + 1;
  else user.draws = (user.draws || 0) + 1;
}

async function recordMatch(room, options = {}) {
  const applyRating = options.applyRating !== false;
  if (!room || room.status !== "completed") return null;
  console.info(`[match] recording room=${room.id} endedReason=${room.endedReason}`);

  const participants = room.players.map((p) => ({
    userId: p.userId || null,
    username: p.username,
    mark: p.mark,
    color: p.color,
    eliminated: p.eliminated
  }));

  const userIds = participants.map((p) => p.userId).filter(Boolean);
  const users = applyRating ? await User.find({ _id: { $in: userIds } }) : [];
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const now = new Date();

  const changes = [];
  const ratingMultiplier = modeRatingMultiplier(room.maxPlayers);
  for (const p of participants) {
    if (!applyRating) break;
    const user = userById.get(String(p.userId));
    if (!user) continue;

    const provisionalBefore = Boolean(user.provisional);
    const before = Number(user.rating || BASELINE_RATING);
    const score = scoreForParticipant(room, p);

    const opponents = participants
      .filter((op) => String(op.userId) !== String(p.userId))
      .map((op) => userById.get(String(op.userId)))
      .filter(Boolean);

    const effectiveOppRatings = opponents.map((op) => effectiveOpponentRating(op, now));
    const opponentAvg = effectiveOppRatings.length
      ? effectiveOppRatings.reduce((sum, r) => sum + r, 0) / effectiveOppRatings.length
      : BASELINE_RATING;

    const expected = expectedScore(before, opponentAvg);
    const k = adjustedKForMatchup(user, opponents, now);

    let delta = Math.round(k * (score - expected) * ratingMultiplier);

    if (!user.provisional) {
      const establishedCap = Math.round(MAX_ESTABLISHED_DELTA * ratingMultiplier);
      delta = clamp(delta, -establishedCap, establishedCap);
      const reliabilityAvg = opponents.length
        ? opponents.map((op) => opponentReliability(op, now)).reduce((sum, value) => sum + value, 0) / opponents.length
        : 1;
      if (reliabilityAvg < 0.35) delta = clamp(delta, -Math.round(5 * ratingMultiplier), Math.round(5 * ratingMultiplier));
      else if (reliabilityAvg < 0.55) delta = clamp(delta, -Math.round(12 * ratingMultiplier), Math.round(12 * ratingMultiplier));
    }

    // If repeated suspicious heavy losses vs much lower opposition, damp losses.
    if (!user.provisional && Number(user.sandbaggingFlags || 0) >= 3 && delta < 0) {
      delta = Math.max(delta, -8);
    }

    const after = clampRating(before + delta);

    user.rating = after;
    user.lastRatingDelta = after - before;
    user.gamesPlayed = (user.gamesPlayed || 0) + 1;
    user.totalGames = (user.totalGames || 0) + 1;
    user.ratingLastGameAt = now;

    applyResultCounters(user, score);
    updateSandbaggingFlags(user, score, opponentAvg, expected);

    if (user.provisional) {
      user.placementGamesPlayed = (user.placementGamesPlayed || 0) + 1;
      if (user.placementGamesPlayed >= PROVISIONAL_GAMES) {
        user.provisional = false;
      }
    }

    user.ratingHistory.push({ rating: after, delta: user.lastRatingDelta, at: now });
    await user.save();

    changes.push({
      userId: user._id.toString(),
      username: user.username,
      before,
      after,
      delta: user.lastRatingDelta,
      provisionalBefore,
      provisionalAfter: user.provisional,
      placementGamesPlayedAfter: user.placementGamesPlayed || 0
    });
    console.info(`[rating] user=${user.username} before=${before} after=${after} delta=${user.lastRatingDelta} provisional=${user.provisional}`);
  }

  const match = await Match.create({
    roomId: room.id,
    maxPlayers: room.maxPlayers,
    boardRows: room.board.length,
    boardCols: room.board[0].length,
    participants,
    moves: room.moves,
    ratingChanges: changes,
    winnerUsername: room.winner?.username || null,
    endedReason: room.endedReason || "unknown"
  });

  return match;
}

module.exports = { recordMatch, expectedScore };
