const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { authRoutes } = require("./routes/authRoutes");
const { userRoutes } = require("./routes/userRoutes");
const { friendRoutes } = require("./routes/friendRoutes");
const { matchRoutes } = require("./routes/matchRoutes");
const { ratingRoutes } = require("./routes/ratingRoutes");
const { tournamentRoutes } = require("./routes/tournamentRoutes");
const { env } = require("./config/env");

function createApp(clientOrigin) {
  const app = express();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  });
  

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 25,
    standardHeaders: true,
    legacyHeaders: false
  });
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (env.allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS blocked"));
    },
    credentials: true
  }));
  app.use(express.json({ limit: "64kb" }));
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      console.log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
    });
    return next();
  });
  app.use((req, res, next) => {
    if (!env.requireHttps) return next();
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    if (String(proto).toLowerCase() === "https") return next();
    return res.status(403).json({ message: "HTTPS required" });
  });
  app.use(limiter);

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "quadx-backend" });
  });
  

  app.use("/api/auth", authLimiter, authRoutes);
  app.use("/api/user", userRoutes);
  app.use("/api/friends", friendRoutes);
  app.use("/api/matches", matchRoutes);
  app.use("/api/ratings", ratingRoutes);
  app.use("/api/tournaments", tournamentRoutes);

  return app;
}

module.exports = { createApp };
