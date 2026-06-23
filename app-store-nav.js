// ─── App Store Integration Navigation ────────────────────────────────────────

const INTEGRATIONS = ['obs', 'games', 'startgg', 'twitch', 'twitchgames'];
let currentIntegration = null;

function _integStoreElements() {
  return {
    store: document.getElementById('integration-store'),
    searchBar: document.getElementById('integration-search-bar'),
    pageHead: document.querySelector('#tab-integrations-content > .page-head'),
  };
}

// Show app store grid
function showAppStore() {
  currentIntegration = null;

  const { store, searchBar, pageHead } = _integStoreElements();

  // Hide all integration panels
  INTEGRATIONS.forEach(key => {
    const panel = document.getElementById(`integration-${key}`);
    if (panel) panel.style.display = 'none';
  });

  // Show store chrome
  if (store) store.style.display = 'grid';
  if (searchBar) searchBar.style.display = 'flex';
  if (pageHead) pageHead.style.display = 'block';
}

// Show a specific integration detail (hides the store grid)
function showIntegration(integrationKey) {
  currentIntegration = integrationKey;

  const { store, searchBar, pageHead } = _integStoreElements();

  // Hide store chrome
  if (store) store.style.display = 'none';
  if (searchBar) searchBar.style.display = 'none';
  if (pageHead) pageHead.style.display = 'none';

  // Show matching panel(s); for twitch, also show the games panel inline below
  INTEGRATIONS.forEach(key => {
    const panel = document.getElementById(`integration-${key}`);
    if (!panel) return;
    const show = key === integrationKey || (integrationKey === 'twitch' && key === 'twitchgames');
    panel.style.display = show ? 'block' : 'none';
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Inject a back button into each panel (skip twitchgames — it shows under twitch's back button)
function initializeBackButtons() {
  INTEGRATIONS.forEach(key => {
    if (key === 'twitchgames') return; // shown as part of the twitch view

    const panel = document.getElementById(`integration-${key}`);
    if (!panel) return;

    const existing = panel.querySelector('.integration-back-btn');
    if (existing) existing.remove();

    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-secondary btn-sm integration-back-btn';
    backBtn.innerHTML = '← Back to Integrations';
    backBtn.style.marginBottom = '16px';
    backBtn.addEventListener('click', showAppStore);

    panel.insertBefore(backBtn, panel.firstChild);
  });
}

// ── Game-tab switching inside #integration-games ──────────────────────────────
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.game-tab-btn');
  if (!btn) return;
  const game = btn.dataset.game;
  document.querySelectorAll('.game-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.game-section').forEach(s => s.classList.toggle('active', s.id === `games-section-${game}`));
});

// ── Card click → open detail ──────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const card = e.target.closest('.integration-card');
  if (!card) return;

  const integration = card.dataset.integration;
  if (!integration) return;

  // Only trigger on the card itself or its button (not links)
  if (!e.target.closest('a')) {
    showIntegration(integration);
  }
});

// ── Search / filter ───────────────────────────────────────────────────────────
const _searchInput = document.getElementById('integration-search');
if (_searchInput) {
  _searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    let visibleCount = 0;

    document.querySelectorAll('.integration-card').forEach(card => {
      const text = ((card.querySelector('h4')?.textContent || '') + ' ' + (card.querySelector('p')?.textContent || '')).toLowerCase();
      const matches = query === '' || text.includes(query);
      card.style.display = matches ? '' : 'none';
      if (matches) visibleCount++;
    });

    const countEl = document.getElementById('integration-count');
    if (countEl) countEl.textContent = `${visibleCount} app${visibleCount !== 1 ? 's' : ''}`;
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
function _init() {
  initializeBackButtons();
  showAppStore();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}
