const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { OAuth2Client } = require("google-auth-library");
const { env } = require("../config/env");
const { User } = require("../models/User");
const { signAuthToken } = require("../auth/token");
const { requireAuth } = require("../auth/middleware");
const { randomStarterAvatar } = require("../utils/avatar");

const router = express.Router();
const googleClient = new OAuth2Client(env.googleClientId || undefined);
const smtpFromAddress = env.smtpFrom || env.smtpUser || "";
const mailer = env.smtpHost && env.smtpUser && env.smtpPass
  ? nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: { user: env.smtpUser, pass: env.smtpPass }
    })
  : null;

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const MFA_TTL_MS = 10 * 60 * 1000;
const COOKIE_MAX_AGE_MS = 15 * 60 * 1000;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function generateNumericCode(length = 6) {
  const min = 10 ** (length - 1);
  const max = 10 ** length;
  return String(crypto.randomInt(min, max));
}

function isStrongPassword(password) {
  const text = String(password || "");
  return (
    text.length >= 10 &&
    /[a-z]/.test(text) &&
    /[A-Z]/.test(text) &&
    /\d/.test(text) &&
    /[^A-Za-z0-9]/.test(text)
  );
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

function maskEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  const [name, domain] = value.split("@");
  if (!name || !domain) return value || "unknown";
  if (name.length <= 2) return `${name[0]}*@${domain}`;
  return `${name[0]}***${name[name.length - 1]}@${domain}`;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(env.cookieSecure || env.useHttps),
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/"
  };
}

function setAuthCookie(res, token) {
  res.cookie(env.cookieName, token, cookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(env.cookieName, { ...cookieOptions(), maxAge: undefined });
}

async function makeUniqueUsername(baseValue) {
  const base = String(baseValue || "Player")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 18) || "Player";

  let attempt = base;
  let suffix = 1;
  while (await User.findOne({ username: attempt })) {
    attempt = `${base}${suffix}`;
    suffix += 1;
  }
  return attempt;
}

function authResponse(user) {
  return {
    token: signAuthToken(user),
    user: {
      id: user._id.toString(),
      username: user.username,
      email: user.email || null,
      avatarUrl: user.avatarUrl || "",
      role: user.role || "player",
      emailVerified: Boolean(user.emailVerified),
      mfaEnabled: Boolean(user.mfaEnabled),
      rating: user.rating || 1000,
      provisional: Boolean(user.provisional),
      placementGamesPlayed: user.placementGamesPlayed || 0,
      placementTotal: 6,
      totalGames: user.totalGames || 0,
      lastRatingDelta: user.lastRatingDelta || 0,
      settings: user.settings || { hideDropButtons: false },
      gamesPlayed: user.gamesPlayed || 0,
      wins: user.wins || 0,
      losses: user.losses || 0,
      draws: user.draws || 0
    }
  };
}

async function setEmailVerification(user) {
  const otp = generateNumericCode(6);
  console.log(`[auth][otp] generating verification OTP for ${maskEmail(user.email)}`);
  user.emailVerifyTokenHash = sha256(otp);
  user.emailVerifyExpiresAt = new Date(Date.now() + EMAIL_VERIFY_TTL_MS);
  await user.save();
  if (mailer && smtpFromAddress) {
    console.log(`[auth][otp] sending OTP email to ${maskEmail(user.email)} via SMTP ${env.smtpHost}:${env.smtpPort}`);
    try {
      const info = await mailer.sendMail({
        from: smtpFromAddress,
        to: user.email,
        subject: "Your QuadX verification OTP",
        text: `Your QuadX verification OTP is ${otp}. It expires in 24 hours.`,
        html: `<p>Your QuadX verification OTP is <b>${otp}</b>.</p><p>It expires in 24 hours.</p>`
      });
      console.log(`[auth][otp] OTP email sent to ${maskEmail(user.email)} messageId=${info.messageId || "n/a"}`);
    } catch (error) {
      console.error(`[auth][otp] failed to send OTP email to ${maskEmail(user.email)}: ${error.message}`);
      throw error;
    }
  } else {
    console.warn("[auth][otp] SMTP not configured. Using console fallback for OTP.");
    console.info(`[security] verification OTP for ${user.email}: ${otp}`);
  }
}

function isAccountLocked(user) {
  return Boolean(user.lockUntil && user.lockUntil.getTime() > Date.now());
}

async function registerFailedLogin(user) {
  user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
  if (user.failedLoginAttempts >= env.lockMaxAttempts) {
    user.lockUntil = new Date(Date.now() + env.lockMinutes * 60 * 1000);
    user.failedLoginAttempts = 0;
    console.warn(`[security] account locked: ${user.email}`);
  }
  await user.save();
}

async function clearLoginFailures(user) {
  if (!user.failedLoginAttempts && !user.lockUntil) return;
  user.failedLoginAttempts = 0;
  user.lockUntil = null;
  await user.save();
}

async function ensureMfa(user, code) {
  if (!user.mfaEnabled) return { ok: true };

  if (!code) {
    const challenge = generateNumericCode(6);
    user.mfaCodeHash = sha256(challenge);
    user.mfaCodeExpiresAt = new Date(Date.now() + MFA_TTL_MS);
    await user.save();
    console.info(`[security] MFA challenge for ${user.email || user.username}: ${challenge}`);
    return { ok: false, message: "MFA code required", mfaRequired: true };
  }

  if (!user.mfaCodeHash || !user.mfaCodeExpiresAt || user.mfaCodeExpiresAt.getTime() < Date.now()) {
    return { ok: false, message: "MFA code expired. Request a new challenge." };
  }

  if (sha256(code) !== user.mfaCodeHash) {
    return { ok: false, message: "Invalid MFA code" };
  }

  user.mfaCodeHash = null;
  user.mfaCodeExpiresAt = null;
  await user.save();
  return { ok: true };
}

router.post("/register", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const usernameInput = String(req.body.username || "").trim();
    console.log(`[auth] register attempt email=${maskEmail(email)}`);

    if (!email || !password) return res.status(400).json({ message: "Email and password are required" });
    if (!isValidEmail(email)) return res.status(400).json({ message: "Invalid email format" });
    if (!isStrongPassword(password)) {
      return res.status(400).json({
        message: "Password must be 10+ chars and include upper, lower, number, and symbol"
      });
    }

    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ message: "Email already in use" });

    const username = await makeUniqueUsername(usernameInput || email.split("@")[0]);
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.create({
      username,
      email,
      passwordHash,
      authProvider: "email",
      emailVerified: false,
      role: "player",
      avatarUrl: randomStarterAvatar(username)
    });

    await setEmailVerification(user);
    console.info(`[auth] register success email=${maskEmail(email)} username=${username}`);
    return res.status(201).json({
      ok: true,
      requiresVerification: true,
      email,
      message: "Account created. OTP sent to your email."
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Registration failed" });
  }
});

router.post("/verify-email", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const otp = String(req.body.otp || "").trim();
    console.log(`[auth] verify-email attempt email=${maskEmail(email)}`);
    if (!email || !otp) return res.status(400).json({ message: "Email and OTP are required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.emailVerified) return res.status(200).json({ ok: true, message: "Email already verified" });

    if (!user.emailVerifyTokenHash || !user.emailVerifyExpiresAt || user.emailVerifyExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: "OTP expired" });
    }

    if (sha256(otp) !== user.emailVerifyTokenHash) {
      console.warn(`[auth] verify-email failed email=${maskEmail(email)} reason=invalid_otp`);
      return res.status(400).json({ message: "Invalid OTP" });
    }

    user.emailVerified = true;
    user.emailVerifyTokenHash = null;
    user.emailVerifyExpiresAt = null;
    await user.save();
    console.info(`[auth] verify-email success email=${maskEmail(email)}`);

    return res.status(200).json({ ok: true, message: "Email verified" });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Verification failed" });
  }
});

router.post("/resend-verification", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    console.log(`[auth] resend-verification attempt email=${maskEmail(email)}`);
    if (!email) return res.status(400).json({ message: "Email is required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.emailVerified) return res.status(400).json({ message: "Email already verified" });

    await setEmailVerification(user);
    console.info(`[auth] resend-verification success email=${maskEmail(email)}`);
    return res.status(200).json({ ok: true, message: "OTP resent to your email." });
  } catch (error) {
      return res.status(500).json({ message: error.message || "Failed to resend OTP" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const mfaCode = String(req.body.mfaCode || "").trim();
    console.log(`[auth] login attempt email=${maskEmail(email)}`);
    if (!email || !password) return res.status(400).json({ message: "Email and password are required" });

    const user = await User.findOne({ email });
    if (!user || !user.passwordHash) return res.status(401).json({ message: "Invalid credentials" });

    if (isAccountLocked(user)) {
      return res.status(423).json({ message: "Account temporarily locked. Try again later." });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      console.warn(`[auth] failed login email=${maskEmail(email)}`);
      await registerFailedLogin(user);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (!user.emailVerified) {
      await setEmailVerification(user);
      return res.status(403).json({
        requiresVerification: true,
        email: user.email,
        message: "OTP sent to your email. Verify before login."
      });
    }

    const mfa = await ensureMfa(user, mfaCode);
    if (!mfa.ok) {
      return res.status(401).json({ message: mfa.message, mfaRequired: Boolean(mfa.mfaRequired) });
    }

    await clearLoginFailures(user);
    console.info(`[auth] login success email=${maskEmail(email)}`);
    const payload = authResponse(user);
    setAuthCookie(res, payload.token);
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(500).json({ message: error.message || "Login failed" });
  }
});

router.get("/google/config", (_req, res) => {
  const configured = Boolean(env.googleClientId && !String(env.googleClientId).startsWith("your_google_client_id"));
  return res.status(200).json({
    configured,
    clientId: configured ? env.googleClientId : ""
  });
});

router.post("/google", async (req, res) => {
  try {
    const idToken = String(req.body.idToken || "").trim();
    if (!idToken) return res.status(400).json({ message: "Google token is required" });
    const googleConfigured = Boolean(env.googleClientId && !String(env.googleClientId).startsWith("your_google_client_id"));
    if (!googleConfigured) return res.status(400).json({ message: "Google auth is not configured on server" });

    const ticket = await googleClient.verifyIdToken({ idToken, audience: env.googleClientId });
    const payload = ticket.getPayload();
    const googleId = payload?.sub;
    const email = String(payload?.email || "").toLowerCase();
    const name = String(payload?.name || "Player");
    if (!googleId || !email) return res.status(400).json({ message: "Invalid Google token" });
    console.log(`[auth] google auth attempt email=${maskEmail(email)}`);

    let user = await User.findOne({ $or: [{ googleId }, { email }] });
    if (!user) {
      const username = await makeUniqueUsername(name || email.split("@")[0]);
      user = await User.create({
        username,
        email,
        googleId,
        authProvider: "google",
        emailVerified: true,
        role: "player",
        avatarUrl: randomStarterAvatar(username)
      });
    } else if (!user.googleId) {
      if (!user.emailVerified) {
        return res.status(403).json({
          message: "Verify your email first, then use Google sign-in for this account."
        });
      }
      user.googleId = googleId;
      user.authProvider = "google";
      if (!user.avatarUrl) user.avatarUrl = randomStarterAvatar(user.username);
      await user.save();
    }

    const out = authResponse(user);
    console.info(`[auth] google auth success email=${maskEmail(email)}`);
    setAuthCookie(res, out.token);
    return res.status(200).json(out);
  } catch (error) {
    return res.status(401).json({ message: error.message || "Google login failed" });
  }
});

router.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  return res.status(200).json({ ok: true });
});

router.post("/mfa/enable", requireAuth, async (req, res) => {
  req.user.mfaEnabled = true;
  req.user.mfaCodeHash = null;
  req.user.mfaCodeExpiresAt = null;
  await req.user.save();
  return res.status(200).json({ ok: true, mfaEnabled: true });
});

router.post("/mfa/disable", requireAuth, async (req, res) => {
  req.user.mfaEnabled = false;
  req.user.mfaCodeHash = null;
  req.user.mfaCodeExpiresAt = null;
  await req.user.save();
  return res.status(200).json({ ok: true, mfaEnabled: false });
});

router.get("/me", requireAuth, async (req, res) => {
  return res.status(200).json({
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
      settings: req.user.settings || { hideDropButtons: false },
      gamesPlayed: req.user.gamesPlayed || 0,
      wins: req.user.wins || 0,
      losses: req.user.losses || 0,
      draws: req.user.draws || 0
    }
  });
});

module.exports = { authRoutes: router };

