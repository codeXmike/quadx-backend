const express = require("express");
const { requireAuth } = require("../auth/middleware");
const { signAuthToken } = require("../auth/token");
const { env } = require("../config/env");
const { imageKitConfigured, getImageKitAuthParams } = require("../services/imagekitService");

const router = express.Router();

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

router.get("/settings", requireAuth, async (req, res) => {
  return res.status(200).json({
    settings: req.user.settings || { hideDropButtons: false },
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
        lastRatingDelta: req.user.lastRatingDelta || 0
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

    req.user.settings = {
      ...(req.user.settings || {}),
      hideDropButtons
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

module.exports = { userRoutes: router };

