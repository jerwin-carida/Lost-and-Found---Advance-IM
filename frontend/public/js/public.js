import { api, esc, fmt, toast } from './common.js';

const grid = document.querySelector('#grid');
const q = document.querySelector('#q');
const dialog = document.querySelector('#claimDialog');
const form = document.querySelector('#claimForm');
const err = document.querySelector('#claimErr');
const LABEL = { lost: 'Reported lost', found: 'Found at hub', forgotten: 'Unclaimed' };
let status = '';
let itemId = null;

async function load() {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (q.value.trim()) qs.set('q', q.value.trim());
  try {
    const items = await api(`/api/items?${qs}`);
    grid.innerHTML = items.length ? items.map(card).join('')
      : '<p class="empty">No items match. Try a different word, or check back after the hub desk opens.</p>';
  } catch (e) { grid.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

const card = (i) => `
  <article class="tag ${i.status}">
    <span class="badge">${LABEL[i.status]}</span>
    <h3>${esc(i.description)}</h3>
    <p class="meta">Logged ${fmt(i.reportedAt)}</p>
    ${i.status === 'lost'
      ? '<p class="note">Found this? Bring it to the hub desk.</p>'
      : `<button class="btn" data-id="${i.itemId}" data-desc="${esc(i.description)}">Claim this item</button>`}
  </article>`;

document.querySelector('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', c === b));
  status = b.dataset.status; load();
});
let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });

grid.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]'); if (!b) return;
  itemId = b.dataset.id;
  document.querySelector('#claimItem').textContent = b.dataset.desc;
  const soon = new Date(Date.now() + 3600e3 - new Date().getTimezoneOffset() * 60e3);
  form.proposedSchedule.min = soon.toISOString().slice(0, 16);
  err.textContent = ''; dialog.showModal();
});
document.querySelector('#cancelClaim').addEventListener('click', () => dialog.close());

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(form));
  try {
    const r = await api('/api/claim-requests', { method: 'POST', body: { ...d, itemId, proposedSchedule: new Date(d.proposedSchedule).toISOString() } });
    dialog.close(); form.reset(); toast(r.message);
  } catch (ex) { err.textContent = ex.message; }
});

load();
