const mongoose = require("mongoose");

const reportSchema = new mongoose.Schema(
  {
    reporterUserId: { type: String, required: true, index: true },
    matchId: { type: String, required: true, index: true },
    reason: { type: String, required: true, maxlength: 80 },
    details: { type: String, default: "", maxlength: 800 }
  },
  { timestamps: true }
);

const Report = mongoose.model("Report", reportSchema);

module.exports = { Report };
