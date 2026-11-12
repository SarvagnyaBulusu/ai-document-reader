const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema({
  fileName: { type: String, required: true },
  fileType: { type: String },
  fileSize: { type: String },
  originalText: { type: String },
  // The text that was sent to the AI (first MAX_INPUT_CHARS characters). Hidden from normal queries.
  sourceText: { type: String, select: false },
  summaryType: { type: String, required: true },
  summary: { type: String, required: true },
  title: { type: String },
  wordCount: { type: Number },
  readingTime: { type: Number },
  sentiment: { type: String },
  keyTopics: [{ type: String }],
  createdAt: { type: Date, default: Date.now }
});

// Newest-first history and time-based analytics both sort/group on createdAt
documentSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Document', documentSchema);
