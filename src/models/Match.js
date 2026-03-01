const mongoose = require("mongoose");

const participantSchema = new mongoose.Schema(
  {
    userId: { type: String, default: null },
    username: { type: String, required: true },
    mark: { type: String, required: true },
    color: { type: String, required: true },
    eliminated: { type: Boolean, default: false }
  },
  { _id: false }
);

const moveSchema = new mongoose.Schema(
  {
    userId: { type: String, default: null },
    username: { type: String, required: true },
    mark: { type: String, required: true },
    column: { type: Number, required: true },
    row: { type: Number, required: true },
    moveNumber: { type: Number, required: true }
  },
  { _id: false }
);

const ratingChangeSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    username: { type: String, required: true },
    before: { type: Number, required: true },
    after: { type: Number, required: true },
    delta: { type: Number, required: true },
    provisionalBefore: { type: Boolean, default: false },
    provisionalAfter: { type: Boolean, default: false },
    placementGamesPlayedAfter: { type: Number, default: 0 }
  },
  { _id: false }
);

const matchSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    maxPlayers: { type: Number, required: true },
    boardRows: { type: Number, required: true },
    boardCols: { type: Number, required: true },
    participants: { type: [participantSchema], default: [] },
    moves: { type: [moveSchema], default: [] },
    ratingChanges: { type: [ratingChangeSchema], default: [] },
    winnerUsername: { type: String, default: null },
    endedReason: { type: String, required: true }
  },
  { timestamps: true }
);

const Match = mongoose.model("Match", matchSchema);

module.exports = { Match };
