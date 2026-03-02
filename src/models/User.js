const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, trim: true, minlength: 2, maxlength: 24, unique: true },
    email: { type: String, trim: true, lowercase: true },
    passwordHash: { type: String, default: null },
    role: { type: String, enum: ["player", "spectator", "admin"], default: "player", index: true },
    googleId: { type: String },
    authProvider: { type: String, enum: ["email", "google"], default: "email" },
    emailVerified: { type: Boolean, default: false, index: true },
    emailVerifyTokenHash: { type: String, default: null },
    emailVerifyExpiresAt: { type: Date, default: null },
    mfaEnabled: { type: Boolean, default: false },
    mfaCodeHash: { type: String, default: null },
    mfaCodeExpiresAt: { type: Date, default: null },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    settings: {
      hideDropButtons: { type: Boolean, default: false },
      confirmMoves: { type: Boolean, default: false }
    },
    avatarUrl: { type: String, default: "" },
    countryCode: { type: String, default: "US", maxlength: 2 },
    isBot: { type: Boolean, default: false, index: true },
    botProfile: {
      style: { type: String, enum: ["aggressive", "defensive", "tactical", "balanced"], default: "balanced" }
    },
    lastActiveAt: { type: Date, default: null, index: true },
    rating: { type: Number, default: 1000, index: true },
    provisional: { type: Boolean, default: true, index: true },
    placementGamesPlayed: { type: Number, default: 0 },
    totalGames: { type: Number, default: 0 },
    ratingLastGameAt: { type: Date, default: null },
    sandbaggingFlags: { type: Number, default: 0 },
    lastRatingDelta: { type: Number, default: 0 },
    ratingHistory: {
      type: [{ rating: Number, delta: { type: Number, default: 0 }, at: Date }],
      default: [{ rating: 1000, at: new Date() }]
    },
    friends: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    gamesPlayed: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    draws: { type: Number, default: 0 }
  },
  { timestamps: true }
);

userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
userSchema.index({ googleId: 1 }, { unique: true, partialFilterExpression: { googleId: { $type: "string" } } });

const User = mongoose.model("User", userSchema);

module.exports = { User };
