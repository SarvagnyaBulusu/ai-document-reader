// Run with: npm test
// Uses a separate database (docreader_test) and a fake local AI server, so it never
// touches your real data and never spends Groq tokens.
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// ---- fake Groq server -------------------------------------------------------
let aiCalls = 0;
let aiMode = 'ok'; // 'ok' | 'rate-limit-once' | 'rate-limit-long'
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    aiCalls++;
    res.setHeader('content-type', 'application/json');
    const limited =
      aiMode === 'rate-limit-long' || (aiMode === 'rate-limit-once' && aiCalls === 1);
    if (limited) {
      const wait = aiMode === 'rate-limit-long' ? '90.0' : '0.2';
      res.statusCode = 429;
      return res.end(JSON.stringify({ error: { message: `Rate limit reached. Please try again in ${wait}s.`, code: 'rate_limit_exceeded' } }));
    }
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        title: 'Test Title', summary: 'A short test summary.', sentiment: 'Technical', keyTopics: ['linux', 'commands']
      }) } }]
    }));
  });
});

let server, base;

test.before(async () => {
  await new Promise(r => fakeAi.listen(0, r));
  process.env.GROQ_API_URL = `http://127.0.0.1:${fakeAi.address().port}/v1`;
  process.env.GROQ_API_KEY = 'test-key';

  const { app } = require('../backend/server');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  await require('../backend/db')();
  await mongoose.connection.db.dropDatabase();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  server.close();
  fakeAi.close();
});

async function summarize({ file, text, style = 'bullets' }) {
  const form = new FormData();
  form.append('summaryType', style);
  if (file) {
    const buf = fs.readFileSync(path.join(__dirname, 'fixtures', file));
    form.append('file', new Blob([buf]), file);
  } else {
    form.append('text', text);
  }
  const res = await fetch(`${base}/api/summarize`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

test('health check reports database connected', async () => {
  const res = await fetch(`${base}/api/health`);
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.database, 'connected');
});

for (const file of ['sample.txt', 'sample.docx', 'sample.pptx', 'sample.pdf']) {
  test(`summarizes a ${file.split('.')[1].toUpperCase()} file`, async () => {
    const { status, body } = await summarize({ file });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.success, true);
    assert.ok(body.data.wordCount >= 20, 'word count should be measured from the real text');
    assert.ok(body.data.summary.length > 0);
  });
}

test('word count is measured by the server, not the AI', async () => {
  const { body } = await summarize({ text: 'one two three four five' });
  assert.strictEqual(body.data.wordCount, 5);
  assert.strictEqual(body.data.readingTime, 1);
});

test('empty input is rejected with a clear message', async () => {
  const { status, body } = await summarize({ text: '   ' });
  assert.strictEqual(status, 400);
  assert.match(body.error, /Could not extract/);
});

test('unknown summary style falls back to concise', async () => {
  await summarize({ text: 'hello world', style: 'nonsense' });
  const hist = await (await fetch(`${base}/api/history`)).json();
  assert.strictEqual(hist.data[0].summaryType, 'concise');
});

test('change style works from the saved copy, with no re-upload', async () => {
  const first = await summarize({ file: 'sample.txt', style: 'academic' });
  const id = first.body.id;
  const res = await fetch(`${base}/api/history/${id}/resummarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summaryType: 'bullets' })
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.success, true);
  assert.notStrictEqual(body.id, id, 'creates a new history entry for the new style');
  const hist = await (await fetch(`${base}/api/history`)).json();
  assert.strictEqual(hist.data[0].summaryType, 'bullets');
  assert.strictEqual(hist.data[0].sourceText, undefined, 'saved text is not sent in history lists');
  assert.strictEqual(hist.data[0].wordCount, first.body.data.wordCount, 'word count stays that of the whole document');
});

test('change style rejects bad input clearly', async () => {
  const post = (id, style) => fetch(`${base}/api/history/${id}/resummarize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summaryType: style })
  });
  assert.strictEqual((await post('507f1f77bcf86cd799439011', 'bullets')).status, 404);
  assert.strictEqual((await post('not-an-id', 'bullets')).status, 400);
  assert.strictEqual((await post('507f1f77bcf86cd799439011', 'nonsense')).status, 400);
});

test('retries automatically after a short rate limit', async () => {
  aiMode = 'rate-limit-once';
  aiCalls = 0;
  const { status, body } = await summarize({ text: 'retry me please' });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.success, true);
  assert.strictEqual(aiCalls, 2, 'should have called the AI twice (fail, then succeed)');
  aiMode = 'ok';
});

test('long rate limit gives a friendly 429 message instead of raw JSON', async () => {
  aiMode = 'rate-limit-long';
  const { status, body } = await summarize({ text: 'too busy' });
  assert.strictEqual(status, 429);
  assert.match(body.error, /busy/i);
  assert.doesNotMatch(body.error, /rate_limit_exceeded/);
  aiMode = 'ok';
});

test('analytics are computed from the saved documents', async () => {
  const res = await (await fetch(`${base}/api/analytics`)).json();
  assert.strictEqual(res.success, true, res.error);
  const d = res.data;
  assert.ok(d.total >= 6);
  assert.strictEqual(d.byType.reduce((n, r) => n + r.count, 0), d.total);
  assert.ok(d.avgWordCount > 0);
  assert.ok(d.topTopics.includes('linux'));
  assert.ok(d.byDay.length >= 1);
});

test('CSV export has a header row and one row per document', async () => {
  const res = await fetch(`${base}/api/export.csv`);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const lines = (await res.text()).trim().split('\n');
  assert.ok(lines[0].startsWith('fileName,title,summaryType'));
  const hist = await (await fetch(`${base}/api/history`)).json();
  assert.strictEqual(lines.length - 1, hist.data.length);
});

test('delete one, then clear all', async () => {
  const total = async () => (await (await fetch(`${base}/api/analytics`)).json()).data.total;
  const hist = await (await fetch(`${base}/api/history`)).json();
  const before = await total();
  await fetch(`${base}/api/history/${hist.data[0]._id}`, { method: 'DELETE' });
  assert.strictEqual(await total(), before - 1);
  await fetch(`${base}/api/history`, { method: 'DELETE' });
  assert.strictEqual(await total(), 0);
});
