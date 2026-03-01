const mongoose = require("mongoose");

const participantSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    username: { type: String, required: true },
    score: { type: Number, default: 0 },
    buchholz: { type: Number, default: 0 },
    opponents: { type: [String], default: [] }
  },
  { _id: false }
);

const pairingSchema = new mongoose.Schema(
  {
    table: { type: Number, required: true },
    playerA: { type: String, required: true },
    playerB: { type: String, default: null },
    result: { type: String, enum: ["pending", "A", "B", "draw", "bye"], default: "pending" }
  },
  { _id: false }
);

const roundSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true },
    pairings: { type: [pairingSchema], default: [] },
    completed: { type: Boolean, default: false }
  },
  { _id: false }
);

const tournamentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    createdBy: { type: String, required: true },
    status: { type: String, enum: ["open", "active", "completed"], default: "open" },
    maxPlayers: { type: Number, default: 32 },
    participants: { type: [participantSchema], default: [] },
    rounds: { type: [roundSchema], default: [] }
  },
  { timestamps: true }
);

const Tournament = mongoose.model("Tournament", tournamentSchema);

module.exports = { Tournament };
