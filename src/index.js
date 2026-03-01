const fs = require("fs");
const http = require("http");
const https = require("https");
const { Server } = require("socket.io");
const { env } = require("./config/env");
const { connectMongo } = require("./db/mongoose");
const { createApp } = require("./app");
const { RoomManager } = require("./game/roomManager");
const { registerGameHandlers } = require("./socket/registerGameHandlers");
const { verifyAuthToken } = require("./auth/token");
const { parseCookies } = require("./auth/middleware");
const { User } = require("./models/User");
const { ensureBotPopulation } = require("./services/botPopulationService");

process.on("unhandledRejection", (error) => {
  console.error("[process] Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("[process] Uncaught exception:", error);
});

async function bootstrap() {
  console.log("[bootstrap] Starting QuadX backend");
  console.log(`[bootstrap] Environment: port=${env.port}, https=${env.useHttps}, requireHttps=${env.requireHttps}`);
  await connectMongo(env.mongoUri);
  if (env.botSeedingEnabled) {
    const result = await ensureBotPopulation({ targetCount: env.botTargetCount });
    console.log(`[bot-seed] completed seeded=${result.seeded} historyMatches=${result.historyMatches}`);
  }
  if (env.requireHttps && !env.useHttps) {
    throw new Error("REQUIRE_HTTPS is true but HTTPS is not enabled");
  }
  
  const app = createApp(env.clientOrigin);
  let server;
  if (env.useHttps && env.httpsKeyPath && env.httpsCertPath) {
    console.log(`[bootstrap] Using HTTPS key=${env.httpsKeyPath} cert=${env.httpsCertPath}`);
    server = https.createServer(
      {
        key: fs.readFileSync(env.httpsKeyPath),
        cert: fs.readFileSync(env.httpsCertPath)
      },
      app
    );
  } else {
    console.log("[bootstrap] Using HTTP server");
    server = http.createServer(app);
  }
  
  
  const io = new Server(server, {
    cors: {
      origin: env.allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true
    },
    pingInterval: 25000,
    pingTimeout: 15000
  });

  io.use(async (socket, next) => {
    try {
      console.log(`[socket] auth started socket=${socket.id}`);
      const authToken = String(socket.handshake.auth?.token || "");
      const cookies = parseCookies(socket.handshake.headers?.cookie || "");
      const token = authToken || String(cookies[env.cookieName] || "");
      if (!token) {
        console.warn(`[socket] auth rejected socket=${socket.id} reason=missing_token`);
        return next(new Error("Unauthorized"));
      }
      const payload = verifyAuthToken(token);
      const user = await User.findById(payload.sub);
      if (!user) {
        console.warn(`[socket] auth rejected socket=${socket.id} reason=user_not_found`);
        return next(new Error("Unauthorized"));
      }
      if (!user.emailVerified) {
        console.warn(`[socket] auth rejected socket=${socket.id} reason=email_not_verified user=${user._id}`);
        return next(new Error("Unauthorized"));
      }
      socket.data.user = {
        id: user._id.toString(),
        username: user.username,
        role: user.role || "player",
        rating: Number(user.rating || 1000)
      };
      console.log(`[socket] auth success socket=${socket.id} user=${user.username} (${user._id})`);
      return next();
    } catch (error) {
      console.warn(`[socket] auth error socket=${socket.id}: ${error.message}`);
      return next(new Error("Unauthorized"));
    }
  });

  const roomManager = new RoomManager();
  registerGameHandlers(io, roomManager);

  server.listen(env.port, () => {
    console.log(`QuadX backend listening on port ${env.port}${env.useHttps ? " (https)" : ""}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start QuadX backend:", error);
  process.exit(1);
});
