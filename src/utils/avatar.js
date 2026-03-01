function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomStarterAvatar(seedBase = "Player") {
  const seed = `${String(seedBase || "Player")}-${Date.now()}-${randomInt(1000, 9999)}`;
  return `https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${encodeURIComponent(seed)}`;
}

module.exports = { randomStarterAvatar };
