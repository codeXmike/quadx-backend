const crypto = require("crypto");
const ImageKit = require("@imagekit/nodejs");
const { env } = require("../config/env");
const toFile = ImageKit.toFile;

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

const imagekit = imageKitConfigured
  ? new ImageKit({
      publicKey: env.imagekitPublicKey,
      privateKey: env.imagekitPrivateKey,
      urlEndpoint: env.imagekitUrlEndpoint
    })
  : null;

async function uploadImageBuffer({ buffer, fileName, folder, tags }) {
  if (!imagekit) throw new Error("Image upload is not configured");
  if (!buffer || !Buffer.isBuffer(buffer)) throw new Error("Invalid image buffer");
  if (!fileName) throw new Error("File name is required");

  const response = await imagekit.files.upload({
    file: toFile(buffer, fileName),
    fileName,
    folder: folder || env.imagekitUploadFolder || "/quadx",
    tags: Array.isArray(tags) ? tags : undefined,
    useUniqueFileName: true
  });

  return response;
}

module.exports = { imageKitConfigured, getImageKitAuthParams, uploadImageBuffer };
