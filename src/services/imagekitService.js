const crypto = require("crypto");
const { env } = require("../config/env");

const imageKitConfigured = Boolean(
  env.imagekitPublicKey &&
  env.imagekitPrivateKey &&
  env.imagekitUrlEndpoint
);

function getImageKitAuthParams() {
  if (!imageKitConfigured) throw new Error("Image upload is not configured");
  const token = crypto.randomBytes(16).toString("hex");
  const expire = Math.floor(Date.now() / 1000) + 60 * 5;
  const signature = crypto
    .createHash("sha1")
    .update(`${token}${expire}${env.imagekitPrivateKey}`)
    .digest("hex");
  return { token, expire, signature };
}

module.exports = { imageKitConfigured, getImageKitAuthParams };
