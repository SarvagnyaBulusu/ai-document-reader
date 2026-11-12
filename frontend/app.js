// Same origin when served by Express, direct URL when opened as a file
const API_URL = window.location.protocol.startsWith('http') && window.location.port === '5000' ? '/api' : 'http://localhost:5000/api';
let selectedFile = null;
let summaryType = 'concise';
let lastFile = null;
let lastText = '';
let historyCache = [];

function selectOption(el, type) {
  document.querySelectorAll('.option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  summaryType = type;
}

function handleFile(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    alert('File is too large! Maximum size is 10MB.');
    return;
  }
  selectedFile = file;
  const ext = file.name.split('.').pop().toUpperCase();
  document.getElementById('file-ext').textContent = ext;
  document.getElementById('file-name').textContent = file.name;
  document.getElementById('file-size').textContent = (file.size / 1024).toFixed(1) + ' KB';
  document.getElementById('file-preview').style.display = 'flex';
  document.getElementById('text-input').value = '';
}

function removeFile() {
  selectedFile = null;
  document.getElementById('file-input').value = '';
  document.getElementById('file-preview').style.display = 'none';
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('hidden');
}

const uploadZone = document.getElementById('upload-zone');
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.style.borderColor = '#6c63ff'; });
uploadZone.addEventListener('dragleave', () => uploadZone.style.borderColor = '#2a2a3e');
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.style.borderColor = '#2a2a3e';
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

async function analyze() {
  const text = document.getElementById('text-input').value.trim();
  if (!selectedFile && !text) {
    alert('Please upload a file or paste some text!');
    return;
  }

  lastFile = selectedFile;
  lastText = text;

  document.getElementById('upload-section').style.display = 'none';
  document.getElementById('loading-section').style.display = 'block';
  document.getElementById('results-section').style.display = 'none';

  try {
    const formData = new FormData();
    formData.append('summaryType', summaryType);
    if (selectedFile) {
      formData.append('file', selectedFile);
    } else {
      formData.append('text', text);
    }

    const response = await fetch(`${API_URL}/summarize`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (!data.success) throw new Error(data.error);

    window._currentId = data.id;
    showResults(data.data, selectedFile ? selectedFile.name : 'Pasted Text');
    loadHistory();
    loadAnalytics();
  } catch (error) {
    alert('Error: ' + error.message);
    document.getElementById('upload-section').style.display = 'block';
    document.getElementById('loading-section').style.display = 'none';
  }
}

function showResults(r, fileName) {
  document.getElementById('loading-section').style.display = 'none';
  document.getElementById('upload-section').style.display = 'none';

  const isBullets = summaryType === 'bullets';
  const lines = isBullets ? r.summary.split('\n').filter(l => l.trim()) : null;

  const html = `
    <div class="result-header">
      <div>
        <h2>${r.title || fileName}</h2>
        <p>${fileName}</p>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="new-btn" style="border-color:#6c63ff; color:#6c63ff;" onclick="openStyleModal()">↻ Change Style</button>
        <button class="new-btn" onclick="resetApp()">+ New Document</button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">${(r.wordCount || 0).toLocaleString()}</div>
        <div class="stat-label">Words</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${r.readingTime || 0} min</div>
        <div class="stat-label">Reading Time</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="font-size:14px;color:#4ecdc4">${r.sentiment || 'Neutral'}</div>
        <div class="stat-label">Tone</div>
      </div>
    </div>

    <div class="result-card">
      <div class="result-card-label">${isBullets ? 'KEY POINTS' : 'SUMMARY'}</div>
      ${isBullets
        ? `<ul>${lines.map(l => `<li><span class="bullet">•</span><span>${l.replace(/^[-•*]\s*/, '')}</span></li>`).join('')}</ul>`
        : `<p>${r.summary}</p>`
      }
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="copy-btn" id="copy-btn" onclick="copySummary()">Copy</button>
        <button class="export-btn" onclick="exportPDF()">⬇ Export PDF</button>
      </div>
    </div>

    ${r.keyTopics && r.keyTopics.length ? `
    <div class="result-card">
      <div class="result-card-label">KEY TOPICS</div>
      <div class="topics-wrap">
        ${r.keyTopics.map(t => `<span class="topic-tag">${t}</span>`).join('')}
      </div>
    </div>` : ''}

    <div class="db-card">
      <div class="db-card-header">
        <h3>MongoDB Document</h3>
        <span class="db-badge">✓ Saved to Database</span>
      </div>
      <div class="schema-block">
        <span class="sk">fileName</span>: <span class="ss">"${fileName}"</span>,<br>
        <span class="sk">title</span>: <span class="ss">"${r.title}"</span>,<br>
        <span class="sk">summaryType</span>: <span class="ss">"${summaryType}"</span>,<br>
        <span class="sk">wordCount</span>: <span class="sn">${r.wordCount || 0}</span>,<br>
        <span class="sk">sentiment</span>: <span class="ss">"${r.sentiment}"</span>,<br>
        <span class="sk">keyTopics</span>: <span class="sv">[${(r.keyTopics || []).map(t => `"${t}"`).join(', ')}]</span>,<br>
        <span class="sk">createdAt</span>: <span class="ss">"${new Date().toISOString()}"</span>
      </div>
    </div>
  `;

  window._currentSummary = r.summary;
  window._currentTitle = r.title || fileName;
  window._currentFileName = fileName;
  document.getElementById('results-section').innerHTML = html;
  document.getElementById('results-section').style.display = 'block';
}

function openStyleModal() {
  document.getElementById('style-modal').style.display = 'flex';
}

function closeStyleModal() {
  document.getElementById('style-modal').style.display = 'none';
}

async function changeStyle(newStyle) {
  closeStyleModal();

  // Prefer the saved copy on the server (works after reloads and for History items);
  // fall back to the file/text still in the browser's memory.
  const canUseSaved = Boolean(window._currentId);
  if (!canUseSaved && !lastFile && !lastText) {
    alert('This document cannot be re-summarized. Please upload it again.');
    return;
  }

  summaryType = newStyle;
  document.getElementById('results-section').style.display = 'none';
  document.getElementById('loading-section').style.display = 'block';

  try {
    let response;
    if (canUseSaved) {
      response = await fetch(`${API_URL}/history/${window._currentId}/resummarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summaryType })
      });
    } else {
      const formData = new FormData();
      formData.append('summaryType', summaryType);
      if (lastFile) formData.append('file', lastFile);
      else formData.append('text', lastText);
      response = await fetch(`${API_URL}/summarize`, { method: 'POST', body: formData });
    }

    const data = await response.json();
    if (!data.success) throw new Error(data.error);

    window._currentId = data.id;
    showResults(data.data, window._currentFileName || (lastFile ? lastFile.name : 'Pasted Text'));
    loadHistory();
    loadAnalytics();
  } catch (error) {
    alert('Error: ' + error.message);
    document.getElementById('loading-section').style.display = 'none';
    document.getElementById('results-section').style.display = 'block';
  }
}

function copySummary() {
  navigator.clipboard.writeText(window._currentSummary || '');
  const btn = document.getElementById('copy-btn');
  btn.textContent = '✓ Copied!';
  btn.style.color = '#4ecdc4';
  setTimeout(() => {
    btn.textContent = 'Copy';
    btn.style.color = '';
  }, 2000);
}

function exportPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const title = window._currentTitle || 'Document Summary';
  const summary = window._currentSummary || '';
  const fileName = window._currentFileName || 'summary';

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(title, 20, 20);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(`Summary Style: ${summaryType}`, 20, 32);
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, 20, 40);

  doc.setLineWidth(0.5);
  doc.line(20, 45, 190, 45);

  doc.setFontSize(12);
  const lines = doc.splitTextToSize(summary, 170);
  doc.text(lines, 20, 55);

  doc.save(`${fileName}-summary.pdf`);
}

function resetApp() {
  selectedFile = null;
  lastFile = null;
  lastText = '';
  window._currentId = null;
  window._currentSummary = '';
  window._currentTitle = '';
  window._currentFileName = '';
  document.getElementById('file-input').value = '';
  document.getElementById('file-preview').style.display = 'none';
  document.getElementById('text-input').value = '';
  document.getElementById('results-section').style.display = 'none';
  document.getElementById('results-section').innerHTML = '';
  document.getElementById('loading-section').style.display = 'none';
  document.getElementById('upload-section').style.display = 'block';
}

async function loadHistory() {
  try {
    const response = await fetch(`${API_URL}/history`);
    const data = await response.json();
    historyCache = data.data || [];
    renderHistory(historyCache);
  } catch (error) {
    console.error('History error:', error);
  }
}

function renderHistory(docs) {
  const list = document.getElementById('history-list');
  if (!docs.length) {
    list.innerHTML = '<p class="no-history">No documents yet</p>';
    return;
  }
  list.innerHTML = docs.map(doc => `
    <div class="history-item" onclick="loadDocById('${doc._id}')">
      <button class="delete-btn" onclick="event.stopPropagation(); deleteDoc('${doc._id}')">✕</button>
      <h5>${doc.title || doc.fileName}</h5>
      <p>${new Date(doc.createdAt).toLocaleDateString()} • ${doc.summaryType}</p>
    </div>
  `).join('');
}

function searchHistory(query) {
  const filtered = historyCache.filter(doc =>
    (doc.title || doc.fileName).toLowerCase().includes(query.toLowerCase())
  );
  renderHistory(filtered);
}

function loadDocById(id) {
  const doc = historyCache.find(d => d._id === id);
  if (!doc) return;
  summaryType = doc.summaryType;
  window._currentId = doc._id;
  const result = {
    title: doc.title || doc.fileName,
    summary: doc.summary,
    wordCount: doc.wordCount,
    readingTime: doc.readingTime,
    sentiment: doc.sentiment,
    keyTopics: doc.keyTopics || []
  };
  showResults(result, doc.fileName);
}

async function deleteDoc(id) {
  try {
    await fetch(`${API_URL}/history/${id}`, { method: 'DELETE' });
    loadHistory();
    loadAnalytics();
  } catch (error) {
    console.error('Delete error:', error);
  }
}

async function clearAllHistory() {
  if (!confirm('Are you sure you want to delete all history?')) return;
  try {
    await fetch(`${API_URL}/history`, { method: 'DELETE' });
    loadHistory();
    loadAnalytics();
  } catch (error) {
    console.error('Clear history error:', error);
  }
}

async function loadAnalytics() {
  try {
    const response = await fetch(`${API_URL}/analytics`);
    const data = await response.json();
    if (!data.success) return;
    document.getElementById('total-docs').textContent = data.data.total || 0;
    document.getElementById('avg-words').textContent = data.data.avgWordCount || 0;
    if (data.data.topTopics && data.data.topTopics.length) {
      document.getElementById('top-topics-box').innerHTML = `
        <p class="sidebar-label" style="margin-top:8px;">TOP TOPICS</p>
        <div style="display:flex; flex-wrap:wrap; gap:4px;">
          ${data.data.topTopics.map(t => `<span style="font-size:10px; padding:2px 8px; background:#1a1a28; border:1px solid #2a2a3e; border-radius:20px; color:#4ecdc4;">${t}</span>`).join('')}
        </div>
      `;
    }
  } catch (error) {
    console.error('Analytics error:', error);
  }
}

loadHistory();
loadAnalytics();


// ---------- Insights (charts built from /api/analytics) ----------
function escapeHTML(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function barChart(title, rows) {
  if (!rows.length) return '';
  const max = Math.max(...rows.map(r => r.count));
  const bars = rows.map(r => `
    <div class="bar-row">
      <span class="bar-label">${escapeHTML(r.label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, (r.count / max) * 100)}%"></div></div>
      <span class="bar-value">${r.count}</span>
    </div>`).join('');
  return `<div class="insight-block"><h4>${escapeHTML(title)}</h4>${bars}</div>`;
}

async function openInsights() {
  document.getElementById('insights-modal').style.display = 'flex';
  const body = document.getElementById('insights-body');
  body.innerHTML = '<p class="no-history">Loading...</p>';
  try {
    const res = await fetch(`${API_URL}/analytics`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    const d = json.data;
    if (!d.total) {
      body.innerHTML = '<p class="no-history">No documents yet. Analyze one first.</p>';
      return;
    }
    body.innerHTML = `
      <div class="insight-kpis">
        <div class="analytics-card"><div class="analytics-value">${d.total}</div><div class="analytics-label">Documents</div></div>
        <div class="analytics-card"><div class="analytics-value">${d.avgWordCount}</div><div class="analytics-label">Avg words</div></div>
      </div>
      ${barChart('Documents by summary style', d.byType.map(r => ({ label: r._id || 'unknown', count: r.count })))}
      ${barChart('Documents by tone', d.bySentiment.map(r => ({ label: r._id || 'unknown', count: r.count })))}
      ${barChart('Most common topics', d.topTopicCounts.map(r => ({ label: r.topic, count: r.count })))}
      ${barChart('Documents per day', d.byDay.slice(-7).map(r => ({ label: r._id, count: r.count })))}
    `;
  } catch (e) {
    body.innerHTML = `<p class="no-history">Could not load insights: ${escapeHTML(e.message)}</p>`;
  }
}

function closeInsights() {
  document.getElementById('insights-modal').style.display = 'none';
}

function exportCSV() {
  window.location.href = `${API_URL}/export.csv`;
}
