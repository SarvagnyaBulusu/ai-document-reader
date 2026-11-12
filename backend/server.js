const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const connectDB = require('./db');
const Document = require('./documentModel');
const mammoth = require('mammoth');
const PDFParser = require('pdf2json');
const unzipper = require('unzipper');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---------- Settings (all overridable from .env) ----------
const GROQ_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
// Only the first N characters are sent to the model (keeps requests inside the free-tier token limit)
const MAX_INPUT_CHARS = parseInt(process.env.MAX_INPUT_CHARS, 10) || 4000;
const SUMMARY_TYPES = ['concise', 'detailed', 'bullets', 'academic'];
const SENTIMENTS = ['Positive', 'Neutral', 'Negative', 'Technical', 'Academic'];
const WORDS_PER_MINUTE = 200;

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ---------- Text extraction ----------
async function extractTextFromPPTX(buffer) {
  const directory = await unzipper.Open.buffer(buffer);
  const slideFiles = directory.files.filter(f =>
    f.path.startsWith('ppt/slides/slide') && f.path.endsWith('.xml')
  );
  let fullText = '';
  for (const slideFile of slideFiles) {
    const content = await slideFile.buffer();
    const xml = content.toString('utf-8');
    const textMatches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [];
    const slideText = textMatches.map(m => m.replace(/<[^>]+>/g, '')).join(' ');
    fullText += slideText + '\n';
  }
  return fullText;
}

async function extractText(file) {
  const ext = file.originalname.split('.').pop().toLowerCase();

  try {
    if (ext === 'pdf') {
      return new Promise((resolve, reject) => {
        const pdfParser = new PDFParser();
        pdfParser.on('pdfParser_dataReady', (pdfData) => {
          try {
            const text = pdfData.Pages.map(page =>
              page.Texts.map(t => {
                const raw = t.R.map(r => r.T).join('');
                try { return decodeURIComponent(raw); } catch (e) { return raw; }
              }).join(' ')
            ).join('\n');
            resolve(String(text || ''));
          } catch (e) { reject(e); }
        });
        pdfParser.on('pdfParser_dataError', reject);
        pdfParser.parseBuffer(file.buffer);
      });
    } else if (ext === 'docx' || ext === 'doc') {
      const data = await mammoth.extractRawText({ buffer: file.buffer });
      return String(data.value || '');
    } else if (ext === 'pptx') {
      const text = await extractTextFromPPTX(file.buffer);
      return String(text || '');
    } else if (ext === 'ppt') {
      throw new Error('Old .ppt format is not supported. Please convert to .pptx and try again.');
    } else {
      return String(file.buffer.toString('utf-8') || '');
    }
  } catch (e) {
    throw new Error('Could not read file: ' + e.message);
  }
}

// ---------- Groq call with automatic retry on rate limits ----------
class AiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Groq says e.g. "Please try again in 19.4s" or "in 1m2.5s" -> seconds
function parseRetrySeconds(message, headerValue) {
  const m = String(message || '').match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  if (m) return (parseInt(m[1] || '0', 10) * 60) + parseFloat(m[2]);
  const h = parseFloat(headerValue);
  return Number.isFinite(h) ? h : null;
}

function friendlyAiError(status, code, message) {
  if (status === 429) return new AiError('The AI service is busy (free-tier limit reached). Please wait about a minute and try again.', 429);
  if (status === 401) return new AiError('The Groq API key was rejected. Check GROQ_API_KEY in your .env file.', 401);
  if (status === 404 || code === 'model_not_found') return new AiError('The configured AI model is unavailable. Check GROQ_MODEL in your .env file.', 502);
  return new AiError('The AI service returned an error: ' + (message || 'unknown error'), 502);
}

async function callGroq(prompt, { maxRetries = 2, maxWaitSeconds = 25 } = {}) {
  if (!process.env.GROQ_API_KEY) {
    throw new AiError('GROQ_API_KEY is missing. Add it to your .env file.', 500);
  }
  const body = JSON.stringify({
    model: GROQ_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are a JSON API. You ONLY output valid raw JSON objects. No markdown. No code blocks. No explanations. Only a single JSON object. For bullet points in the summary field, separate each point with the newline character \\n'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.1,
    max_completion_tokens: 2000,
    reasoning_effort: 'low'
  });

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.choices && data.choices[0]) return data;

    const message = data.error && data.error.message;
    const code = data.error && data.error.code;
    console.error(`Groq error (attempt ${attempt + 1}): ${response.status} ${message || ''}`);

    if (response.status === 429 && attempt < maxRetries) {
      const wait = parseRetrySeconds(message, response.headers.get('retry-after'));
      if (wait !== null && wait <= maxWaitSeconds) {
        console.log(`Rate limited - waiting ${wait.toFixed(1)}s then retrying...`);
        await sleep(Math.ceil((wait + 0.5) * 1000));
        continue;
      }
    }
    throw friendlyAiError(response.status, code, message);
  }
}

// ---------- Prompts ----------
const STYLES = {
  concise: `Summarize this document in a natural, intelligent way like an expert explaining it to a student.
Write 4-5 sentences that cover the most important points clearly.
Use simple language. Make it feel like a human wrote it, not a robot.`,

  detailed: `Explain this document thoroughly like a knowledgeable teacher explaining to a student.
Cover every major topic, concept, or item mentioned.
For each topic explain what it is, what it does, and why it matters.
Write in clear flowing paragraphs. Be thorough but easy to understand.`,

  bullets: `Extract every important point, topic, command, or concept from this document.
Write each one on a completely new line starting with "- ".
For each item write: "- [name]: [clear explanation of what it is and what it does]"
Every single item must be on its own separate line. Do not combine items.
Be thorough - include every important item from the document.`,

  academic: `Write a formal academic summary of this document.
Include: objective/purpose of the document, main topics covered, key findings or concepts, and conclusion.
Use formal academic language. Structure it like an abstract for a research paper.
Be precise and comprehensive.`
};

function buildPrompt(summaryType, documentText) {
  return `Analyze the following document and respond with a single JSON object only. No markdown, no code blocks, no extra text. Just raw JSON.

Format:
{"title":"short title max 5 words","summary":"summary text here","sentiment":"Positive or Neutral or Negative or Technical or Academic","keyTopics":["topic1","topic2","topic3"]}

Summary instruction: ${STYLES[summaryType]}

DOCUMENT TEXT:
${documentText.substring(0, MAX_INPUT_CHARS)}`;
}

// Calls the AI and returns a validated result object
async function generateSummary(summaryType, documentText, fileName, wordCount, readingTime) {
  const data = await callGroq(buildPrompt(summaryType, documentText));
  const rawText = String(data.choices[0].message.content || '').trim();
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new AiError('The AI returned an unexpected answer. Please try again.', 502);

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0].replace(/[\r\t]/g, ' '));
  } catch (e) {
    throw new AiError('The AI returned an unreadable answer. Please try again.', 502);
  }

  const result = {
    title: String(parsed.title || fileName).slice(0, 80),
    summary: String(parsed.summary || ''),
    wordCount,
    readingTime,
    sentiment: SENTIMENTS.includes(parsed.sentiment) ? parsed.sentiment : 'Neutral',
    keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics.map(String).slice(0, 6) : []
  };
  if (!result.summary) throw new AiError('The AI returned an empty summary. Please try again.', 502);
  return result;
}

// ---------- Routes ----------
app.get('/api/health', async (req, res) => {
  const mongoose = require('mongoose');
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? 'ok' : 'database_down',
    database: dbUp ? 'connected' : 'disconnected',
    aiModel: GROQ_MODEL,
    aiKeyConfigured: Boolean(process.env.GROQ_API_KEY),
    maxInputChars: MAX_INPUT_CHARS
  });
});

app.post('/api/summarize', upload.single('file'), async (req, res) => {
  try {
    const summaryType = SUMMARY_TYPES.includes(req.body.summaryType) ? req.body.summaryType : 'concise';
    let documentText = '';
    let fileName = 'Pasted Text';
    let fileType = 'text';
    let fileSize = '0 KB';

    if (req.file) {
      documentText = await extractText(req.file);
      fileName = req.file.originalname;
      fileType = req.file.mimetype;
      fileSize = (req.file.size / 1024).toFixed(1) + ' KB';
    } else {
      documentText = String(req.body.text || '');
    }

    if (documentText.trim().length === 0) {
      throw new AiError('Could not extract any text. Please try a different file or paste the text instead.', 400);
    }

    // Measured by the server, not guessed by the AI
    const wordCount = documentText.trim().split(/\s+/).length;
    const readingTime = Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));

    const result = await generateSummary(summaryType, documentText, fileName, wordCount, readingTime);

    const doc = new Document({
      fileName,
      fileType,
      fileSize,
      originalText: documentText.substring(0, 500),
      sourceText: documentText.substring(0, MAX_INPUT_CHARS),
      summaryType,
      ...result
    });
    await doc.save();

    res.json({
      success: true,
      data: result,
      id: doc._id,
      truncated: documentText.length > MAX_INPUT_CHARS
    });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// Re-summarize a saved document in another style (works after a page reload, no re-upload needed)
app.post('/api/history/:id/resummarize', async (req, res) => {
  try {
    const summaryType = req.body && req.body.summaryType;
    if (!SUMMARY_TYPES.includes(summaryType)) {
      throw new AiError('Unknown summary style.', 400);
    }
    if (!require('mongoose').isValidObjectId(req.params.id)) {
      throw new AiError('Invalid document id.', 400);
    }
    const original = await Document.findById(req.params.id).select('+sourceText');
    if (!original) throw new AiError('Document not found. It may have been deleted.', 404);
    if (!original.sourceText) {
      throw new AiError('This document was saved before style changes were supported. Please upload it again.', 409);
    }

    const result = await generateSummary(summaryType, original.sourceText, original.fileName, original.wordCount, original.readingTime);
    const doc = new Document({
      fileName: original.fileName,
      fileType: original.fileType,
      fileSize: original.fileSize,
      originalText: original.originalText,
      sourceText: original.sourceText,
      summaryType,
      ...result
    });
    await doc.save();
    res.json({ success: true, data: result, id: doc._id });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const docs = await Document.find().sort({ createdAt: -1 }).limit(20);
    res.json({ success: true, data: docs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/history/:id', async (req, res) => {
  try {
    await Document.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/history', async (req, res) => {
  try {
    await Document.deleteMany({});
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Analytics: every number below comes from a MongoDB aggregation pipeline
app.get('/api/analytics', async (req, res) => {
  try {
    const total = await Document.countDocuments();

    const byType = await Document.aggregate([
      { $group: { _id: '$summaryType', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const bySentiment = await Document.aggregate([
      { $group: { _id: '$sentiment', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // average = total words / number of documents (word total comes from a $group)
    const wordTotals = await Document.aggregate([
      { $group: { _id: null, words: { $sum: '$wordCount' } } }
    ]);
    const avgWordCount = total && wordTotals[0] ? Math.round(wordTotals[0].words / total) : 0;

    const topTopicRows = await Document.aggregate([
      { $unwind: '$keyTopics' },
      { $group: { _id: '$keyTopics', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 8 }
    ]);

    // Documents per day. MongoDB/Atlas does this in the database; some MongoDB-compatible
    // databases lack $dateToString, so we fall back to grouping in JavaScript.
    let byDay;
    try {
      byDay = await Document.aggregate([
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]);
    } catch (e) {
      console.warn('Date aggregation unavailable, grouping in JS:', e.message);
      const dates = await Document.find({}, { createdAt: 1, _id: 0 }).lean();
      const counts = {};
      dates.forEach(d => {
        const day = new Date(d.createdAt).toISOString().slice(0, 10);
        counts[day] = (counts[day] || 0) + 1;
      });
      byDay = Object.keys(counts).sort().map(day => ({ _id: day, count: counts[day] }));
    }

    res.json({
      success: true,
      data: {
        total,
        byType,
        bySentiment,
        byDay,
        avgWordCount,
        topTopics: topTopicRows.slice(0, 5).map(r => r._id),
        topTopicCounts: topTopicRows.map(r => ({ topic: r._id, count: r.count }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// CSV export so the data can be opened in Excel / Power BI / Tableau
function csvCell(value) {
  let s = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s; // stops spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}

app.get('/api/export.csv', async (req, res) => {
  try {
    const docs = await Document.find().sort({ createdAt: -1 });
    const header = ['fileName', 'title', 'summaryType', 'sentiment', 'wordCount', 'readingTime', 'keyTopics', 'createdAt'];
    const rows = docs.map(d => [
      d.fileName, d.title, d.summaryType, d.sentiment, d.wordCount, d.readingTime,
      d.keyTopics, d.createdAt ? d.createdAt.toISOString() : ''
    ].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="document-reader-export.csv"');
    res.send([header.join(','), ...rows].join('\n'));
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------- Start ----------
if (require.main === module) {
  connectDB();
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = { app, parseRetrySeconds };
