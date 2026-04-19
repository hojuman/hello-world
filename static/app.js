/* ── Config ───────────────────────────────────────────────────────────────── */

const CONFIG_KEY = 'fh_config';

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null'); }
  catch { return null; }
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function getConfig() {
  const cfg = loadConfig();
  if (!cfg) throw new Error('Not configured');
  return cfg;
}

/* ── Toast ────────────────────────────────────────────────────────────────── */

function showError(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/* ── API helpers ──────────────────────────────────────────────────────────── */

async function apiFetch(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(err.detail || `HTTP ${r.status}`);
  }
  return r.json();
}

/* ── Fantrax data renderer ────────────────────────────────────────────────── */

// Attempt to extract player rows from common Fantrax response structures.
// Returns { headers: string[], rows: object[] } or null if structure is unknown.
function extractPlayers(data) {
  // Common paths the Fantrax FXPA API uses across different request types
  const candidates = [
    data?.teamRosters,
    data?.roster,
    data?.availablePlayers,
    data?.players,
  ];

  for (const candidate of candidates) {
    if (candidate?.rows?.length) {
      return {
        headers: (candidate.columnHeaders || []).map(h => h.name || h.shortName || ''),
        rows: candidate.rows,
      };
    }
  }

  // Try top-level arrays
  if (Array.isArray(data?.rows) && data.rows.length) {
    return { headers: (data.columnHeaders || []).map(h => h.name || ''), rows: data.rows };
  }

  return null;
}

function scoreClass(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return '';
  if (n >= 30) return 'score-high';
  if (n >= 15) return 'score-med';
  return 'score-low';
}

function renderPlayerTable(container, data) {
  const extracted = extractPlayers(data);

  if (!extracted) {
    // Fall back: pretty-print the JSON so users can see what Fantrax returned
    container.innerHTML = `<pre class="json-view">${escHtml(JSON.stringify(data, null, 2))}</pre>`;
    return;
  }

  const { headers, rows } = extracted;

  // Key player fields we always try to display
  const table = document.createElement('table');
  table.className = 'data-table';

  // Build header
  const thead = table.createTHead();
  const hrow = thead.insertRow();
  ['Player', 'Pos', 'Team', 'Status'].forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    hrow.appendChild(th);
  });
  headers.slice(0, 8).forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    hrow.appendChild(th);
  });

  const tbody = table.createTBody();
  rows.forEach(row => {
    const tr = tbody.insertRow();

    // Name
    const nameTd = tr.insertCell();
    nameTd.innerHTML = `<span class="player-name">${escHtml(row.name || row.playerName || '—')}</span>`;
    if (row.injury || row.injuryStatus) {
      nameTd.innerHTML += ` <span class="injury-badge">${escHtml(row.injury || row.injuryStatus)}</span>`;
    }

    // Position
    const posTd = tr.insertCell();
    const pos = row.pos || row.positions || row.position || '';
    posTd.innerHTML = pos ? `<span class="player-pos">${escHtml(pos)}</span>` : '—';

    // NHL Team
    const teamTd = tr.insertCell();
    teamTd.className = 'player-team';
    teamTd.textContent = row.nflTeam || row.nhlTeam || row.teamShortName || row.team || '—';

    // Status
    const statusTd = tr.insertCell();
    statusTd.textContent = row.statusInfo || row.status || '—';

    // Stat cells
    const cells = row.cells || [];
    cells.slice(0, 8).forEach((val, i) => {
      const td = tr.insertCell();
      td.className = 'stat-val';
      const display = typeof val === 'object' ? (val?.score ?? val?.value ?? JSON.stringify(val)) : val;
      if (i === 0) td.className += ' ' + scoreClass(display); // first col is usually FP
      td.textContent = display ?? '—';
    });
  });

  container.innerHTML = '';
  container.appendChild(table);
}

// Render standings — try to find teams/rows in the response
function renderStandings(container, data) {
  const rows = data?.standings?.rows || data?.teams || data?.rows;
  if (!rows) {
    container.innerHTML = `<pre class="json-view">${escHtml(JSON.stringify(data, null, 2))}</pre>`;
    return;
  }

  const headers = (data?.standings?.columnHeaders || data?.columnHeaders || []).map(h => h.name || '');

  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = table.createTHead();
  const hrow = thead.insertRow();
  ['Rank', 'Team'].forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    hrow.appendChild(th);
  });
  headers.slice(0, 10).forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    hrow.appendChild(th);
  });

  const tbody = table.createTBody();
  rows.forEach((row, idx) => {
    const tr = tbody.insertRow();
    const rankTd = tr.insertCell();
    rankTd.textContent = row.rank ?? idx + 1;

    const nameTd = tr.insertCell();
    nameTd.innerHTML = `<span class="player-name">${escHtml(row.teamName || row.name || '—')}</span>`;

    const cells = row.cells || [];
    cells.slice(0, 10).forEach(val => {
      const td = tr.insertCell();
      td.className = 'stat-val';
      td.textContent = typeof val === 'object' ? (val?.value ?? JSON.stringify(val)) : (val ?? '—');
    });
  });

  container.innerHTML = '';
  container.appendChild(table);
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Streaming AI response ────────────────────────────────────────────────── */

async function streamRecommendations(payload) {
  const loadingEl = document.getElementById('aiLoading');
  const outputEl  = document.getElementById('aiOutput');
  const contentEl = document.getElementById('aiContent');
  const btn       = document.getElementById('getRecommendations');

  loadingEl.classList.remove('hidden');
  outputEl.classList.add('hidden');
  contentEl.textContent = '';
  btn.disabled = true;

  let accumulated = '';

  try {
    const response = await fetch('/api/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    loadingEl.classList.add('hidden');
    outputEl.classList.remove('hidden');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') break;

        const parsed = JSON.parse(raw);
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.text) {
          accumulated += parsed.text;
          contentEl.innerHTML = marked.parse(accumulated);
        }
      }
    }
  } catch (err) {
    loadingEl.classList.add('hidden');
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ── Tab switching ────────────────────────────────────────────────────────── */

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

/* ── Config modal ─────────────────────────────────────────────────────────── */

document.getElementById('configBtn').addEventListener('click', () => {
  const cfg = loadConfig();
  if (cfg) {
    document.getElementById('leagueId').value     = cfg.league_id   || '';
    document.getElementById('teamId').value       = cfg.team_id     || '';
    document.getElementById('sessionToken').value = cfg.session_token || '';
  }
  document.getElementById('configModal').classList.remove('hidden');
});

document.getElementById('cancelConfig').addEventListener('click', () => {
  document.getElementById('configModal').classList.add('hidden');
});

document.getElementById('configModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

document.getElementById('saveConfig').addEventListener('click', () => {
  const cfg = {
    league_id:     document.getElementById('leagueId').value.trim(),
    team_id:       document.getElementById('teamId').value.trim(),
    session_token: document.getElementById('sessionToken').value.trim(),
  };
  if (!cfg.league_id || !cfg.team_id || !cfg.session_token) {
    showError('Please fill in all three fields.');
    return;
  }
  saveConfig(cfg);
  document.getElementById('configModal').classList.add('hidden');
  showDashboard();
});

/* ── Show/hide dashboard ──────────────────────────────────────────────────── */

function showDashboard() {
  document.getElementById('notConfigured').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
}

/* ── AI button ────────────────────────────────────────────────────────────── */

document.getElementById('recType').addEventListener('change', function () {
  const wrap = document.getElementById('tradeInputWrapper');
  wrap.classList.toggle('hidden', this.value !== 'trade');
});

document.getElementById('getRecommendations').addEventListener('click', () => {
  let cfg;
  try { cfg = getConfig(); } catch { showError('Configure your league first.'); return; }

  const recType = document.getElementById('recType').value;
  const payload = { ...cfg, rec_type: recType };
  if (recType === 'trade') {
    payload.trade_details = document.getElementById('tradeDetails').value.trim();
    if (!payload.trade_details) { showError('Describe the trade first.'); return; }
  }
  streamRecommendations(payload);
});

/* ── Data tab buttons ─────────────────────────────────────────────────────── */

document.getElementById('refreshRoster').addEventListener('click', async () => {
  const container = document.getElementById('rosterContent');
  container.innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading roster…</span></div>';
  try {
    const cfg  = getConfig();
    const data = await apiFetch('/api/roster', cfg);
    renderPlayerTable(container, data);
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger);padding:16px">${escHtml(err.message)}</p>`;
    showError(err.message);
  }
});

document.getElementById('refreshWaiver').addEventListener('click', async () => {
  const container = document.getElementById('waiverContent');
  container.innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading waiver wire…</span></div>';
  try {
    const cfg  = getConfig();
    const data = await apiFetch('/api/waiver', cfg);
    renderPlayerTable(container, data);
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger);padding:16px">${escHtml(err.message)}</p>`;
    showError(err.message);
  }
});

document.getElementById('refreshStandings').addEventListener('click', async () => {
  const container = document.getElementById('standingsContent');
  container.innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading standings…</span></div>';
  try {
    const cfg  = getConfig();
    const data = await apiFetch('/api/standings', cfg);
    renderStandings(container, data);
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger);padding:16px">${escHtml(err.message)}</p>`;
    showError(err.message);
  }
});

/* ── Init ─────────────────────────────────────────────────────────────────── */

if (loadConfig()) showDashboard();
