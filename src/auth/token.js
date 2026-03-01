const jwt = require("jsonwebtoken");
const { env } = require("../config/env");

function signAuthToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      username: user.username,
      email: user.email || null,
      role: user.role || "player"
    },
    env.jwtSecret,
    { expiresIn: env.jwtTtl }
  );
}

function verifyAuthToken(token) {
  return jwt.verify(token, env.jwtSecret);
}

module.exports = { signAuthToken, verifyAuthToken };
