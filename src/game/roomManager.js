const crypto = require("crypto");
const { DEFAULT_COLS, DEFAULT_ROWS, MAX_PLAYERS, MIN_PLAYERS, PLAYER_STYLES } = require("./constants");
const { createBoard, dropSeed, getConnectFourLine, isBoardFull } = require("./board");
const DISCONNECT_GRACE_MS = 20 * 1000;

function makeRoomId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function makePlayerId() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function normalizeTimeControlSec(value, fallback = 120) {
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

  createRoom({ hostSocketId, hostUserId, hostUsername, hostRating, maxPlayers, timeControlSec = 120 }) {
    const parsedSize = Number(maxPlayers);
    if (Number.isNaN(parsedSize) || parsedSize < MIN_PLAYERS || parsedSize > MAX_PLAYERS) {
      throw new Error(`Room size must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}`);
    }

    let roomId = makeRoomId();
    while (this.rooms.has(roomId)) roomId = makeRoomId();

    const normalizedTimeControl = normalizeTimeControlSec(timeControlSec, 120);
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
      winningCells: [],
      matchRecorded: false,
      timeControlSec: normalizedTimeControl,
      clockEnabled: normalizedTimeControl != null,
      turnStartedAt: null,
      turnSerial: 0,
      rematchVotes: [],
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
      disconnectedAt: null,
      disconnectGraceUntil: null,
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
    room.turnSerial = 1;
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

  rematchRoom({ roomId }) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    if (room.status !== "completed") throw new Error("Rematch available only after game end");

    room.players = room.players.filter((p) => p.connected);
    if (room.players.length < 2) throw new Error("Need at least 2 connected players for rematch");

    room.board = createBoard(DEFAULT_ROWS, DEFAULT_COLS);
    room.turnIndex = 0;
    room.status = "in_progress";
    room.winner = null;
    room.endedReason = null;
    room.winningCells = [];
    room.matchRecorded = false;
    room.moves = [];
    room.rematchVotes = [];
    room.players = room.players.map((p) => ({
      ...p,
      eliminated: false,
      eliminatedByTimeout: false,
      remainingMs: room.clockEnabled ? room.timeControlSec * 1000 : null
    }));
    room.turnStartedAt = room.clockEnabled ? Date.now() : null;
    room.turnSerial = 1;
    return room;
  }

  isPlayerActive(player) {
    return Boolean(player && player.connected && !player.eliminated);
  }

  alivePlayers(room) {
    return room.players.filter((p) => !p.eliminated);
  }

  currentPlayer(room) {
    if (!room.players.length) return null;
    const current = room.players[room.turnIndex];
    if (current && !current.eliminated) return current;

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
        room.turnSerial = Number(room.turnSerial || 0) + 1;
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
    if (!current.connected) return current.remainingMs || 0;
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
    const alive = this.alivePlayers(room);
    if (alive.length > 1) return false;

    room.status = "completed";
    room.winner = alive[0]
      ? { userId: alive[0].userId, username: alive[0].username, mark: alive[0].mark, color: alive[0].color }
      : null;
    room.endedReason = endedReason;
    room.winningCells = [];
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

  dropMove({ roomId, socketId, column, turnSerial }) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    if (room.status !== "in_progress") throw new Error("Game is not active");
    if (room.winner) throw new Error("Game already ended");
    if (Number.isInteger(Number(turnSerial)) && Number(turnSerial) !== Number(room.turnSerial || 0)) {
      throw new Error("Turn changed. Waiting for sync.");
    }

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

    const winningLine = getConnectFourLine(room.board, row, col, player.mark);
    if (winningLine.length) {
      room.status = "completed";
      room.winner = {
        userId: player.userId,
        username: player.username,
        mark: player.mark,
        color: player.color
      };
      room.endedReason = "connect_four";
      room.winningCells = winningLine;
      room.turnStartedAt = null;
      return { room, move, gameOver: true, timedOut: false };
    }

    if (isBoardFull(room.board)) {
      room.status = "completed";
      room.endedReason = "draw";
      room.winningCells = [];
      room.turnStartedAt = null;
      return { room, move, gameOver: true, timedOut: false };
    }

    this.nextTurn(room);
    room.turnStartedAt = room.clockEnabled ? now : null;
    return { room, move, gameOver: false, timedOut: false };
  }

  tick(now = Date.now()) {
    const impacted = [];

    impacted.push(...this.resolveDisconnects(now));

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

  getLivePlayerRoomByUserId(userId) {
    const uid = String(userId || "");
    if (!uid) return null;
    for (const room of this.rooms.values()) {
      if (room.status !== "waiting" && room.status !== "in_progress") continue;
      const player = room.players.find((p) => String(p.userId || "") === uid && !p.eliminated);
      if (player) return room;
    }
    return null;
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

    player.connected = false;
    player.disconnectedAt = Date.now();
    player.disconnectGraceUntil = player.disconnectedAt + DISCONNECT_GRACE_MS;
    if (wasCurrentTurn) room.turnStartedAt = room.clockEnabled ? Date.now() : null;
    return room;
  }

  leaveRoom({ roomId, socketId }) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    const playerIndex = room.players.findIndex((p) => p.socketId === socketId);
    if (playerIndex < 0) return this.handleDisconnect(socketId);

    const player = room.players[playerIndex];
    const wasCurrentTurn = room.status === "in_progress" && this.currentPlayer(room)?.socketId === socketId;
    this.socketToRoom.delete(socketId);
    player.connected = false;
    player.disconnectedAt = Date.now();
    player.disconnectGraceUntil = Date.now();
    player.eliminated = true;

    if (room.status === "waiting") {
      room.players.splice(playerIndex, 1);
      if (!room.players.length) {
        this.rooms.delete(room.id);
        return null;
      }
      if (room.turnIndex >= room.players.length) room.turnIndex = 0;
      return room;
    }

    if (room.status === "in_progress" && room.moves.length === 0) {
      room.status = "completed";
      room.winner = null;
      room.endedReason = "aborted";
      room.winningCells = [];
      room.turnStartedAt = null;
      room.rematchVotes = [];
      return room;
    }

    if (!this.completeByLastPlayer(room, "forfeit") && wasCurrentTurn) {
      this.nextTurn(room);
      room.turnStartedAt = room.clockEnabled ? Date.now() : null;
    }
    return room;
  }

  reconnectUserSocket({ userId, socketId }) {
    const uid = String(userId || "");
    if (!uid) return [];

    const recovered = [];
    for (const room of this.rooms.values()) {
      if (room.status !== "waiting" && room.status !== "in_progress") continue;
      const player = room.players.find((p) => String(p.userId || "") === uid && !p.eliminated);
      if (!player) continue;

      const oldSocketId = player.socketId;
      if (oldSocketId && oldSocketId !== socketId) this.socketToRoom.delete(oldSocketId);

      player.socketId = socketId;
      player.connected = true;
      player.disconnectedAt = null;
      player.disconnectGraceUntil = null;
      this.socketToRoom.set(socketId, room.id);
      recovered.push(room);
    }

    return recovered;
  }

  resolveDisconnects(now = Date.now()) {
    const impacted = [];
    for (const room of this.rooms.values()) {
      for (let i = room.players.length - 1; i >= 0; i -= 1) {
        const player = room.players[i];
        if (player.connected || player.eliminated) continue;
        if (!player.disconnectGraceUntil || player.disconnectGraceUntil > now) continue;

        this.socketToRoom.delete(player.socketId);
        if (room.status === "waiting") {
          room.players.splice(i, 1);
          if (!room.players.length) {
            this.rooms.delete(room.id);
            break;
          }
          if (room.turnIndex >= room.players.length) room.turnIndex = 0;
          impacted.push({ room, player: player.username, reason: "disconnect_removed_waiting" });
          continue;
        }

        if (room.status === "in_progress") {
          const wasCurrent = this.currentPlayer(room)?.playerId === player.playerId;
          player.eliminated = true;
          impacted.push({ room, player: player.username, reason: "disconnect_forfeit" });
          if (!this.completeByLastPlayer(room, "disconnect_forfeit") && wasCurrent) {
            this.nextTurn(room);
            room.turnStartedAt = room.clockEnabled ? now : null;
          }
        }
      }
    }
    return impacted;
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
        const activeAndRunning = room.clockEnabled
          && room.status === "in_progress"
          && current?.connected
          && current?.socketId === p.socketId;
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
          disconnectedAt: p.disconnectedAt || null,
          reconnectGraceRemainingMs: !p.connected && !p.eliminated && p.disconnectGraceUntil
            ? Math.max(0, p.disconnectGraceUntil - now)
            : 0,
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
      winningCells: room.winningCells || [],
      moveCount: room.moves.length,
      spectatorCount: room.spectators.size,
      timeControlSec: room.timeControlSec,
      clockEnabled: room.clockEnabled,
      turnSerial: Number(room.turnSerial || 0),
      rematchVotes: Array.isArray(room.rematchVotes) ? room.rematchVotes : [],
      turnExpiresAt: room.clockEnabled && room.status === "in_progress"
        ? (current?.connected ? now + this.getCurrentPlayerRemainingMs(room, now) : null)
        : null
    };
  }
}

module.exports = { RoomManager, normalizeTimeControlSec };

