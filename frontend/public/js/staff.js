import { api, esc, fmt, toast } from './common.js';

const S = '/api/staff';
const panel = document.querySelector('#panel');
const tabsEl = document.querySelector('#tabs');
let me;
const filter = { status: '', q: '' };

// Run an async action from a button: disable it, report errors as a toast.
async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}
const bodyOf = (form) => Object.fromEntries(new FormData(form));
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;

// ---------------- Claims ----------------
async function claims() {
  const [stats, list] = await Promise.all([api(`${S}/stats`), api(`${S}/claims?status=pending`)]);
  const box = (n, label) => `<div class="stat"><b>${n ?? 0}</b>${label}</div>`;
  panel.innerHTML = `
    <div class="stats">
      ${box(stats.pendingClaims, 'claims waiting')}${box(stats.items.found, 'found')}
      ${box(stats.items.lost, 'lost')}${box(stats.items.forgotten, 'unclaimed')}${box(stats.items.claimed, 'returned')}
    </div>
    <h2>Pending claims</h2>
    <p class="meta">Check the student's ID in person before you approve.</p>
    ${list.length ? list.map((c) => `
      <div class="card row">
        <div>
          ${badge('pending')} <strong>${esc(c.description)}</strong>
          <p class="meta">Claimant: ${esc(c.claimantName)}. Contact: ${esc(c.claimantContact)}</p>
          <p class="meta">Proposed pickup: ${fmt(c.proposedSchedule)}. Sent ${fmt(c.submittedAt)}</p>
        </div>
        <div class="actions">
          <button class="btn good small" data-act="verify" data-id="${c.requestId}">Approve</button>
          <button class="btn bad small" data-act="reject" data-id="${c.requestId}">Reject</button>
        </div>
      </div>`).join('') : '<p class="empty">No pending claims. New ones from students appear here.</p>'}`;
  panel.onclick = (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    act(b, async () => {
      const r = await api(`${S}/claims/${b.dataset.id}/${b.dataset.act}`, { method: 'PATCH' });
      toast(r.message); claims();
    }).then(() => {});
  };
  panel.onsubmit = panel.onchange = null;
}

// ---------------- Items ----------------
async function items() {
  const qs = new URLSearchParams(filter);
  const list = await api(`${S}/items?${qs}`);
  const admin = me.role === 'admin';
  panel.innerHTML = `
    <div class="panel-head">
      <form id="filter" class="finder" style="margin:0">
        <select name="status" aria-label="Status" style="width:auto">
          ${['', 'lost', 'found', 'forgotten', 'claimed'].map((s) => `<option value="${s}" ${filter.status === s ? 'selected' : ''}>${s || 'All statuses'}</option>`).join('')}
        </select>
        <input type="search" name="q" value="${esc(filter.q)}" placeholder="Search description" style="width:240px">
        <button class="btn alt small">Search</button>
      </form>
      <form id="sweep" class="finder" style="margin:0">
        <label style="margin:0">Mark found items older than
          <input type="number" name="days" value="30" min="0" style="width:5rem;display:inline-block"> days as unclaimed</label>
        <button class="btn small">Run</button>
      </form>
    </div>
    <div class="table-wrap"><table>
      <tr><th>ID</th><th>Item</th><th>Status</th><th>Logged</th>${admin ? '<th></th>' : ''}</tr>
      ${list.map((i) => `<tr>
        <td>${i.itemId}</td><td>${esc(i.description)}</td>
        <td>${i.status === 'claimed' ? badge('claimed') : `<select data-id="${i.itemId}">
          ${['lost', 'found', 'forgotten'].map((s) => `<option ${s === i.status ? 'selected' : ''}>${s}</option>`).join('')}</select>`}</td>
        <td>${fmt(i.reportedAt)}</td>
        ${admin ? `<td><button class="btn bad small" data-del="${i.itemId}">Delete</button></td>` : ''}
      </tr>`).join('') || '<tr><td colspan="5" class="empty">No items match.</td></tr>'}
    </table></div>`;
  panel.onsubmit = (e) => {
    e.preventDefault();
    if (e.target.id === 'filter') { Object.assign(filter, bodyOf(e.target)); items(); }
    if (e.target.id === 'sweep') act(null, async () => {
      const r = await api(`${S}/items/sweep`, { method: 'POST', body: { days: Number(e.target.days.value) } });
      toast(`${r.moved} item(s) marked as unclaimed.`); items();
    });
  };
  panel.onchange = (e) => {
    if (!e.target.dataset.id) return;
    act(null, async () => { await api(`${S}/items/${e.target.dataset.id}`, { method: 'PATCH', body: { status: e.target.value } }); toast('Status updated.'); })
      .then(items);
  };
  panel.onclick = (e) => {
    const b = e.target.closest('button[data-del]'); if (!b || !confirm('Delete this item and its history?')) return;
    act(b, async () => { await api(`${S}/items/${b.dataset.del}`, { method: 'DELETE' }); toast('Item deleted.'); items(); });
  };
}

// ---------------- Add item ----------------
// Size, color and item are combined into one description: "Small blue water bottle".
// Adjective order in English is size, then color, then the noun.
const descFields = (o) => `
  <label>Size <select name="size" required>
    <option value="" disabled selected>Choose a size</option>
    ${o.sizes.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
  <label>Color <select name="color" required>
    <option value="" disabled selected>Choose a color</option>
    ${o.colors.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
  <label>Item <input name="item" required maxlength="100" pattern="[A-Za-z0-9-]+(_[A-Za-z0-9-]+)*" title="Letters, numbers and - only, with _ between words" placeholder="e.g. water_bottle, backpack, usb-c_charger"></label>
  <p class="meta">No spaces. Use _ between words.</p>
  <p class="meta">Description: <strong data-preview>-</strong></p>`;

function updatePreview(form) {
  const el = form.querySelector('[data-preview]');
  if (!el) return;   // other tabs have forms without a preview
  const skip = ['Not applicable', 'Unknown'];
  const f = Object.fromEntries(new FormData(form));
  const adj = [f.size, f.color].filter((x) => x && !skip.includes(x)).map((x) => x.toLowerCase());
  const item = (f.item || '').trim().split('_').filter(Boolean).join(' ');
  const text = [...adj, item].join(' ').trim();
  el.textContent = text ? text[0].toUpperCase() + text.slice(1) : '-';
}

async function add() {
  const o = await api(`${S}/item-options`);
  panel.innerHTML = `
    <div class="two">
      <form class="card" id="deposit">
        <h2>Accept a found item</h2>
        <p class="meta">Record who handed it in. Their name and contact are encrypted before they reach the database.</p>
        ${descFields(o)}
        <label>Handed in by <input name="personName" required maxlength="100"></label>
        <label>Their contact (phone, email or student ID) <input name="personContact" required maxlength="150"></label>
        <button class="btn">Save deposit</button>
      </form>
      <form class="card" id="lost">
        <h2>Log a lost item</h2>
        <p class="meta">For someone who reported an item missing at the desk.</p>
        ${descFields(o)}
        <button class="btn">Add to lost list</button>
      </form>
    </div>`;
  panel.onclick = panel.onchange = null;
  panel.oninput = (e) => { if (e.target.form) updatePreview(e.target.form); };
  panel.onchange = panel.oninput;
  panel.onsubmit = (e) => {
    e.preventDefault();
    const url = e.target.id === 'deposit' ? `${S}/transactions` : `${S}/items`;
    act(e.target.querySelector('button'), async () => {
      await api(url, { method: 'POST', body: bodyOf(e.target) }); e.target.reset(); updatePreview(e.target); toast('Saved.');
    });
  };
}

// ---------------- History ----------------
async function historyTab() {
  const rows = await api(`${S}/transactions`);
  panel.innerHTML = `<h2>Transaction history</h2><p class="meta">Names and contacts are decrypted here for staff only.</p>
    <div class="table-wrap"><table>
    <tr><th>#</th><th>Type</th><th>Item</th><th>Person</th><th>Contact</th><th>Handled by</th><th>When</th></tr>
    ${rows.map((t) => `<tr><td>${t.transactionId}</td><td>${esc(t.type)}</td><td>${esc(t.description)}</td>
      <td>${esc(t.person)}</td><td>${esc(t.contact)}</td><td>${esc(t.staff)}</td><td>${fmt(t.timestamp)}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">No deposits or claims yet.</td></tr>'}
    </table></div>`;
  panel.onclick = panel.onchange = panel.onsubmit = null;
}

// ---------------- Staff accounts (admin) ----------------
async function users() {
  const list = await api(`${S}/users`);
  panel.innerHTML = `<div class="two"><div>
      <h2>Staff accounts</h2>
      <div class="table-wrap"><table><tr><th>Name</th><th>Role</th><th>Contact (decrypted)</th><th></th></tr>
      ${list.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.role)}</td><td>${esc(u.contact)}</td>
        <td>${u.userId === me.userId ? '<span class="meta">You</span>' : `<button class="btn bad small" data-del="${u.userId}" data-name="${esc(u.name)}">Delete</button>`}</td></tr>`).join('')}</table></div></div>
    <form class="card" id="newUser"><h2>Add staff account</h2>
      <label>Name <input name="name" required maxlength="50"></label>
      <label>Password (6+ characters) <input type="password" name="password" required minlength="6"></label>
      <label>Contact <input name="contact" required maxlength="150"></label>
      <label>Role <select name="role"><option>moderator</option><option>admin</option></select></label>
      <button class="btn">Create account</button></form></div>`;
  panel.onchange = null;
  panel.onclick = (e) => {
    const b = e.target.closest('button[data-del]'); if (!b) return;
    if (!confirm(`Delete the account "${b.dataset.name}"? This cannot be undone.`)) return;
    act(b, async () => { await api(`${S}/users/${b.dataset.del}`, { method: 'DELETE' }); toast('Account deleted.'); users(); });
  };
  panel.onsubmit = (e) => {
    e.preventDefault();
    act(e.target.querySelector('button'), async () => { await api(`${S}/users`, { method: 'POST', body: bodyOf(e.target) }); toast('Account created.'); users(); });
  };
}

// ---------------- Demo (admin) ----------------
const out = (id, html) => { document.querySelector(`#${id}`).innerHTML = html; };
const pre = (t) => `<pre>${esc(t)}</pre>`;
const snap = (s) => `item: ${s.itemStatus}\nclaims: ${s.claims.join(', ')}\ntransaction rows: ${s.transactionRows}\nlog rows: ${s.logRows}`;

function demo() {
  panel.innerHTML = `<div class="demo">
    <h2>Demo console</h2>

    <h3>1. Transactions</h3>
    <p>Approving a claim writes to five tables. Each button creates a fresh test item with two rival claims, then runs the approval.</p>
    <div class="btns">
      <button class="btn small" data-demo="tx:rollback">Approve, then crash midway</button>
      <button class="btn small" data-demo="tx:commit">Approve normally</button>
      <button class="btn small" data-demo="tx:race">Two staff approve at once</button>
    </div><div id="txOut"></div>

    <h3>2. Encryption</h3>
    <p>Names and contacts are AES-256-CBC ciphertext in the database. Passwords are bcrypt hashes.</p>
    <div class="btns">
      <button class="btn small" data-demo="enc:inspect">Show latest rows: raw vs decrypted</button>
      <input id="encText" value="Maria Santos" style="width:200px" aria-label="Text to encrypt">
      <button class="btn small" data-demo="enc:try">Encrypt this text twice</button>
    </div><div id="encOut"></div>

    <h3>3. Authorization in the database</h3>
    <p>Same statements, three database roles. Every statement matches no rows, so nothing is changed; Postgres only checks the GRANTs.</p>
    <div class="btns"><button class="btn small" data-demo="authz">Run permission matrix</button></div><div id="authzOut"></div>

    <h3>4. Query optimization</h3>
    <p>Load 200,000 test items, run EXPLAIN ANALYZE, add the indexes, and run it again.</p>
    <div class="btns">
      <button class="btn small alt" data-demo="opt:seed">Load test data</button>
      <button class="btn small alt" data-demo="opt:unseed">Remove test data</button>
      <button class="btn small alt" data-demo="opt:create">Create indexes</button>
      <button class="btn small alt" data-demo="opt:drop">Drop indexes</button>
    </div>
    <div class="btns" style="margin-top:.6rem">
      <button class="btn small" data-demo="opt:explain:dashboard">Dashboard: newest lost items</button>
      <button class="btn small" data-demo="opt:explain:history">Item history lookup</button>
      <button class="btn small" data-demo="opt:explain:pending">Pending claims queue</button>
    </div><div id="optOut"></div>
  </div>`;
  panel.onsubmit = panel.onchange = null;
  optState();
  panel.onclick = (e) => {
    const b = e.target.closest('button[data-demo]'); if (!b) return;
    const [group, op, arg] = b.dataset.demo.split(':');
    act(b, async () => {
      if (group === 'tx') {
        const r = await api(`${S}/demo/transaction`, { method: 'POST', body: { mode: op } });
        out('txOut', pre(`BEFORE\n${snap(r.before)}\n\nRESULT\n${r.outcome}\n\nAFTER\n${snap(r.after)}`));
      } else if (group === 'enc' && op === 'inspect') {
        const rows = await api(`${S}/demo/encryption`);
        out('encOut', rows.length ? rows.map((r) => pre(
          `transaction #${r.transactionId} (${r.type})\nname in database:    ${r.nameCipher}\nname IV:             ${r.nameIv}\ncontact in database: ${r.contactCipher}\ncontact IV:          ${r.contactIv}\n\ndecrypted name:      ${r.name}\ndecrypted contact:   ${r.contact}`)).join('')
          : '<p class="empty">No transactions yet. Accept a found item first.</p>');
      } else if (group === 'enc') {
        const r = await api(`${S}/demo/encryption/try`, { method: 'POST', body: { text: document.querySelector('#encText').value } });
        out('encOut', pre(`plaintext:        ${r.text}\n\nencrypt #1 IV:    ${r.first.iv}\nencrypt #1 data:  ${r.first.cipher}\nencrypt #2 IV:    ${r.second.iv}\nencrypt #2 data:  ${r.second.cipher}\n(same text, different ciphertext: each encryption gets a random IV)\n\ndecrypt with right key and IV: ${r.roundTrip}\ndecrypt with wrong key:        ${r.wrongKey}\ndecrypt with wrong IV:         ${r.wrongIv}\n\nbcrypt of the same text, twice (random salt, cannot be reversed):\n${r.bcrypt.join('\n')}`));
      } else if (group === 'authz') {
        const r = await api(`${S}/demo/authz`);
        out('authzOut', `<div class="table-wrap"><table><tr><th>Statement</th>${r.roles.map((x) => `<th>${esc(x)}</th>`).join('')}</tr>
          ${r.tests.map((t) => `<tr><td>${esc(t.label)}</td>${t.results.map((v) => v === true ? '<td class="yes">allowed</td>' : v === false ? '<td class="no">permission denied</td>' : `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}
          </table></div>`);
      } else if (op === 'explain') {
        const r = await api(`${S}/demo/explain`, { method: 'POST', body: { query: arg } });
        out('optOut', pre(`${r.sql}\n\n${r.plan.join('\n')}`) + `<p><strong>Execution time: ${r.executionMs} ms</strong></p>`);
      } else {
        const path = { seed: ['/demo/seed', 'POST'], unseed: ['/demo/seed', 'DELETE'], create: ['/demo/indexes', 'POST', 'create'], drop: ['/demo/indexes', 'POST', 'drop'] }[op];
        const r = await api(S + path[0], { method: path[1], body: path[2] ? { action: path[2] } : path[1] === 'POST' ? { count: 200000 } : undefined });
        optState(r); toast('Done.');
      }
    });
  };
}
async function optState(s) {
  s = s ?? await api(`${S}/demo/optimization`).catch(() => null); if (!s) return;
  out('optOut', `<p class="meta">Rows now: ${s.counts.items} items, ${s.counts.log} log, ${s.counts.claims} claim requests. Indexes present: ${s.indexes.join(', ') || 'none'}.</p>`);
}

// ---------------- Shell ----------------
const TABS = [
  { id: 'claims', label: 'Claims', render: claims },
  { id: 'items', label: 'Items', render: items },
  { id: 'add', label: 'Add item', render: add },
  { id: 'history', label: 'History', render: historyTab },
  { id: 'users', label: 'Staff accounts', admin: true, render: users },
  { id: 'demo', label: 'Demo', admin: true, render: demo },
];

async function show(id) {
  const tab = TABS.find((t) => t.id === id && (!t.admin || me.role === 'admin')) ?? TABS[0];
  tabsEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.id === tab.id));
  window.history.replaceState(null, '', `#${tab.id}`);
  try { await tab.render(); } catch (e) { panel.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

try { me = await api('/api/auth/me'); } catch { location.href = '/login'; }
document.querySelector('#who').textContent = `${me.name} (${me.role})`;
tabsEl.innerHTML = TABS.filter((t) => !t.admin || me.role === 'admin')
  .map((t) => `<button role="tab" data-id="${t.id}">${t.label}</button>`).join('');
tabsEl.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.id); });
document.querySelector('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login'; });
show(location.hash.slice(1));
