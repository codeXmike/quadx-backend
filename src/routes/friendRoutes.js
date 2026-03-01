const express = require("express");
const mongoose = require("mongoose");
const { requireAuth } = require("../auth/middleware");
const { User } = require("../models/User");
const { FriendRequest } = require("../models/FriendRequest");

const router = express.Router();

function userProjection(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email || null,
    rating: user.rating || 1000,
    avatarUrl: user.avatarUrl || ""
  };
}

router.get("/", requireAuth, async (req, res) => {
  const me = await User.findById(req.user._id).populate("friends", "username email");
  return res.status(200).json({
    friends: (me.friends || []).map((f) => ({ id: f._id.toString(), username: f.username, email: f.email || null }))
  });
});

router.get("/requests", requireAuth, async (req, res) => {
  const [incoming, outgoing] = await Promise.all([
    FriendRequest.find({ toUserId: req.user._id, status: "pending" })
      .populate("fromUserId", "username email")
      .sort({ createdAt: -1 }),
    FriendRequest.find({ fromUserId: req.user._id, status: "pending" })
      .populate("toUserId", "username email")
      .sort({ createdAt: -1 })
  ]);

  return res.status(200).json({
    incoming: incoming.map((r) => ({
      id: r._id.toString(),
      from: userProjection(r.fromUserId),
      createdAt: r.createdAt
    })),
    outgoing: outgoing.map((r) => ({
      id: r._id.toString(),
      to: userProjection(r.toUserId),
      createdAt: r.createdAt
    }))
  });
});

router.get("/search", requireAuth, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) {
    return res.status(200).json({ users: [] });
  }

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const usernameRegex = new RegExp(escaped, "i");

  const me = await User.findById(req.user._id).select("friends");
  const friendIds = new Set((me?.friends || []).map((id) => String(id)));

  const users = await User.find({
    _id: { $ne: req.user._id },
    username: usernameRegex
  })
    .select("username avatarUrl rating")
    .sort({ rating: -1, username: 1 })
    .limit(10);

  const pendingRequests = await FriendRequest.find({
    status: "pending",
    $or: [
      { fromUserId: req.user._id, toUserId: { $in: users.map((u) => u._id) } },
      { fromUserId: { $in: users.map((u) => u._id) }, toUserId: req.user._id }
    ]
  }).select("fromUserId toUserId");

  const pendingByUserId = new Map();
  for (const r of pendingRequests) {
    if (String(r.fromUserId) === String(req.user._id)) {
      pendingByUserId.set(String(r.toUserId), "outgoing");
    } else {
      pendingByUserId.set(String(r.fromUserId), "incoming");
    }
  }

  return res.status(200).json({
    users: users.map((u) => ({
      id: u._id.toString(),
      username: u.username,
      rating: u.rating || 1000,
      avatarUrl: u.avatarUrl || "",
      isFriend: friendIds.has(String(u._id)),
      pending: pendingByUserId.get(String(u._id)) || null
    }))
  });
});

router.post("/request", requireAuth, async (req, res) => {
  const identifier = String(req.body.identifier || "").trim().toLowerCase();
  if (!identifier) return res.status(400).json({ message: "Username or email is required" });

  const isObjectId = mongoose.Types.ObjectId.isValid(identifier);
  const usernameRegex = new RegExp(`^${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const target = await User.findOne({
    $or: [{ username: usernameRegex }, { email: identifier }, ...(isObjectId ? [{ _id: identifier }] : [])]
  });
  if (!target) return res.status(404).json({ message: "User not found" });
  if (String(target._id) === String(req.user._id)) {
    return res.status(400).json({ message: "You cannot add yourself" });
  }

  const me = await User.findById(req.user._id);
  if ((me.friends || []).some((id) => String(id) === String(target._id))) {
    return res.status(409).json({ message: "Already friends" });
  }

  const existing = await FriendRequest.findOne({
    status: "pending",
    $or: [
      { fromUserId: req.user._id, toUserId: target._id },
      { fromUserId: target._id, toUserId: req.user._id }
    ]
  });
  if (existing) return res.status(409).json({ message: "A pending request already exists" });

  const request = await FriendRequest.create({
    fromUserId: req.user._id,
    toUserId: target._id,
    status: "pending"
  });

  return res.status(201).json({
    request: {
      id: request._id.toString(),
      to: userProjection(target),
      status: request.status
    }
  });
});

router.patch("/requests/:requestId", requireAuth, async (req, res) => {
  const action = String(req.body.action || "").toLowerCase();
  if (!["accept", "reject"].includes(action)) {
    return res.status(400).json({ message: "Action must be accept or reject" });
  }

  const request = await FriendRequest.findById(req.params.requestId);
  if (!request || request.status !== "pending") return res.status(404).json({ message: "Request not found" });
  if (String(request.toUserId) !== String(req.user._id)) return res.status(403).json({ message: "Forbidden" });

  request.status = action === "accept" ? "accepted" : "rejected";
  await request.save();

  if (request.status === "accepted") {
    await Promise.all([
      User.updateOne({ _id: request.fromUserId }, { $addToSet: { friends: request.toUserId } }),
      User.updateOne({ _id: request.toUserId }, { $addToSet: { friends: request.fromUserId } })
    ]);
  }

  return res.status(200).json({ ok: true, status: request.status });
});

module.exports = { friendRoutes: router };

