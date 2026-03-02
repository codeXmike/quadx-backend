const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { requireAuth } = require("../auth/middleware");
const { signAuthToken } = require("../auth/token");
const { env } = require("../config/env");
const { imageKitConfigured, getImageKitAuthParams, uploadImageBuffer } = require("../services/imagekitService");
const { FriendRequest } = require("../models/FriendRequest");
const { User } = require("../models/User");

const router = express.Router();
const AVATAR_MAX_BYTES = 6 * 1024 * 1024;
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!String(file.mimetype || "").toLowerCase().startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    return cb(null, true);
  }
});

function isSafeAvatarUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch (_error) {
    return false;
  }
}

router.get("/avatar-upload/auth", requireAuth, async (_req, res) => {
  if (!imageKitConfigured) {
    return res.status(503).json({ message: "Image upload is not configured" });
  }
  try {
    const auth = getImageKitAuthParams();
    return res.status(200).json({
      ...auth,
      publicKey: env.imagekitPublicKey,
      uploadFolder: env.imagekitUploadFolder
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to prepare upload auth" });
  }
});

router.post("/avatar-upload", requireAuth, (req, res, next) => {
  avatarUpload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ message: "Image must be 6MB or less" });
    }
    return res.status(400).json({ message: err.message || "Invalid upload" });
  });
}, async (req, res) => {
  try {
    if (!imageKitConfigured) {
      return res.status(503).json({ message: "Image upload is not configured" });
    }

    const file = req.file;
    if (!file) return res.status(400).json({ message: "Image file is required" });
    if (!String(file.mimetype || "").toLowerCase().startsWith("image/")) {
      return res.status(400).json({ message: "Only image files are allowed" });
    }

    const ext = String(file.originalname || "").split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "png";
    const usernameSlug = String(req.user.username || "player").replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || "player";
    const fileName = `${usernameSlug}-${Date.now()}.${ext}`;
    const uploaded = await uploadImageBuffer({
      buffer: file.buffer,
      fileName,
      folder: env.imagekitUploadFolder || "/quadx",
      tags: ["avatar", "quadx", usernameSlug]
    });

    if (!uploaded?.url) return res.status(500).json({ message: "Upload failed" });
    req.user.avatarUrl = uploaded.url;
    await req.user.save();

    return res.status(200).json({
      ok: true,
      url: uploaded.url,
      user: {
        id: req.user._id.toString(),
        username: req.user.username,
        email: req.user.email || null,
        avatarUrl: req.user.avatarUrl || "",
        role: req.user.role || "player",
        emailVerified: Boolean(req.user.emailVerified),
        mfaEnabled: Boolean(req.user.mfaEnabled),
        rating: req.user.rating || 1000,
        provisional: Boolean(req.user.provisional),
        placementGamesPlayed: req.user.placementGamesPlayed || 0,
        placementTotal: 6,
        totalGames: req.user.totalGames || 0,
        lastRatingDelta: req.user.lastRatingDelta || 0,
        settings: {
          hideDropButtons: Boolean(req.user.settings?.hideDropButtons),
          confirmMoves: Boolean(req.user.settings?.confirmMoves)
        },
        gamesPlayed: req.user.gamesPlayed || 0,
        wins: req.user.wins || 0,
        losses: req.user.losses || 0,
        draws: req.user.draws || 0
      },
      token: signAuthToken(req.user)
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Upload failed" });
  }
});

router.get("/settings", requireAuth, async (req, res) => {
  const safeSettings = {
    hideDropButtons: Boolean(req.user.settings?.hideDropButtons),
    confirmMoves: Boolean(req.user.settings?.confirmMoves)
  };
  return res.status(200).json({
    settings: safeSettings,
      user: {
        id: req.user._id.toString(),
        username: req.user.username,
        email: req.user.email || null,
        avatarUrl: req.user.avatarUrl || "",
        role: req.user.role || "player",
        emailVerified: Boolean(req.user.emailVerified),
        mfaEnabled: Boolean(req.user.mfaEnabled),
        rating: req.user.rating || 1000,
        provisional: Boolean(req.user.provisional),
        placementGamesPlayed: req.user.placementGamesPlayed || 0,
        placementTotal: 6,
        totalGames: req.user.totalGames || 0,
        lastRatingDelta: req.user.lastRatingDelta || 0,
        settings: safeSettings
      }
    });
});

router.patch("/settings", requireAuth, async (req, res) => {
  try {
    if (typeof req.body.username === "string") {
      const username = req.body.username.trim();
      if (username.length < 2 || username.length > 24) {
        return res.status(400).json({ message: "Username must be 2-24 characters" });
      }
      const duplicate = await req.user.constructor.findOne({ username });
      if (duplicate && String(duplicate._id) !== String(req.user._id)) {
        return res.status(409).json({ message: "Username is already taken" });
      }
      req.user.username = username;
    }

    if (typeof req.body.avatarUrl === "string") {
      const avatarUrl = req.body.avatarUrl.trim().slice(0, 500);
      if (avatarUrl && !isSafeAvatarUrl(avatarUrl)) {
        return res.status(400).json({ message: "Invalid avatar URL" });
      }
      req.user.avatarUrl = avatarUrl;
    }

    const hideDropButtons =
      typeof req.body.hideDropButtons === "boolean"
        ? req.body.hideDropButtons
        : Boolean(req.user.settings?.hideDropButtons);
    const confirmMoves =
      typeof req.body.confirmMoves === "boolean"
        ? req.body.confirmMoves
        : Boolean(req.user.settings?.confirmMoves);

    req.user.settings = {
      ...(req.user.settings || {}),
      hideDropButtons,
      confirmMoves
    };
    await req.user.save();
    return res.status(200).json({
      settings: req.user.settings,
      user: {
        id: req.user._id.toString(),
        username: req.user.username,
        email: req.user.email || null,
        avatarUrl: req.user.avatarUrl || "",
        role: req.user.role || "player",
        emailVerified: Boolean(req.user.emailVerified),
        mfaEnabled: Boolean(req.user.mfaEnabled),
        rating: req.user.rating || 1000,
        provisional: Boolean(req.user.provisional),
        placementGamesPlayed: req.user.placementGamesPlayed || 0,
        placementTotal: 6,
        totalGames: req.user.totalGames || 0,
        lastRatingDelta: req.user.lastRatingDelta || 0,
        settings: req.user.settings,
        gamesPlayed: req.user.gamesPlayed || 0,
        wins: req.user.wins || 0,
        losses: req.user.losses || 0,
        draws: req.user.draws || 0
      },
      token: signAuthToken(req.user)
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Failed to update settings" });
  }
});

router.delete("/account", requireAuth, async (req, res) => {
  try {
    if (req.user.passwordHash) {
      const password = String(req.body?.password || "");
      if (!password) return res.status(400).json({ message: "Password is required to delete this account" });
      const valid = await bcrypt.compare(password, req.user.passwordHash);
      if (!valid) return res.status(401).json({ message: "Invalid password" });
    }

    const userId = req.user._id;
    await Promise.all([
      FriendRequest.deleteMany({ $or: [{ fromUserId: userId }, { toUserId: userId }] }),
      User.updateMany({ friends: userId }, { $pull: { friends: userId } }),
      User.deleteOne({ _id: userId })
    ]);

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to delete account" });
  }
});

module.exports = { userRoutes: router };

