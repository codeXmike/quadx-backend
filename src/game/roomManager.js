const crypto = require("crypto");
const { DEFAULT_COLS, DEFAULT_ROWS, MAX_PLAYERS, MIN_PLAYERS, PLAYER_STYLES } = require("./constants");
const { createBoard, dropSeed, hasConnectFour, isBoardFull } = require("./board");

function makeRoomId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function makePlayerId() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function normalizeTimeControlSec(value, fallback = 60) {
  if (value === null || value === "" || String(value).toLowerCase?.() === "unlimited") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return null;
  return Math.min(120, Math.max(30, Math.floor(parsed)));
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.socketToRoom = new Map();
    this.socketToSpectatorRoom = new Map();
  }

  createRoom({ hostSocketId, hostUserId, hostUsername, hostRating, maxPlayers, timeControlSec = 60 }) {
    const parsedSize = Number(maxPlayers);
    if (Number.isNaN(parsedSize) || parsedSize < MIN_PLAYERS || parsedSize > MAX_PLAYERS) {
      throw new Error(`Room size must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}`);
    }

    let roomId = makeRoomId();
    while (this.rooms.has(roomId)) roomId = makeRoomId();

    const normalizedTimeControl = normalizeTimeControlSec(timeControlSec, 60);
    const room = {
      id: roomId,
      maxPlayers: parsedSize,
      status: "waiting",
      board: createBoard(DEFAULT_ROWS, DEFAULT_COLS),
      turnIndex: 0,
      players: [],
      spectators: new Map(),
      winner: null,
      endedReason: null,
      matchRecorded: false,
      timeControlSec: normalizedTimeControl,
      clockEnabled: normalizedTimeControl != null,
      turnStartedAt: null,
      moves: [],
      createdAt: Date.now()
    };

    this.rooms.set(roomId, room);
    this.joinRoom({ roomId, socketId: hostSocketId, userId: hostUserId, username: hostUsername, rating: hostRating });
    return room;
  }

  createPlayer(room, { socketId, userId, username, rating }) {
    const style = PLAYER_STYLES[room.players.length];
    return {
      playerId: makePlayerId(),
      socketId,
      userId: userId || null,
      username: username || `Player${room.players.length + 1}`,
      rating: Number.isFinite(Number(rating)) ? Number(rating) : 1000,
      mark: style.mark,
      color: style.color,
      connected: true,
      eliminated: false,
      eliminatedByTimeout: false,
      remainingMs: room.clockEnabled ? room.timeControlSec * 1000 : null
    };
  }

  joinRoom({ roomId, socketId, userId, username, rating }) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    if (room.status !== "waiting") throw new Error("Game already started");
    if (room.players.length >= room.maxPlayers) throw new Error("Room is full");

    const duplicate = room.players.find((p) => p.username.toLowerCase() === String(username).toLowerCase());
    if (duplicate) throw new Error("Username already taken in room");

    room.spectators.delete(socketId);
    this.socketToSpectatorRoom.delete(socketId);

    const player = this.createPlayer(room, { socketId, userId, username, rating });
    room.players.push(player);
    this.socketToRoom.set(socketId, room.id);

    if (room.players.length >= 2 && room.players.length === room.maxPlayers) {
      this.beginGame(room, Date.now());
    }
    return room;
  }

  addSpectator({ roomId, socketId, userId, username }) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    room.spectators.set(socketId, { socketId, userId: userId || null, username: username || "Spectator" });
    this.socketToSpectatorRoom.set(socketId, room.id);
    return room;
  }

  removeSpectator(socketId) {
    const roomId = this.socketToSpectatorRoom.get(socketId);
    if (!roomId) return null;
    this.socketToSpectatorRoom.delete(socketId);
    const room = this.getRoom(roomId);
    if (!room) return null;
    room.spectators.delete(socketId);
    return room;
  }

  beginGame(room, now = Date.now()) {
    room.status = "in_progress";
    room.turnIndex = 0;
    room.turnStartedAt = room.clockEnabled ? now : null;
    this.currentPlayer(room);
  }

  startRoom({ roomId, socketId }) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    if (room.status !== "waiting") throw new Error("Room already started");
    if (room.players.length < 2) throw new Error("Need at least 2 players");
    if (room.players[0].socketId !== socketId) throw new Error("Only host can start");
    this.beginGame(room, Date.now());
    return room;
  }

  rematchRoom({ roomId, socketId }) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    if (room.status !== "completed") throw new Error("Rematch available only after game end");
    if (room.players[0]?.socketId !== socketId) throw new Error("Only host can request rematch");

    room.players = room.players.filter((p) => p.connected);
    if (room.players.length < 2) throw new Error("Need at least 2 connected players for rematch");

    room.board = createBoard(DEFAULT_ROWS, DEFAULT_COLS);
    room.turnIndex = 0;
    room.status = "in_progress";
    room.winner = null;
    room.endedReason = null;
    room.matchRecorded = false;
    room.moves = [];
    room.players = room.players.map((p) => ({
      ...p,
      eliminated: false,
      eliminatedByTimeout: false,
      remainingMs: room.clockEnabled ? room.timeControlSec * 1000 : null
    }));
    room.turnStartedAt = room.clockEnabled ? Date.now() : null;
    return room;
  }

  isPlayerActive(player) {
    return Boolean(player && player.connected && !player.eliminated);
  }

  currentPlayer(room) {
    if (!room.players.length) return null;

    for (let step = 0; step < room.players.length; step += 1) {
      const idx = (room.turnIndex + step) % room.players.length;
      const candidate = room.players[idx];
      if (this.isPlayerActive(candidate)) {
        room.turnIndex = idx;
        return candidate;
      }
    }
    return null;
  }

  nextTurn(room) {
    const total = room.players.length;
    if (!total) return null;

    for (let step = 1; step <= total; step += 1) {
      const idx = (room.turnIndex + step) % total;
      const p = room.players[idx];
      if (this.isPlayerActive(p)) {
        room.turnIndex = idx;
        return p;
      }
    }
    return null;
  }

  activePlayers(room) {
    return room.players.filter((p) => this.isPlayerActive(p));
  }

  getCurrentPlayerRemainingMs(room, now = Date.now()) {
    if (!room.clockEnabled || room.status !== "in_progress") return null;
    const current = this.currentPlayer(room);
    if (!current) return 0;
    const startedAt = room.turnStartedAt || now;
    return Math.max(0, (current.remainingMs || 0) - (now - startedAt));
  }

  finalizeCurrentTurnTime(room, now = Date.now()) {
    if (!room.clockEnabled || room.status !== "in_progress") return;
    const current = this.currentPlayer(room);
    if (!current) return;
    current.remainingMs = this.getCurrentPlayerRemainingMs(room, now);
    room.turnStartedAt = now;
  }

  completeByLastPlayer(room, endedReason) {
    const alive = this.activePlayers(room);
    if (alive.length > 1) return false;

    room.status = "completed";
    room.winner = alive[0]
      ? { userId: alive[0].userId, username: alive[0].username, mark: alive[0].mark, color: alive[0].color }
      : null;
    room.endedReason = endedReason;
    room.turnStartedAt = null;
    return true;
  }

  applyCurrentPlayerTimeout(room, now = Date.now()) {
    const current = this.currentPlayer(room);
    if (!current || room.status !== "in_progress" || !room.clockEnabled) return null;

    current.remainingMs = 0;
    current.eliminated = true;
    current.eliminatedByTimeout = true;

    const ended = this.completeByLastPlayer(room, "timeout_forfeit");
    if (!ended) {
      this.nextTurn(room);
      room.turnStartedAt = now;
    }

    return {
      room,
      player: current.username,
      reason: ended ? "timeout_end" : "turn_timeout"
    };
  }

  dropMove({ roomId, socketId, column }) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    if (room.status !== "in_progress") throw new Error("Game is not active");
    if (room.winner) throw new Error("Game already ended");

    const now = Date.now();
    if (room.clockEnabled && this.getCurrentPlayerRemainingMs(room, now) <= 0) {
      const timeout = this.applyCurrentPlayerTimeout(room, now);
      return { room, move: null, gameOver: room.status === "completed", timedOut: true, timeout };
    }

    const player = this.currentPlayer(room);
    if (!player || player.socketId !== socketId) throw new Error("Not your turn");

    this.finalizeCurrentTurnTime(room, now);

    const { row, col } = dropSeed(room.board, Number(column), player.mark);
    const move = {
      userId: player.userId,
      username: player.username,
      mark: player.mark,
      column: col,
      row,
      moveNumber: room.moves.length + 1
    };
    room.moves.push(move);

    if (hasConnectFour(room.board, row, col, player.mark)) {
      room.status = "completed";
      room.winner = {
        userId: player.userId,
        username: player.username,
        mark: player.mark,
        color: player.color
      };
      room.endedReason = "connect_four";
      room.turnStartedAt = null;
      return { room, move, gameOver: true, timedOut: false };
    }

    if (isBoardFull(room.board)) {
      room.status = "completed";
      room.endedReason = "draw";
      room.turnStartedAt = null;
      return { room, move, gameOver: true, timedOut: false };
    }

    this.nextTurn(room);
    room.turnStartedAt = room.clockEnabled ? now : null;
    return { room, move, gameOver: false, timedOut: false };
  }

  tick(now = Date.now()) {
    const impacted = [];

    for (const room of this.rooms.values()) {
      if (room.status !== "in_progress" || !room.clockEnabled) continue;

      while (room.status === "in_progress" && this.getCurrentPlayerRemainingMs(room, now) <= 0) {
        const timeout = this.applyCurrentPlayerTimeout(room, now);
        if (!timeout) break;
        impacted.push(timeout);
      }
    }

    return impacted;
  }

  listRoomsWithActiveClock() {
    return Array.from(this.rooms.values()).filter((r) => r.status === "in_progress" && r.clockEnabled);
  }

  listLiveRooms() {
    return Array.from(this.rooms.values())
      .filter((r) => r.status === "waiting" || r.status === "in_progress")
      .map((room) => ({
        roomId: room.id,
        status: room.status,
        maxPlayers: room.maxPlayers,
        players: room.players.map((p) => ({ username: p.username, mark: p.mark })),
        spectators: room.spectators.size,
        timeControlSec: room.timeControlSec
      }));
  }

  handleDisconnect(socketId) {
    const spectatorRoom = this.removeSpectator(socketId);
    if (spectatorRoom) return spectatorRoom;

    const roomId = this.socketToRoom.get(socketId);
    if (!roomId) return null;

    const room = this.getRoom(roomId);
    this.socketToRoom.delete(socketId);
    if (!room) return null;

    const playerIndex = room.players.findIndex((p) => p.socketId === socketId);
    if (playerIndex < 0) return room;

    const player = room.players[playerIndex];
    const wasCurrentTurn = room.status === "in_progress" && this.currentPlayer(room)?.socketId === socketId;
    if (room.status === "waiting") {
      room.players.splice(playerIndex, 1);
      if (!room.players.length) {
        this.rooms.delete(roomId);
        return null;
      }
      if (room.turnIndex >= room.players.length) room.turnIndex = 0;
      return room;
    }

    player.connected = false;
    player.eliminated = true;

    if (this.completeByLastPlayer(room, "forfeit")) {
      return room;
    }

    if (wasCurrentTurn) {
      this.nextTurn(room);
      room.turnStartedAt = room.clockEnabled ? Date.now() : null;
    }
    return room;
  }

  leaveRoom({ roomId, socketId }) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    return this.handleDisconnect(socketId);
  }

  getRoom(roomId) {
    return this.rooms.get(String(roomId || "").trim().toUpperCase());
  }

  serializeRoom(room, now = Date.now()) {
    if (!room) return null;
    const current = this.currentPlayer(room);

    return {
      id: room.id,
      maxPlayers: room.maxPlayers,
      status: room.status,
      board: room.board,
      players: room.players.map((p) => {
        const activeAndRunning = room.clockEnabled && room.status === "in_progress" && current?.socketId === p.socketId;
        const remainingMs = activeAndRunning
          ? Math.max(0, (p.remainingMs || 0) - (now - (room.turnStartedAt || now)))
          : p.remainingMs;

        return {
          playerId: p.playerId,
          userId: p.userId,
          username: p.username,
          rating: p.rating,
          mark: p.mark,
          color: p.color,
          connected: p.connected,
          eliminated: p.eliminated,
          eliminatedByTimeout: p.eliminatedByTimeout,
          remainingMs
        };
      }),
      turn: current
        ? {
            playerId: current.playerId,
            userId: current.userId,
            username: current.username,
            mark: current.mark
          }
        : null,
      winner: room.winner,
      endedReason: room.endedReason,
      moveCount: room.moves.length,
      spectatorCount: room.spectators.size,
      timeControlSec: room.timeControlSec,
      clockEnabled: room.clockEnabled,
      turnExpiresAt: room.clockEnabled && room.status === "in_progress"
        ? now + this.getCurrentPlayerRemainingMs(room, now)
        : null
    };
  }
}

module.exports = { RoomManager, normalizeTimeControlSec };
