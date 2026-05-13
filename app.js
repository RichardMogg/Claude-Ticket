// ─── Konstanten ──────────────────────────────────────────────
const STORAGE_KEY = 'ticketsystem_v1';

const PRI = {
  high:   { label: 'Hoch',    dot: '🔴', cls: 'pri-high' },
  medium: { label: 'Mittel',  dot: '🟡', cls: 'pri-medium' },
  low:    { label: 'Niedrig', dot: '🟢', cls: 'pri-low' },
};

const STA = {
  'open':        { label: 'Offen',          cls: 'sta-open' },
  'in-progress': { label: 'In Bearbeitung', cls: 'sta-inprogress' },
  'done':        { label: 'Erledigt',       cls: 'sta-done' },
};

// ─── State ───────────────────────────────────────────────────
const state = {
  tickets:        [],
  selectedId:     null,
  view:           'empty',   // empty | create | detail
  filterStatus:   'all',
  filterPriority: 'all',
  noteText:       '',
  form: { title: '', desc: '', priority: 'medium', date: '', time: '', email: null },
};

const notifTimers = {};

// ─── Hilfsfunktionen ─────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmt(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('de-AT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function dueInfo(dueDate, status) {
  if (!dueDate || status === 'done') return null;
  const diff = Math.floor((new Date(dueDate) - Date.now()) / 86400000);
  if (diff < 0)   return { label: 'Überfällig',    cls: 'due-overdue' };
  if (diff === 0) return { label: 'Heute fällig',  cls: 'due-today' };
  if (diff === 1) return { label: 'Morgen fällig', cls: 'due-soon' };
  return { label: `in ${diff} Tagen`, cls: 'due-normal' };
}

function parseEml(text) {
  const lines = text.split(/\r?\n/);
  const h = {}; let i = 0;
  while (i < lines.length && lines[i].trim()) {
    const m = lines[i].match(/^([\w-]+):\s*(.*)/i);
    if (m) h[m[1].toLowerCase()] = m[2];
    i++;
  }
  const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  return {
    subject: h['subject'] || '(Kein Betreff)',
    from:    h['from']    || 'Unbekannt',
    body:    body.substring(0, 800),
  };
}

// .msg ist ein binäres Format – wir scannen nach UTF-16LE Strings
function parseMsg(buffer) {
  const u8 = new Uint8Array(buffer);
  const strings = [];
  let current = '';

  for (let i = 0; i < u8.length - 1; i++) {
    if (u8[i + 1] === 0 && u8[i] >= 32 && u8[i] < 127) {
      current += String.fromCharCode(u8[i]);
      i++; // zweites Byte (0x00) überspringen
    } else {
      if (current.length >= 4) strings.push(current);
      current = '';
    }
  }
  if (current.length >= 4) strings.push(current);

  // Heuristisch: E-Mail-Adresse = From, längerer Text = Subject / Body
  let from    = '';
  let subject = '';
  let body    = '';

  for (const s of strings) {
    if (!from && s.includes('@') && s.length < 200) {
      from = s;
      continue;
    }
    if (!subject && s.length > 4 && s.length < 200
        && !s.includes('@') && !/^[\d\s\-\/:\\]+$/.test(s)) {
      subject = s;
      continue;
    }
  }

  // Längster sinnvoller String als Body-Kandidat
  const bodyCandidate = strings
    .filter(s => s.length > 30)
    .sort((a, b) => b.length - a.length)[0] || '';
  body = bodyCandidate.substring(0, 800);

  return {
    subject: subject || '(Kein Betreff)',
    from:    from    || 'Unbekannt',
    body,
  };
}

// ─── Storage ─────────────────────────────────────────────────
function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tickets));
}

function loadTickets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state.tickets = JSON.parse(raw);
  } catch {}
}

// ─── Ticket-Operationen ──────────────────────────────────────
function createTicket() {
  const { title, desc, priority, date, time, email } = state.form;
  if (!title.trim()) { alert('Bitte einen Titel eingeben.'); return; }
  const dueDate = date ? new Date(`${date}T${time || '09:00'}`).toISOString() : null;
  const ticket = {
    id:        Date.now().toString(),
    title:     title.trim(),
    desc:      desc.trim(),
    priority,
    status:    'open',
    dueDate,
    createdAt: new Date().toISOString(),
    notes:     [],
    email,
  };
  state.tickets.unshift(ticket);
  persist();
  state.form = { title: '', desc: '', priority: 'medium', date: '', time: '', email: null };
  state.selectedId = ticket.id;
  state.view = 'detail';
  render();
}

function updateStatus(id, status) {
  const t = state.tickets.find(x => x.id === id);
  if (t) { t.status = status; persist(); render(); }
}

function addNote(ticketId, text) {
  if (!text.trim()) return;
  const t = state.tickets.find(x => x.id === ticketId);
  if (!t) return;
  t.notes.push({ id: Date.now().toString(), text: text.trim(), at: new Date().toISOString() });
  persist();
  state.noteText = '';
  render();
}

// ─── Erinnerungen ────────────────────────────────────────────
function scheduleNotifications() {
  Object.values(notifTimers).forEach(clearTimeout);
  if (Notification.permission !== 'granted') return;
  state.tickets.forEach(t => {
    if (!t.dueDate || t.status === 'done') return;
    const ms = new Date(t.dueDate) - Date.now();
    if (ms > 0)
      notifTimers[t.id] = setTimeout(
        () => new Notification('⏰ ' + t.title, { body: 'Ticket ist jetzt fällig!' }), ms
      );
  });
}

// ─── Sidebar rendern ─────────────────────────────────────────
function renderSidebar() {
  const sidebar = document.getElementById('sidebar');

  const filtered    = state.tickets.filter(t =>
    (state.filterStatus   === 'all' || t.status   === state.filterStatus) &&
    (state.filterPriority === 'all' || t.priority === state.filterPriority)
  );
  const openCount    = state.tickets.filter(t => t.status !== 'done').length;
  const overdueCount = state.tickets.filter(t =>
    t.dueDate && t.status !== 'done' && new Date(t.dueDate) < Date.now()
  ).length;

  const filterBtns = [['all','Alle'],['open','Offen'],['in-progress','Bearb.'],['done','Erledigt']]
    .map(([v, l]) =>
      `<button class="filter-btn ${state.filterStatus === v ? 'active' : ''}" data-status="${v}">${l}</button>`
    ).join('');

  const cards = filtered.map(t => {
    const due    = dueInfo(t.dueDate, t.status);
    const active = state.selectedId === t.id;
    return `
      <div class="ticket-card ${active ? 'active' : ''}" data-id="${t.id}">
        <div class="ticket-card-top">
          <span class="ticket-title">${t.email ? '📧 ' : ''}${esc(t.title)}</span>
          <span class="badge ${PRI[t.priority].cls}">${PRI[t.priority].label}</span>
        </div>
        <div class="ticket-card-bottom">
          <span class="badge ${STA[t.status].cls}">${STA[t.status].label}</span>
          <div class="ticket-card-meta">
            ${t.notes?.length ? `<span class="note-count">💬${t.notes.length}</span>` : ''}
            ${due ? `<span class="due-badge ${due.cls}">⏱ ${due.label}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('') || '<div class="empty-list">Keine Tickets gefunden</div>';

  const notifBtn = Notification.permission !== 'granted'
    ? `<div class="notif-area"><button id="btn-notif">🔔 Erinnerungen aktivieren</button></div>`
    : '';

  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="sidebar-title-area">
        <div class="sidebar-title">🎫 Ticketsystem</div>
        <div class="sidebar-sub">
          ${openCount} offen
          ${overdueCount > 0 ? `<span class="overdue-count">· ${overdueCount} überfällig</span>` : ''}
        </div>
      </div>
      <button id="btn-new">+ Neu</button>
    </div>
    <div class="filter-area">
      <div class="filter-status">${filterBtns}</div>
      <select id="filter-priority">
        <option value="all"    ${state.filterPriority==='all'    ?'selected':''}>Alle Prioritäten</option>
        <option value="high"   ${state.filterPriority==='high'   ?'selected':''}>🔴 Hoch</option>
        <option value="medium" ${state.filterPriority==='medium' ?'selected':''}>🟡 Mittel</option>
        <option value="low"    ${state.filterPriority==='low'    ?'selected':''}>🟢 Niedrig</option>
      </select>
    </div>
    <div class="ticket-list">${cards}</div>
    ${notifBtn}
  `;

  document.getElementById('btn-new').addEventListener('click', () => {
    state.view = 'create'; state.selectedId = null; render();
  });
  sidebar.querySelectorAll('.filter-btn').forEach(btn =>
    btn.addEventListener('click', () => { state.filterStatus = btn.dataset.status; render(); })
  );
  document.getElementById('filter-priority').addEventListener('change', e => {
    state.filterPriority = e.target.value; render();
  });
  sidebar.querySelectorAll('.ticket-card').forEach(card =>
    card.addEventListener('click', () => {
      state.selectedId = card.dataset.id; state.view = 'detail'; render();
    })
  );
  document.getElementById('btn-notif')?.addEventListener('click', async () => {
    await Notification.requestPermission(); scheduleNotifications(); render();
  });
}

// ─── Main rendern ────────────────────────────────────────────
function renderMain() {
  const main = document.getElementById('main');

  // EMPTY
  if (state.view === 'empty') {
    main.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎫</div>
        <div class="empty-title">Kein Ticket ausgewählt</div>
        <div class="empty-sub">Wähle ein Ticket aus oder erstelle ein neues</div>
        <button id="btn-new-main">+ Neues Ticket erstellen</button>
      </div>`;
    document.getElementById('btn-new-main').addEventListener('click', () => {
      state.view = 'create'; render();
    });
    return;
  }

  // CREATE
  if (state.view === 'create') {
    const f = state.form;
    main.innerHTML = `
      <div class="form-wrap">
        <h2>Neues Ticket erstellen</h2>
        <div class="drop-zone ${f.email ? 'has-email' : ''}" id="drop-zone">
          ${f.email ? `
            <div class="drop-email-info">
              <div>
                <div class="drop-email-subject">📧 ${esc(f.email.subject)}</div>
                <div class="drop-email-from">Von: ${esc(f.email.from)}</div>
              </div>
              <button class="btn-clear" id="btn-clear-email">×</button>
            </div>` : `
            <div class="drop-placeholder">
              <div class="drop-icon">📧</div>
              <div class="drop-label">E-Mail (.eml / .msg) hier hineinziehen</div>
              <div class="drop-sub">Betreff & Inhalt werden automatisch übernommen</div>
            </div>`}
        </div>
        <div class="form-fields">
          <div class="field">
            <label for="f-title">Titel *</label>
            <input id="f-title" type="text" placeholder="Titel des Tickets" value="${esc(f.title)}">
          </div>
          <div class="field">
            <label for="f-desc">Beschreibung</label>
            <textarea id="f-desc" rows="4" placeholder="Beschreibung...">${esc(f.desc)}</textarea>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="f-priority">Priorität</label>
              <select id="f-priority">
                <option value="high"   ${f.priority==='high'  ?'selected':''}>🔴 Hoch</option>
                <option value="medium" ${f.priority==='medium'?'selected':''}>🟡 Mittel</option>
                <option value="low"    ${f.priority==='low'   ?'selected':''}>🟢 Niedrig</option>
              </select>
            </div>
            <div class="field">
              <label for="f-date">Fälligkeitsdatum</label>
              <input id="f-date" type="date" value="${esc(f.date)}">
            </div>
            <div class="field">
              <label for="f-time">Uhrzeit</label>
              <input id="f-time" type="time" value="${esc(f.time)}">
            </div>
          </div>
          <div class="form-actions">
            <button id="btn-create" class="btn-primary">Ticket erstellen</button>
            <button id="btn-cancel" class="btn-secondary">Abbrechen</button>
          </div>
        </div>
      </div>`;

    const sync = () => {
      state.form.title    = document.getElementById('f-title').value;
      state.form.desc     = document.getElementById('f-desc').value;
      state.form.priority = document.getElementById('f-priority').value;
      state.form.date     = document.getElementById('f-date').value;
      state.form.time     = document.getElementById('f-time').value;
    };
    ['f-title','f-desc','f-priority','f-date','f-time'].forEach(id =>
      document.getElementById(id)?.addEventListener('input', sync)
    );
    document.getElementById('btn-create').addEventListener('click', () => { sync(); createTicket(); });
    document.getElementById('btn-cancel').addEventListener('click', () => {
      state.view = state.selectedId ? 'detail' : 'empty'; render();
    });
    document.getElementById('btn-clear-email')?.addEventListener('click', () => {
      state.form = { ...state.form, email: null, title: '', desc: '' }; render();
    });

    const dz = document.getElementById('drop-zone');
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      const name = file?.name.toLowerCase() || '';
      if (!name.endsWith('.eml') && !name.endsWith('.msg')) {
        alert('Bitte eine .eml oder .msg Datei verwenden.'); return;
      }
      if (name.endsWith('.msg')) {
        const rd = new FileReader();
        rd.onload = ev => {
          const p = parseMsg(ev.target.result);
          state.form.email = p;
          state.form.title = p.subject;
          state.form.desc  = `Von: ${p.from}\n\n${p.body}`;
          render();
        };
        rd.readAsArrayBuffer(file);
      } else {
        const rd = new FileReader();
        rd.onload = ev => {
          const p = parseEml(ev.target.result);
          state.form.email = p;
          state.form.title = p.subject;
          state.form.desc  = `Von: ${p.from}\n\n${p.body}`;
          render();
        };
        rd.readAsText(file);
      }
    });
    return;
  }

  // DETAIL
  if (state.view === 'detail') {
    const t = state.tickets.find(x => x.id === state.selectedId);
    if (!t) { state.view = 'empty'; render(); return; }

    const due = dueInfo(t.dueDate, t.status);
    const statusOpts = Object.entries(STA)
      .map(([v, s]) => `<option value="${v}" ${t.status===v?'selected':''}>${s.label}</option>`)
      .join('');
    const noteItems = t.notes.map(n => `
      <div class="note-item">
        <div class="note-time">${fmt(n.at)}</div>
        <div class="note-text">${esc(n.text)}</div>
      </div>`).join('');

    main.innerHTML = `
      <div class="detail-wrap">
        ${t.email ? `<div class="email-badge">📧 AUS E-MAIL · ${esc(t.email.from)}</div>` : ''}
        <h1 class="detail-title">${esc(t.title)}</h1>
        <div class="detail-created">Erstellt: ${fmt(t.createdAt)}</div>
        <div class="detail-meta">
          <span class="badge ${PRI[t.priority].cls}">${PRI[t.priority].dot} ${PRI[t.priority].label}</span>
          <select id="status-select" class="status-select ${STA[t.status].cls}">${statusOpts}</select>
          ${t.dueDate
            ? `<span class="badge ${due ? due.cls : 'due-normal'}">
                📅 ${fmt(t.dueDate)}${due ? ' · ' + due.label : ''}
               </span>`
            : ''}
        </div>
        ${t.desc ? `
          <div class="detail-section">
            <div class="section-label">Beschreibung</div>
            <div class="detail-desc">${esc(t.desc)}</div>
          </div>` : ''}
        <div class="detail-section notes-section">
          <div class="section-label">
            💬 Notizen
            ${t.notes.length ? `<span class="note-cnt">(${t.notes.length})</span>` : ''}
          </div>
          ${!t.notes.length ? '<div class="no-notes">Noch keine Notizen vorhanden.</div>' : ''}
          <div class="notes-list">${noteItems}</div>
          <div class="note-input-row">
            <textarea id="note-input" rows="2"
              placeholder="Notiz hinzufügen… (Strg+Enter zum Speichern)">${esc(state.noteText)}</textarea>
            <button id="btn-add-note" class="btn-primary">+ Notiz</button>
          </div>
        </div>
      </div>`;

    document.getElementById('status-select').addEventListener('change', e =>
      updateStatus(t.id, e.target.value)
    );
    const ni = document.getElementById('note-input');
    ni.addEventListener('input', e => state.noteText = e.target.value);
    ni.addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) addNote(t.id, state.noteText); });
    document.getElementById('btn-add-note').addEventListener('click', () =>
      addNote(t.id, state.noteText)
    );
  }
}

// ─── Haupt-Render ────────────────────────────────────────────
function render() {
  renderSidebar();
  renderMain();
  scheduleNotifications();
}

// ─── Start ───────────────────────────────────────────────────
loadTickets();
render();
