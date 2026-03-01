const mongoose = require("mongoose");
const { User } = require("../models/User");
const { Match } = require("../models/Match");
const { FriendRequest } = require("../models/FriendRequest");
const { Tournament } = require("../models/Tournament");

function maskMongoUri(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch (_error) {
    return uri;
  }
}

async function connectMongo(mongoUri) {
  console.log(`[mongo] connecting to ${maskMongoUri(mongoUri)}`);
  mongoose.connection.on("connected", () => {
    console.log("[mongo] connected");
  });
  mongoose.connection.on("disconnected", () => {
    console.warn("[mongo] disconnected");
  });
  mongoose.connection.on("error", (error) => {
    console.error("[mongo] connection error:", error.message);
  });

  await mongoose.connect(mongoUri);
  console.log("[mongo] syncing indexes");
  await Promise.all([User.syncIndexes(), Match.syncIndexes(), FriendRequest.syncIndexes(), Tournament.syncIndexes()]);
  console.log("[mongo] indexes synced");
}

module.exports = { connectMongo };
