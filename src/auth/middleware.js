const { User } = require("../models/User");
const { verifyAuthToken } = require("./token");
const { env } = require("../config/env");

function parseCookies(cookieHeader = "") {
  return String(cookieHeader)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const idx = part.indexOf("=");
      if (idx <= 0) return acc;
      const key = part.slice(0, idx).trim();
      const value = decodeURIComponent(part.slice(idx + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const cookies = parseCookies(req.headers.cookie || "");
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const token = bearerToken || cookies[env.cookieName] || "";
    if (!token) return res.status(401).json({ message: "Missing auth token" });

    const payload = verifyAuthToken(token);
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ message: "Invalid auth token" });

    req.user = user;
    return next();
  } catch (_error) {
    return res.status(401).json({ message: "Unauthorized" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole, parseCookies };
