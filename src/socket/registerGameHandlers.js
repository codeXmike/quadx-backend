const crypto = require("crypto");
const { recordMatch } = require("../services/statsService");
const { User } = require("../models/User");
const { dropSeed, hasConnectFour } = require("../game/board");
const { env } = require("../config/env");

function registerGameHandlers(io, roomManager) {
  const onlineUsers = new Map();
  const queues = { 2: [], 3: [], 4: [] };
  const CLOCK_SYNC_INTERVAL_MS = 500;
  const MATCHMAKING_TICK_MS = 1000;
  const BOT_TURN_TICK_MS = 250;
  const BOT_DIFFICULTY_BOOST = 3.0;
  const EVENT_WINDOW_MS = 5000;
  const EVENT_LIMIT_DEFAULT = 40;
  const botIds = new Set();
  let botPool = [];
  let populationMetrics = { totalUsers: 1, humanUsers: 1, activeHumans: 0 };
  const recentBotOpponents = new Map();
  const pendingBotTurns = new Map();

  function parseTimeControl(value, fallback = 120) {
    if (value === null || value === "" || String(value).toLowerCase?.() === "unlimited") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed <= 0) return null;
    return Math.min(120, Math.max(30, Math.floor(parsed)));
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function nowMs() {
    return Date.now();
  }

  function activeHumanCount() {
    let count = 0;
    for (const [userId] of onlineUsers.entries()) {
      if (!botIds.has(String(userId))) count += 1;
    }
    return count;
  }

  function queuePopulationCount() {
    return queues[2].length + queues[3].length + queues[4].length;
  }

  function ongoingMatchCount() {
    return roomManager.listLiveRooms().length;
  }

  async function refreshBotPool() {
    const bots = await User.find({ isBot: true })
      .select("_id username rating provisional placementGamesPlayed countryCode lastActiveAt botProfile")
      .lean();
    botPool = bots.map((b) => ({
      id: String(b._id),
      username: b.username,
      rating: Number(b.rating || 1000),
      provisional: Boolean(b.provisional),
      placementGamesPlayed: Number(b.placementGamesPlayed || 0),
      countryCode: b.countryCode || "US",
      style: b.botProfile?.style || "balanced",
      lastActiveAt: b.lastActiveAt || new Date(0)
    }));
    botIds.clear();
    botPool.forEach((b) => botIds.add(b.id));
  }

  async function refreshPopulationMetrics() {
    const [totalUsers, humanUsers] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ isBot: { $ne: true } })
    ]);
    populationMetrics = {
      totalUsers: Math.max(1, totalUsers),
      humanUsers: Math.max(1, humanUsers),
      activeHumans: activeHumanCount()
    };
  }

  function botInjectionWaitMs() {
    const ratio = populationMetrics.activeHumans / Math.max(1, populationMetrics.humanUsers);
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const minWait = Math.max(1, Number(env.botMatchMinWaitSec || 10));
    const maxWait = Math.max(minWait, Number(env.botMatchMaxWaitSec || 40));
    const baseWait = Math.max(minWait, Math.min(maxWait, Number(env.botBaseWaitSec || 20)));
    const waitSec = clampedRatio <= 0.5
      ? minWait + (baseWait - minWait) * (clampedRatio / 0.5)
      : baseWait + (maxWait - baseWait) * ((clampedRatio - 0.5) / 0.5);
    return Math.max(env.botMatchMinWaitSec * 1000, Math.min(env.botMatchMaxWaitSec * 1000, waitSec * 1000));
  }

  function rememberBotOpponent(humanId, botId) {
    const key = String(humanId);
    const recent = recentBotOpponents.get(key) || [];
    const next = [...recent.filter((v) => v !== botId), botId].slice(-5);
    recentBotOpponents.set(key, next);
  }

  function pickBotsForEntry(entry, needed) {
    const usedBots = new Set();
    const recent = new Set(recentBotOpponents.get(String(entry.userId)) || []);
    const candidates = botPool
      .filter((b) => !usedBots.has(b.id))
      .sort((a, b) => Math.abs(a.rating - entry.rating) - Math.abs(b.rating - entry.rating));

    const picks = [];
    for (const b of candidates) {
      if (picks.length >= needed) break;
      if (recent.has(b.id) && candidates.length > needed + 2) continue;
      picks.push(b);
      usedBots.add(b.id);
    }

    if (picks.length < needed) {
      for (const b of candidates) {
        if (picks.length >= needed) break;
        if (usedBots.has(b.id)) continue;
        picks.push(b);
        usedBots.add(b.id);
      }
    }

    return picks.slice(0, needed);
  }

  function botSocketId(botId) {
    return `bot:${botId}:${crypto.randomBytes(2).toString("hex")}`;
  }

  function estimateBotDifficulty(rating) {
    if (rating >= 1800) return { minDelay: 900, maxDelay: 2400, blunderRate: 0.05, extraThinkChance: 0.18, extraThinkMax: 1600 };
    if (rating >= 1400) return { minDelay: 1100, maxDelay: 2800, blunderRate: 0.12, extraThinkChance: 0.22, extraThinkMax: 1800 };
    if (rating >= 1000) return { minDelay: 1300, maxDelay: 3200, blunderRate: 0.22, extraThinkChance: 0.28, extraThinkMax: 2100 };
    return { minDelay: 1500, maxDelay: 3600, blunderRate: 0.35, extraThinkChance: 0.34, extraThinkMax: 2500 };
  }

  function boostBotDifficulty(diff) {
    const factor = Math.max(1, Number(BOT_DIFFICULTY_BOOST) || 1);
    return {
      minDelay: Math.max(250, Math.round(diff.minDelay / factor)),
      maxDelay: Math.max(500, Math.round(diff.maxDelay / factor)),
      blunderRate: Math.max(0.01, Math.min(1, diff.blunderRate / factor)),
      extraThinkChance: Math.max(0.02, Math.min(1, diff.extraThinkChance / factor)),
      extraThinkMax: Math.max(300, Math.round(diff.extraThinkMax / factor))
    };
  }

  function legalColumns(board) {
    if (!Array.isArray(board) || !board.length || !Array.isArray(board[0])) return [];
    const cols = board[0].length;
    const out = [];
    for (let c = 0; c < cols; c += 1) {
      if (!board[0][c]) out.push(c);
    }
    return out;
  }

  function cloneBoard(board) {
    return board.map((row) => [...row]);
  }

  function chooseBotColumn(room, botPlayer, botProfile) {
    const cols = legalColumns(room.board);
    if (!cols.length) return null;

    const difficulty = boostBotDifficulty(estimateBotDifficulty(botProfile.rating || 1000));
    const board = room.board;

    for (const col of cols) {
      const copy = cloneBoard(board);
      try {
        const drop = dropSeed(copy, col, botPlayer.mark);
        if (hasConnectFour(copy, drop.row, drop.col, botPlayer.mark)) return col;
      } catch (_error) {}
    }

    const nextPlayer = room.players.find((p) => p.socketId !== botPlayer.socketId && !p.eliminated && p.connected);
    if (nextPlayer) {
      for (const col of cols) {
        const copy = cloneBoard(board);
        try {
          const drop = dropSeed(copy, col, nextPlayer.mark);
          if (hasConnectFour(copy, drop.row, drop.col, nextPlayer.mark)) return col;
        } catch (_error) {}
      }
    }

    const center = Math.floor(cols.length / 2);
    const scored = cols.map((col) => {
      const centerBias = Math.abs(center - col);
      const noise = Math.random() * 2;
      return { col, score: centerBias + noise };
    }).sort((a, b) => a.score - b.score);

    const makeBlunder = Math.random() < difficulty.blunderRate;
    if (makeBlunder) return cols[randomInt(0, cols.length - 1)];
    return scored[0].col;
  }

  function canEmitEvent(socket, name, limit = EVENT_LIMIT_DEFAULT, windowMs = EVENT_WINDOW_MS) {
    const now = Date.now();
    if (!socket.data.eventWindows) socket.data.eventWindows = new Map();
    const prev = socket.data.eventWindows.get(name) || [];
    const kept = prev.filter((ts) => now - ts <= windowMs);
    kept.push(now);
    socket.data.eventWindows.set(name, kept);
    return kept.length <= limit;
  }

  function enforceEventRate(socket, eventName, limit, windowMs) {
    if (canEmitEvent(socket, eventName, limit, windowMs)) return true;
    socket.emit("error:event", { message: "Too many requests. Slow down." });
    return false;
  }

  function hasRoomAccess(room, socket) {
    if (!room) return false;
    if (socket.data.user?.role === "admin") return true;
    const uid = String(socket.data.user?.id || "");
    const inPlayers = room.players.some((p) => String(p.userId || "") === uid);
    if (inPlayers) return true;
    for (const spectator of room.spectators.values()) {
      if (String(spectator.userId || "") === uid) return true;
    }
    return false;
  }

  function emitRoom(room) {
    if (!room) return;
    io.to(room.id).emit("room:state", roomManager.serializeRoom(room));
  }

  function clearSocketSpectating(socket) {
    const spectatorRoom = roomManager.removeSpectator(socket.id);
    if (!spectatorRoom) return;
    socket.leave(spectatorRoom.id);
    emitRoom(spectatorRoom);
  }

  function activePlayerRoomForSocketUser(socket) {
    return roomManager.getLivePlayerRoomByUserId(socket.data.user?.id);
  }

  async function closeMatchIfNeeded(room) {
    if (!room || room.status !== "completed" || room.matchRecorded) return;
    const applyRating = env.botMatchesAffectRating || !room.isBotMatch;
    await recordMatch(room, { applyRating });
    room.matchRecorded = true;
    io.to(room.id).emit("game:over", {
      roomId: room.id,
      winner: room.winner,
      endedReason: room.endedReason
    });
  }

  function setOnline(userId, socketId, connected) {
    if (!userId) return;
    if (connected) {
      const set = onlineUsers.get(userId) || new Set();
      set.add(socketId);
      onlineUsers.set(userId, set);
      User.updateOne({ _id: userId }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
      return;
    }
    const set = onlineUsers.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (!set.size) onlineUsers.delete(userId);
  }

  function removeFromQueues(socketId) {
    for (const key of Object.keys(queues)) {
      queues[key] = queues[key].filter((x) => x.socketId !== socketId);
    }
  }

  function emitQueueStatus(size) {
    const entries = queues[size] || [];
    entries.forEach((entry, index) => {
      io.to(entry.socketId).emit("queue:status", {
        modeSize: Number(size),
        position: index + 1,
        waiting: entries.length,
        required: Number(size),
        queuePopulation: queuePopulationCount(),
        activePlayers: activeHumanCount(),
        ongoingMatches: ongoingMatchCount()
      });
    });
  }

  function placementOffsetForGame(gameNumber) {
    const roll = Math.floor(Math.random() * 321) - 160;
    if (gameNumber === 1) return 0;
    if (gameNumber === 2) return 120;
    if (gameNumber === 3) return -120;
    if (gameNumber === 4) return 240;
    return roll;
  }

  function takeDuelBatch(entries) {
    if (entries.length < 2) return null;

    const provisionalIndex = entries.findIndex((e) => e.provisional);
    if (provisionalIndex < 0) return [entries.shift(), entries.shift()];

    const seed = entries.splice(provisionalIndex, 1)[0];
    const gameNo = Math.min(6, Number(seed.placementGamesPlayed || 0) + 1);
    const target = Number(seed.rating || 1000) + placementOffsetForGame(gameNo);

    let bestIdx = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < entries.length; i += 1) {
      const candidate = entries[i];
      const candidateRating = Number(candidate.rating || 1000);
      const diffToTarget = Math.abs(candidateRating - target);
      const provisionalPenalty = seed.provisional === candidate.provisional ? 0 : 60;
      const queueAgePenalty = i * 5;
      const score = diffToTarget + provisionalPenalty + queueAgePenalty;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    const opponent = entries.splice(bestIdx, 1)[0];
    return [seed, opponent];
  }

  function tryMatch(size) {
    const targetSize = Number(size);
    if (![2, 3, 4].includes(targetSize)) return;
    queues[targetSize] = queues[targetSize].filter((entry) => io.sockets.sockets.has(entry.socketId));

    while (queues[targetSize].length >= targetSize) {
      const batch = targetSize === 2
        ? takeDuelBatch(queues[targetSize])
        : queues[targetSize].splice(0, targetSize);
      if (!batch || batch.length < targetSize) break;
      const host = batch[0];
      const hostSocket = io.sockets.sockets.get(host.socketId);
      if (!hostSocket) continue;

      let room;
      try {
        clearSocketSpectating(hostSocket);
        room = roomManager.createRoom({
          hostSocketId: host.socketId,
          hostUserId: host.userId,
          hostUsername: host.username,
          hostRating: host.rating,
          maxPlayers: targetSize,
          timeControlSec: host.timeControlSec
        });
        hostSocket.join(room.id);

        for (let i = 1; i < batch.length; i += 1) {
          const player = batch[i];
          const playerSocket = io.sockets.sockets.get(player.socketId);
          if (!playerSocket) continue;
          clearSocketSpectating(playerSocket);
          room = roomManager.joinRoom({
            roomId: room.id,
            socketId: player.socketId,
            userId: player.userId,
            username: player.username,
            rating: player.rating
          });
          playerSocket.join(room.id);
        }

        batch.forEach((entry) => io.to(entry.socketId).emit("queue:matched", { roomId: room.id, modeSize: targetSize }));
        emitRoom(room);
      } catch (error) {
        batch.forEach((entry) => io.to(entry.socketId).emit("error:event", { message: error.message || "Matchmaking failed" }));
      }
    }
    emitQueueStatus(targetSize);
  }

  function createBotFilledMatch(targetSize, humans, bots) {
    const host = humans[0];
    const hostSocket = io.sockets.sockets.get(host.socketId);
    if (!hostSocket) return null;

    clearSocketSpectating(hostSocket);
    let room = roomManager.createRoom({
      hostSocketId: host.socketId,
      hostUserId: host.userId,
      hostUsername: host.username,
      hostRating: host.rating,
      maxPlayers: targetSize,
      timeControlSec: host.timeControlSec
    });
    hostSocket.join(room.id);

    for (let i = 1; i < humans.length; i += 1) {
      const human = humans[i];
      const playerSocket = io.sockets.sockets.get(human.socketId);
      if (!playerSocket) continue;
      clearSocketSpectating(playerSocket);
      room = roomManager.joinRoom({
        roomId: room.id,
        socketId: human.socketId,
        userId: human.userId,
        username: human.username,
        rating: human.rating
      });
      playerSocket.join(room.id);
    }

    for (const bot of bots) {
      room = roomManager.joinRoom({
        roomId: room.id,
        socketId: botSocketId(bot.id),
        userId: bot.id,
        username: bot.username,
        rating: bot.rating
      });
      for (const human of humans) rememberBotOpponent(human.userId, bot.id);
    }

    room.isBotMatch = true;
    humans.forEach((human) => {
      io.to(human.socketId).emit("queue:matched", { roomId: room.id, modeSize: targetSize });
    });
    emitRoom(room);
    return room;
  }

  function tryInjectBots(size) {
    const targetSize = Number(size);
    const waitMs = botInjectionWaitMs();
    const snapshot = [...queues[targetSize]];
    for (const entry of snapshot) {
      const hostSocket = io.sockets.sockets.get(entry.socketId);
      if (!hostSocket) continue;
      const waited = nowMs() - Number(entry.enqueueAt || nowMs());
      if (waited < waitMs) continue;

      const others = queues[targetSize]
        .filter((candidate) => candidate.socketId !== entry.socketId && io.sockets.sockets.has(candidate.socketId))
        .sort((a, b) => Math.abs(a.rating - entry.rating) - Math.abs(b.rating - entry.rating));
      const humanBatch = [entry, ...others.slice(0, Math.max(0, targetSize - 1))];
      const needed = Math.max(0, targetSize - humanBatch.length);
      const bots = needed ? pickBotsForEntry(entry, needed) : [];
      if (bots.length < needed) continue;

      const removeIds = new Set(humanBatch.map((h) => h.socketId));
      queues[targetSize] = queues[targetSize].filter((h) => !removeIds.has(h.socketId));
      try {
        createBotFilledMatch(targetSize, humanBatch, bots);
        break;
      } catch (error) {
        humanBatch.forEach((human) => {
          io.to(human.socketId).emit("error:event", { message: error.message || "Bot matchmaking failed" });
        });
      }
    }
    emitQueueStatus(targetSize);
  }

  setInterval(async () => {
    const now = Date.now();
    const impacted = roomManager.tick(now);
    const impactedRoomIds = new Set();
    for (const item of impacted) {
      impactedRoomIds.add(item.room.id);
      if (item.reason === "turn_timeout" || item.reason === "timeout_end") {
        io.to(item.room.id).emit("turn:timeout", { roomId: item.room.id, player: item.player });
      }
      emitRoom(item.room);
      await closeMatchIfNeeded(item.room);
    }

    for (const room of roomManager.listRoomsWithActiveClock()) {
      if (impactedRoomIds.has(room.id)) continue;
      emitRoom(room);
    }
  }, CLOCK_SYNC_INTERVAL_MS);

  refreshBotPool().catch((error) => {
    console.warn("[bot-matchmaking] bot pool init failed:", error.message);
  });
  refreshPopulationMetrics().catch((error) => {
    console.warn("[bot-matchmaking] population metrics init failed:", error.message);
  });

  setInterval(async () => {
    queues[2] = queues[2].filter((entry) => io.sockets.sockets.has(entry.socketId));
    queues[3] = queues[3].filter((entry) => io.sockets.sockets.has(entry.socketId));
    queues[4] = queues[4].filter((entry) => io.sockets.sockets.has(entry.socketId));

    tryMatch(2);
    tryMatch(3);
    tryMatch(4);

    tryInjectBots(2);
    tryInjectBots(3);
    tryInjectBots(4);

    if (Math.random() < 0.25) {
      await refreshPopulationMetrics();
    }
    if (Math.random() < 0.08) {
      await refreshBotPool();
    }
  }, MATCHMAKING_TICK_MS);

  setInterval(async () => {
    const now = nowMs();
    const liveRooms = Array.from(roomManager.rooms.values()).filter((r) => r.status === "in_progress");
    for (const room of liveRooms) {
      if (room.status !== "in_progress") continue;
      const current = roomManager.currentPlayer(room);
      if (!current) continue;
      const botId = String(current.userId || "");
      if (!botId || !botIds.has(botId)) continue;

      const pendingKey = `${room.id}:${current.socketId}`;
      const plannedAt = pendingBotTurns.get(pendingKey);
      if (plannedAt && plannedAt > now) continue;

      const botProfile = botPool.find((b) => b.id === botId) || { rating: 1000, style: "balanced" };
      const diff = boostBotDifficulty(estimateBotDifficulty(botProfile.rating || 1000));
      if (!plannedAt) {
        let delay = randomInt(diff.minDelay, diff.maxDelay);
        if (Math.random() < diff.extraThinkChance) {
          delay += randomInt(250, diff.extraThinkMax);
        }
        pendingBotTurns.set(pendingKey, now + delay);
        continue;
      }

      const col = chooseBotColumn(room, current, botProfile);
      pendingBotTurns.delete(pendingKey);
      if (col == null) continue;
      try {
        const { room: nextRoom, move } = roomManager.dropMove({ roomId: room.id, socketId: current.socketId, column: col });
        io.to(room.id).emit("move:accepted", {
          roomId: room.id,
          move
        });
        emitRoom(nextRoom);
        await closeMatchIfNeeded(nextRoom);
      } catch (_error) {
        // Ignore transient bot move errors (room state may have changed).
      }
    }
  }, BOT_TURN_TICK_MS);

  io.on("connection", (socket) => {
    console.info(`[socket] connected user=${socket.data.user?.username} id=${socket.id}`);
    setOnline(socket.data.user?.id, socket.id, true);
    const recoveredRooms = roomManager.reconnectUserSocket({
      userId: socket.data.user?.id,
      socketId: socket.id
    });
    for (const room of recoveredRooms) {
      socket.join(room.id);
      socket.emit("room:reconnected", { roomId: room.id });
      emitRoom(room);
    }

    socket.on("rooms:live", () => {
      if (!enforceEventRate(socket, "rooms:live", 20, 5000)) return;
      socket.emit("rooms:live", {
        rooms: roomManager.listLiveRooms(),
        activePlayers: activeHumanCount(),
        queuePopulation: queuePopulationCount(),
        ongoingMatches: ongoingMatchCount()
      });
    });

    socket.on("room:spectate", (payload = {}) => {
      if (!enforceEventRate(socket, "room:spectate", 12, 5000)) return;
      try {
        if (!payload.roomId || typeof payload.roomId !== "string") throw new Error("Invalid room id");
        const activeRoom = activePlayerRoomForSocketUser(socket);
        if (activeRoom && activeRoom.id !== String(payload.roomId || "").trim().toUpperCase()) {
          throw new Error(`You are already in active room ${activeRoom.id}. Rejoin it first.`);
        }
        clearSocketSpectating(socket);
        const room = roomManager.addSpectator({
          roomId: payload.roomId,
          socketId: socket.id,
          userId: socket.data.user?.id,
          username: socket.data.user?.username
        });
        socket.join(room.id);
        socket.emit("room:spectating", { roomId: room.id });
        emitRoom(room);
      } catch (error) {
        socket.emit("error:event", { message: error.message });
      }
    });

    socket.on("room:create", (payload = {}) => {
      if (!enforceEventRate(socket, "room:create", 8, 10000)) return;
      try {
        removeFromQueues(socket.id);
        const username = socket.data.user?.username;
        const userId = socket.data.user?.id;
        if (!username || !userId) throw new Error("Unauthorized socket");
        const activeRoom = activePlayerRoomForSocketUser(socket);
        if (activeRoom) {
          socket.join(activeRoom.id);
          socket.emit("error:event", { message: `You are already in room ${activeRoom.id}. Rejoin that game until it ends.` });
          socket.emit("room:state", roomManager.serializeRoom(activeRoom));
          return;
        }
        clearSocketSpectating(socket);
        const room = roomManager.createRoom({
          hostSocketId: socket.id,
          hostUserId: userId,
          hostUsername: username,
          hostRating: socket.data.user?.rating,
          maxPlayers: payload.maxPlayers,
          timeControlSec: parseTimeControl(payload.timeControlSec, 120)
        });
        socket.join(room.id);
        socket.emit("room:created", { roomId: room.id });
        emitRoom(room);
      } catch (error) {
        socket.emit("error:event", { message: error.message });
      }
    });

    socket.on("room:join", (payload = {}) => {
      if (!enforceEventRate(socket, "room:join", 12, 10000)) return;
      try {
        if (!payload.roomId || typeof payload.roomId !== "string") throw new Error("Invalid room id");
        removeFromQueues(socket.id);
        const username = socket.data.user?.username;
        const userId = socket.data.user?.id;
        if (!username || !userId) throw new Error("Unauthorized socket");
        const targetRoomId = String(payload.roomId || "").trim().toUpperCase();
        const activeRoom = activePlayerRoomForSocketUser(socket);
        if (activeRoom && activeRoom.id !== targetRoomId) {
          socket.join(activeRoom.id);
          socket.emit("error:event", { message: `You are already in room ${activeRoom.id}. Rejoin that game until it ends.` });
          socket.emit("room:state", roomManager.serializeRoom(activeRoom));
          return;
        }
        if (activeRoom && activeRoom.id === targetRoomId) {
          socket.join(activeRoom.id);
          socket.emit("room:state", roomManager.serializeRoom(activeRoom));
          return;
        }
        clearSocketSpectating(socket);
        const room = roomManager.joinRoom({
          roomId: payload.roomId,
          socketId: socket.id,
          userId,
          username,
          rating: socket.data.user?.rating
        });
        socket.join(room.id);
        emitRoom(room);
      } catch (error) {
        socket.emit("error:event", { message: error.message });
      }
    });

    socket.on("queue:join", async (payload = {}) => {
      if (!enforceEventRate(socket, "queue:join", 12, 10000)) return;
      try {
        const username = socket.data.user?.username;
        const userId = socket.data.user?.id;
        const maxPlayers = Number(payload.maxPlayers);
        if (!username || !userId) throw new Error("Unauthorized socket");
        const activeRoom = activePlayerRoomForSocketUser(socket);
        if (activeRoom) {
          socket.join(activeRoom.id);
          socket.emit("error:event", { message: `You are already in room ${activeRoom.id}. Rejoin that game until it ends.` });
          socket.emit("room:state", roomManager.serializeRoom(activeRoom));
          return;
        }
        if (![2, 3, 4].includes(maxPlayers)) throw new Error("Queue type must be 2, 3, or 4");
        const user = await User.findById(userId).select("rating provisional placementGamesPlayed isBot");
        if (!user) throw new Error("User not found");
        if (user.isBot) throw new Error("Bots cannot queue directly");
        removeFromQueues(socket.id);
        clearSocketSpectating(socket);
        const entry = {
          socketId: socket.id,
          userId,
          username,
          rating: Number(user.rating || 1000),
          provisional: Boolean(user.provisional),
          placementGamesPlayed: Number(user.placementGamesPlayed || 0),
          timeControlSec: parseTimeControl(payload.timeControlSec, 120),
          enqueueAt: nowMs()
        };
        queues[maxPlayers].push(entry);
        emitQueueStatus(maxPlayers);
        tryMatch(maxPlayers);
      } catch (error) {
        socket.emit("error:event", { message: error.message });
      }
    });

    socket.on("queue:leave", () => {
      if (!enforceEventRate(socket, "queue:leave", 20, 10000)) return;
      removeFromQueues(socket.id);
      [2, 3, 4].forEach((size) => emitQueueStatus(size));
      socket.emit("queue:left", { ok: true });
    });

    socket.on("room:invite", async (payload = {}) => {
      if (!enforceEventRate(socket, "room:invite", 10, 10000)) return;
      try {
        const room = roomManager.getRoom(payload.roomId);
        if (!room) throw new Error("Room not found");
        if (!hasRoomAccess(room, socket)) throw new Error("Forbidden");
        const inviter = room.players.find((p) => p.socketId === socket.id);
        if (!inviter) throw new Error("Only room members can invite");
        if (room.status !== "waiting") throw new Error("Cannot invite after game starts");

        const normalized = (Array.isArray(payload.targets) ? payload.targets : [])
          .map((t) => String(t || "").trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 20);
        if (!normalized.length) throw new Error("No valid invite targets provided");

        const usernameRegexes = normalized.map((v) => new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
        const users = await User.find({ $or: [{ username: { $in: usernameRegexes } }, { email: { $in: normalized } }] });

        let delivered = 0;
        for (const user of users) {
          const sockets = onlineUsers.get(String(user._id)) || new Set();
          for (const sid of sockets) {
            io.to(sid).emit("room:invite", {
              roomId: room.id,
              from: { userId: inviter.userId, username: inviter.username },
              maxPlayers: room.maxPlayers
            });
            delivered += 1;
          }
        }
        socket.emit("room:invite:result", { requested: normalized.length, matchedUsers: users.length, delivered });
      } catch (error) {
        socket.emit("error:event", { message: error.message });
      }
    });

    socket.on("room:start", (payload = {}) => {
      if (!enforceEventRate(socket, "room:start", 8, 10000)) return;
      try {
        const room = roomManager.startRoom({ roomId: payload.roomId, socketId: socket.id });
        emitRoom(room);
      } catch (error) {
        socket.emit("error:event", { message: error.message });
      }
    });

    socket.on("room:rematch", (payload = {}) => {
      if (!enforceEventRate(socket, "room:rematch", 8, 10000)) return;
      try {
        const room = roomManager.getRoom(payload.roomId);
        if (!room) throw new Error("Room not found");
        if (room.status !== "completed") throw new Error("Rematch available only after game end");
        const me = room.players.find((p) => p.socketId === socket.id);
        if (!me) throw new Error("Only players can request rematch");

        const connectedPlayers = room.players.filter((p) => p.connected);
        if (connectedPlayers.length < 2) throw new Error("Need at least 2 connected players for rematch");
        const voterIds = new Set(Array.isArray(room.rematchVotes) ? room.rematchVotes : []);
        voterIds.add(String(me.userId || me.playerId));
        room.rematchVotes = Array.from(voterIds);
        emitRoom(room);

        const eligiblePlayers = connectedPlayers.filter((p) => !botIds.has(String(p.userId || "")));
        const requiredVotes = Math.max(1, eligiblePlayers.length);
        if (room.rematchVotes.length >= requiredVotes) {
          const reset = roomManager.rematchRoom({ roomId: payload.roomId });
          io.to(reset.id).emit("room:rematch", { roomId: reset.id });
          emitRoom(reset);
        }
      } catch (error) {
        socket.emit("error:event", { message: error.message });
      }
    });

    socket.on("room:state", (payload = {}) => {
      if (!enforceEventRate(socket, "room:state", 25, 5000)) return;
      try {
        const room = roomManager.getRoom(payload.roomId);
        if (!room) throw new Error("Room not found");
        if (!hasRoomAccess(room, socket)) throw new Error("Forbidden");
        socket.emit("room:state", roomManager.serializeRoom(room));
      } catch (error) {
        socket.emit("error:event", { message: error.message });
      }
    });

    socket.on("chat:send", (payload = {}) => {
      if (!enforceEventRate(socket, "chat:send", 30, 5000)) return;
      try {
        const text = String(payload.message || "").trim();
        if (!text) return;
        if (text.length > 400) throw new Error("Message too long");

        const room = roomManager.getRoom(payload.roomId);
        if (!room) throw new Error("Room not found");
        if (!hasRoomAccess(room, socket)) throw new Error("Forbidden");
        const sender =
          room.players.find((p) => p.socketId === socket.id) ||
          room.spectators.get(socket.id) || { userId: socket.data.user?.id, username: socket.data.user?.username };

        io.to(room.id).emit("chat:message", {
          id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
          roomId: room.id,
          userId: sender.userId,
          username: sender.username,
          message: text,
          createdAt: new Date().toISOString()
        });
      } catch (error) {
        socket.emit("error:event", { message: error.message });
      }
    });

    socket.on("ping:check", (payload = {}) => {
      socket.emit("ping:pong", {
        clientTime: payload.clientTime || Date.now(),
        serverTime: Date.now()
      });
    });

    socket.on("move:drop", async (payload = {}) => {
      if (!enforceEventRate(socket, "move:drop", 35, 5000)) return;
      try {
        if (!Number.isInteger(Number(payload.column))) throw new Error("Invalid move payload");
        const { room, move, timedOut, timeout } = roomManager.dropMove({
          roomId: payload.roomId,
          socketId: socket.id,
          column: payload.column,
          turnSerial: payload.turnSerial
        });
        if (timedOut) {
          if (timeout) io.to(room.id).emit("turn:timeout", { roomId: room.id, player: timeout.player });
          emitRoom(room);
          await closeMatchIfNeeded(room);
          socket.emit("move:rejected", { message: "Time expired" });
          return;
        }
        io.to(room.id).emit("move:accepted", { roomId: room.id, move });
        emitRoom(room);
        await closeMatchIfNeeded(room);
      } catch (error) {
        socket.emit("move:rejected", { message: error.message });
      }
    });

    socket.on("room:leave", async (payload = {}) => {
      if (!enforceEventRate(socket, "room:leave", 20, 10000)) return;
      try {
        removeFromQueues(socket.id);
        const room = roomManager.leaveRoom({ roomId: payload.roomId, socketId: socket.id });
        if (room) {
          socket.leave(room.id);
          emitRoom(room);
          await closeMatchIfNeeded(room);
        }
      } catch (error) {
        socket.emit("error:event", { message: error.message });
      }
    });

    socket.on("disconnect", async () => {
      console.info(`[socket] disconnected user=${socket.data.user?.username} id=${socket.id}`);
      setOnline(socket.data.user?.id, socket.id, false);
      removeFromQueues(socket.id);
      const room = roomManager.handleDisconnect(socket.id);
      if (room) {
        emitRoom(room);
        await closeMatchIfNeeded(room);
      }
    });
  });
}

module.exports = { registerGameHandlers };


