const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function required(name, fallback = "") {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const env = {
  port: Number(process.env.PORT || 4000),
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  allowedOrigins: String(process.env.ALLOWED_ORIGINS || process.env.CLIENT_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
  mongoUri: required("MONGODB_URI"),
  jwtSecret: required("JWT_SECRET", "dev_jwt_secret_change_me"),
  jwtTtl: process.env.JWT_TTL || "15m",
  cookieName: process.env.AUTH_COOKIE_NAME || "qx_auth",
  cookieSecure: process.env.COOKIE_SECURE === "true",
  lockMaxAttempts: Number(process.env.AUTH_MAX_ATTEMPTS || 8),
  lockMinutes: Number(process.env.AUTH_LOCK_MINUTES || 15),
  requireHttps: process.env.REQUIRE_HTTPS === "true",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpSecure: process.env.SMTP_SECURE === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFrom: process.env.SMTP_FROM || process.env.SMTP_USER || "",
  imagekitPublicKey: process.env.IMAGEKIT_PUBLIC_KEY || "",
  imagekitPrivateKey: process.env.IMAGEKIT_PRIVATE_KEY || "",
  imagekitUrlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || "",
  imagekitUploadFolder: process.env.IMAGEKIT_UPLOAD_FOLDER || "/quadx",
  botTargetCount: Number(process.env.BOT_TARGET_COUNT || 50),
  botSeedingEnabled: process.env.BOT_SEEDING_ENABLED !== "false",
  botMatchMinWaitSec: Number(process.env.BOT_MATCH_MIN_WAIT_SEC || 10),
  botMatchMaxWaitSec: Number(process.env.BOT_MATCH_MAX_WAIT_SEC || 40),
  botBaseWaitSec: Number(process.env.BOT_MATCH_BASE_WAIT_SEC || 20),
  botMatchesAffectRating: process.env.BOT_MATCHES_AFFECT_RATING !== "false",
  useHttps: process.env.HTTPS_ENABLED === "true",
  httpsKeyPath: process.env.HTTPS_KEY_PATH || "",
  httpsCertPath: process.env.HTTPS_CERT_PATH || ""
};

module.exports = { env };
