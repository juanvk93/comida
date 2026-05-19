/* ============================================
   MIMENU · Menú Semanal — App Logic
   ============================================ */

// ============ INDEXED DB ============
const DB_NAME = 'mise-db';
const DB_VERSION = 4;
const STORE_DISHES = 'dishes';
const STORE_WEEK = 'week';
const STORE_SHOPPING = 'shopping';
const STORE_SETTINGS = 'settings';

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      const upgradeTx = e.target.transaction;
      const oldVersion = e.oldVersion;

      // v0 -> v1: schema inicial.
      if (oldVersion < 1) {
        const store = database.createObjectStore(STORE_DISHES, { keyPath: 'id' });
        store.createIndex('type', 'type', { unique: false });
        database.createObjectStore(STORE_WEEK, { keyPath: 'id' });
        database.createObjectStore(STORE_SHOPPING, { keyPath: 'id' });
        database.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }

      // v1 -> v2: backfill `tags: []` en cada plato.
      if (oldVersion < 2) {
        const store = upgradeTx.objectStore(STORE_DISHES);
        store.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;
          const dish = cursor.value;
          if (!Array.isArray(dish.tags)) {
            dish.tags = [];
            cursor.update(dish);
          }
          cursor.continue();
        };
      }

      // v2 -> v3: backfill `role: 'main'` y `spices: []` en cada plato.
      if (oldVersion < 3) {
        const store = upgradeTx.objectStore(STORE_DISHES);
        store.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;
          const dish = cursor.value;
          let mutated = false;
          if (!dish.role) { dish.role = 'main'; mutated = true; }
          if (!Array.isArray(dish.spices)) { dish.spices = []; mutated = true; }
          if (mutated) cursor.update(dish);
          cursor.continue();
        };
      }

      // v3 -> v4: backfill `season: 'any'` en cada plato.
      if (oldVersion < 4) {
        const store = upgradeTx.objectStore(STORE_DISHES);
        store.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;
          const dish = cursor.value;
          if (!dish.season) {
            dish.season = 'any';
            cursor.update(dish);
          }
          cursor.continue();
        };
      }
    };
  });
}

function tx(storeName, mode = 'readonly') {
  return db.transaction(storeName, mode).objectStore(storeName);
}

const idb = {
  getAll: (store) => new Promise((res, rej) => {
    const r = tx(store).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }),
  get: (store, key) => new Promise((res, rej) => {
    const r = tx(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }),
  put: (store, val) => new Promise((res, rej) => {
    const r = tx(store, 'readwrite').put(val);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }),
  delete: (store, key) => new Promise((res, rej) => {
    const r = tx(store, 'readwrite').delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  }),
  clear: (store) => new Promise((res, rej) => {
    const r = tx(store, 'readwrite').clear();
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  })
};

// ============ STATE ============
let state = {
  dishes: [],
  week: null,
  shopping: [],
  spicesShopping: [],
  filter: 'all',
  tagFilter: null,     // null = sin filtro de etiqueta; string = nombre del tag activo
  theme: 'dark',
  seasonMode: 'any',   // 'any' | 'invierno' | 'verano' — filtra los pools de generación
  showSources: false,  // toggle UI: mostrar plato origen en cada item de la compra
  editingDish: null,
  modalIngredients: [],
  modalSpices: [],
  modalTags: [],
  customTags: []
};

// ============ UTILS ============
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const BUILTIN_TAGS = ['pasta', 'arroz', 'legumbre', 'pescado', 'carne', 'ave', 'huevo', 'verdura', 'sopa', 'ensalada'];

function availableTags() {
  // Builtin primero, luego custom; deduplicado por si el usuario añadió uno
  // con el mismo nombre que un builtin.
  const seen = new Set();
  const out = [];
  for (const t of [...BUILTIN_TAGS, ...state.customTags]) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// Multiplicadores < 1 penalizan; cuanto más pequeños, más fuerte la penalización.
// Se aplican multiplicativamente sobre un peso base de 1.0.
const SCORE = {
  sameDishInWeek: 0.08,   // por cada otra aparición del mismo plato en la semana
  sameDishAdjacent: 0.25, // si el mismo plato está en el slot inmediatamente adyacente
  tagInWeek: 0.6,         // por cada aparición de cada tag compartida en la semana
  tagAdjacent: 0.4        // por cada tag compartida con el slot adyacente
};

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// ============ THEME ============
async function initTheme() {
  const setting = await idb.get(STORE_SETTINGS, 'theme');
  state.theme = setting?.value || 'dark';
  applyTheme();
}

async function loadCustomTags() {
  const setting = await idb.get(STORE_SETTINGS, 'customTags');
  state.customTags = Array.isArray(setting?.value) ? setting.value : [];
}

async function loadSeasonMode() {
  const setting = await idb.get(STORE_SETTINGS, 'seasonMode');
  const valid = ['any', 'invierno', 'verano'];
  state.seasonMode = valid.includes(setting?.value) ? setting.value : 'any';
}

async function loadShowSources() {
  const setting = await idb.get(STORE_SETTINGS, 'showSources');
  state.showSources = setting?.value === true;
}

function applyShowSourcesCheckbox() {
  const btn = document.getElementById('toggleSources');
  if (!btn) return;
  btn.classList.toggle('active', state.showSources);
  btn.setAttribute('aria-pressed', state.showSources ? 'true' : 'false');
}

function initShowSourcesToggle() {
  const btn = document.getElementById('toggleSources');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    state.showSources = !state.showSources;
    applyShowSourcesCheckbox();
    await idb.put(STORE_SETTINGS, { key: 'showSources', value: state.showSources });
    renderShopping();
  });
}

function applySeasonChip() {
  document.querySelectorAll('.season-filter .chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.season === state.seasonMode);
  });
}

function initSeasonFilter() {
  document.querySelectorAll('.season-filter .chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      state.seasonMode = chip.dataset.season;
      applySeasonChip();
      await idb.put(STORE_SETTINGS, { key: 'seasonMode', value: state.seasonMode });
    });
  });
}

function applyTheme() {
  document.body.dataset.theme = state.theme;
  document.querySelector('meta[name="theme-color"]').setAttribute(
    'content', state.theme === 'dark' ? '#0f0e0c' : '#f6f1e7'
  );
}

async function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  await idb.put(STORE_SETTINGS, { key: 'theme', value: state.theme });
}

// ============ TABS ============
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${target}`));
    });
  });
}

// ============ DISHES VIEW ============
async function loadDishes() {
  state.dishes = await idb.getAll(STORE_DISHES);
  // Backfill perezoso de IDs de ingrediente y de especia: se persisten en el
  // próximo save del plato. Hace que la detección de renames sea robusta.
  state.dishes.forEach(d => {
    (d.ingredients || []).forEach(i => { if (!i.id) i.id = uid(); });
    (d.spices || []).forEach(s => { if (!s.id) s.id = uid(); });
    if (!d.role) d.role = 'main';
    if (!d.season) d.season = 'any';
  });
  state.dishes.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  renderDishes();
}

function renderDishes() {
  const grid = document.getElementById('dishesGrid');
  const empty = document.getElementById('emptyDishes');

  // Counts
  document.getElementById('countAll').textContent = state.dishes.length;
  document.getElementById('countLunch').textContent = state.dishes.filter(d => d.type === 'comida' || d.type === 'ambos').length;
  document.getElementById('countDinner').textContent = state.dishes.filter(d => d.type === 'cena' || d.type === 'ambos').length;

  // Filter por tipo (chips superiores)
  let filtered = state.dishes;
  if (state.filter === 'comida') filtered = state.dishes.filter(d => d.type === 'comida' || d.type === 'ambos');
  if (state.filter === 'cena') filtered = state.dishes.filter(d => d.type === 'cena' || d.type === 'ambos');

  // Filter por etiqueta (segunda fila de chips)
  if (state.tagFilter) {
    filtered = filtered.filter(d => Array.isArray(d.tags) && d.tags.includes(state.tagFilter));
  }

  renderTagFilters();

  if (state.dishes.length === 0) {
    grid.innerHTML = '';
    empty.classList.add('visible');
    return;
  }
  empty.classList.remove('visible');

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state visible" style="grid-column:1/-1;padding:60px 20px;">
      <p>No hay platos en esta categoría todavía.</p>
    </div>`;
    return;
  }

  grid.innerHTML = filtered.map(dish => {
    const typeLabel = dish.type === 'ambos' ? 'Comida · Cena' : (dish.type.charAt(0).toUpperCase() + dish.type.slice(1));
    const allIngredients = Array.isArray(dish.ingredients) ? dish.ingredients : [];
    const ingredients = allIngredients.slice(0, 4);
    const more = allIngredients.length - 4;
    const tags = Array.isArray(dish.tags) ? dish.tags : [];
    return `
      <article class="dish-card" data-id="${dish.id}">
        <div class="dish-type">${typeLabel}</div>
        <h3 class="dish-name">${escapeHtml(dish.name)}</h3>
        ${dish.description ? `<p class="dish-desc">${escapeHtml(dish.description)}</p>` : ''}
        ${tags.length > 0 ? `<div class="dish-tags">${tags.map(t => `<span class="dish-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        <div class="dish-ingredients">
          ${ingredients.map(i => `<span class="dish-ingredient-tag">${escapeHtml(i.name)}</span>`).join('')}
          ${more > 0 ? `<span class="dish-ingredient-more">+${more}</span>` : ''}
        </div>
      </article>
    `;
  }).join('');

  grid.querySelectorAll('.dish-card').forEach(card => {
    card.addEventListener('click', () => openEditDish(card.dataset.id));
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function initFilters() {
  // Solo los chips de tipo (la fila tagFilters se genera dinámicamente
  // con sus propios handlers).
  document.querySelectorAll('#view-dishes > .filters:not(.tag-filters) .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#view-dishes > .filters:not(.tag-filters) .chip')
        .forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.filter = chip.dataset.filter;
      renderDishes();
    });
  });
}

function renderTagFilters() {
  const container = document.getElementById('tagFilters');
  if (!container) return;

  // Solo mostramos tags que algún plato use de verdad.
  const used = new Set();
  state.dishes.forEach(d => (d.tags || []).forEach(t => used.add(t)));

  if (used.size === 0) {
    container.classList.remove('visible');
    container.innerHTML = '';
    // Si había filtro activo y el tag dejó de existir, lo limpiamos.
    if (state.tagFilter !== null) state.tagFilter = null;
    return;
  }

  // Si el tag actualmente filtrado ya no existe, limpiamos.
  if (state.tagFilter && !used.has(state.tagFilter)) {
    state.tagFilter = null;
  }

  container.classList.add('visible');
  const tags = Array.from(used).sort((a, b) => a.localeCompare(b, 'es'));
  const allActive = state.tagFilter === null;
  container.innerHTML = [
    `<button class="chip ${allActive ? 'active' : ''}" data-tag="">Todas</button>`,
    ...tags.map(t => {
      const active = state.tagFilter === t;
      return `<button class="chip ${active ? 'active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
    })
  ].join('');

  container.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      state.tagFilter = chip.dataset.tag || null;
      renderDishes();
    });
  });
}

// ============ MODAL ============
function openCreateDish() {
  state.editingDish = null;
  state.modalIngredients = [];
  state.modalSpices = [];
  state.modalTags = [];
  document.getElementById('modalEyebrow').textContent = '';
  document.getElementById('modalTitle').textContent = 'Nuevo plato';
  document.getElementById('dishId').value = '';
  document.getElementById('dishName').value = '';
  document.getElementById('dishDescription').value = '';
  document.querySelector('input[name="dishType"][value="comida"]').checked = true;
  document.querySelector('input[name="dishRole"][value="main"]').checked = true;
  document.querySelector('input[name="dishSeason"][value="any"]').checked = true;
  document.getElementById('deleteDish').hidden = true;
  refreshIngredientSuggestions();
  renderModalIngredients();
  renderModalSpices();
  renderModalTags();
  showModal();
}

function openEditDish(id) {
  const dish = state.dishes.find(d => d.id === id);
  if (!dish) return;
  state.editingDish = id;
  state.modalIngredients = (dish.ingredients || []).map(i => ({
    id: i.id || uid(),
    name: i.name,
    qty: i.qty
  }));
  state.modalSpices = (dish.spices || []).map(s => ({
    id: s.id || uid(),
    name: s.name,
    qty: s.qty
  }));
  state.modalTags = Array.isArray(dish.tags) ? [...dish.tags] : [];
  document.getElementById('modalEyebrow').textContent = 'Editando';
  document.getElementById('modalTitle').textContent = dish.name;
  document.getElementById('dishId').value = id;
  document.getElementById('dishName').value = dish.name;
  document.getElementById('dishDescription').value = dish.description || '';
  document.querySelector(`input[name="dishType"][value="${dish.type}"]`).checked = true;
  const role = dish.role || 'main';
  document.querySelector(`input[name="dishRole"][value="${role}"]`).checked = true;
  const season = dish.season || 'any';
  document.querySelector(`input[name="dishSeason"][value="${season}"]`).checked = true;
  document.getElementById('deleteDish').hidden = false;
  refreshIngredientSuggestions();
  renderModalIngredients();
  renderModalSpices();
  renderModalTags();
  showModal();
}

function showModal() {
  const backdrop = document.getElementById('modalBackdrop');
  backdrop.classList.add('visible');
  setTimeout(() => document.getElementById('dishName').focus(), 100);
}

function hideModal() {
  document.getElementById('modalBackdrop').classList.remove('visible');
  document.getElementById('ingredientName').value = '';
  document.getElementById('ingredientQty').value = '';
  document.getElementById('spiceName').value = '';
  document.getElementById('spiceQty').value = '';
  const newTag = document.getElementById('newTagInput');
  if (newTag) newTag.value = '';
}

function refreshIngredientSuggestions() {
  const datalist = document.getElementById('ingredientSuggestions');
  if (!datalist) return;
  // Set de nombres únicos (preserva la primera capitalización vista).
  const seen = new Map();
  state.dishes.forEach(d => {
    (d.ingredients || []).forEach(i => {
      const key = i.name.toLowerCase().trim();
      if (key && !seen.has(key)) seen.set(key, i.name);
    });
  });
  const names = Array.from(seen.values()).sort((a, b) => a.localeCompare(b, 'es'));
  datalist.innerHTML = names.map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
}

function renderModalIngredients() {
  const list = document.getElementById('ingredientList');
  if (state.modalIngredients.length === 0) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = state.modalIngredients.map((ing, idx) => `
    <li>
      <span class="ing-name">${escapeHtml(ing.name)}</span>
      ${ing.qty ? `<span class="ing-qty">${escapeHtml(ing.qty)}</span>` : ''}
      <button type="button" class="ing-remove" data-idx="${idx}" aria-label="Eliminar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </li>
  `).join('');

  list.querySelectorAll('.ing-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      state.modalIngredients.splice(idx, 1);
      renderModalIngredients();
    });
  });
}

function addIngredient() {
  const nameInput = document.getElementById('ingredientName');
  const qtyInput = document.getElementById('ingredientQty');
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }
  state.modalIngredients.push({ id: uid(), name, qty: qtyInput.value.trim() });
  nameInput.value = '';
  qtyInput.value = '';
  renderModalIngredients();
  nameInput.focus();
}

function renderModalSpices() {
  const list = document.getElementById('spiceList');
  if (!list) return;
  if (state.modalSpices.length === 0) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = state.modalSpices.map((sp, idx) => `
    <li>
      <span class="ing-name">${escapeHtml(sp.name)}</span>
      ${sp.qty ? `<span class="ing-qty">${escapeHtml(sp.qty)}</span>` : ''}
      <button type="button" class="ing-remove" data-idx="${idx}" aria-label="Eliminar especia">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </li>
  `).join('');

  list.querySelectorAll('.ing-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      state.modalSpices.splice(idx, 1);
      renderModalSpices();
    });
  });
}

function addSpice() {
  const nameInput = document.getElementById('spiceName');
  const qtyInput = document.getElementById('spiceQty');
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }
  state.modalSpices.push({ id: uid(), name, qty: qtyInput.value.trim() });
  nameInput.value = '';
  qtyInput.value = '';
  renderModalSpices();
  nameInput.focus();
}

function renderModalTags() {
  const container = document.getElementById('tagPicker');
  if (!container) return;
  container.innerHTML = availableTags().map(t => {
    const active = state.modalTags.includes(t);
    return `<button type="button" class="tag-chip ${active ? 'active' : ''}" data-tag="${escapeHtml(t)}" aria-pressed="${active}">${escapeHtml(t)}</button>`;
  }).join('');
  container.querySelectorAll('.tag-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      const idx = state.modalTags.indexOf(tag);
      if (idx >= 0) state.modalTags.splice(idx, 1);
      else state.modalTags.push(tag);
      renderModalTags();
    });
  });
}

async function addCustomTag() {
  const input = document.getElementById('newTagInput');
  if (!input) return;
  // Normalizamos: minúsculas y solo letras (incluyendo acentos/ñ), números,
  // espacios y guiones. Evita que caracteres con significado en atributos HTML
  // se cuelen al `data-tag` del chip.
  const tag = input.value.trim().toLowerCase().replace(/[^a-z0-9áéíóúñü\s-]/g, '').trim();
  if (!tag) { showToast('Etiqueta no válida'); return; }
  const exists = availableTags().some(t => t.toLowerCase() === tag);
  if (!exists) {
    state.customTags.push(tag);
    await idb.put(STORE_SETTINGS, { key: 'customTags', value: state.customTags });
  }
  if (!state.modalTags.includes(tag)) state.modalTags.push(tag);
  input.value = '';
  renderModalTags();
  input.focus();
}

async function saveDish(e) {
  e.preventDefault();
  const name = document.getElementById('dishName').value.trim();
  const description = document.getElementById('dishDescription').value.trim();
  const type = document.querySelector('input[name="dishType"]:checked').value;
  const role = document.querySelector('input[name="dishRole"]:checked').value;
  const season = document.querySelector('input[name="dishSeason"]:checked').value;

  if (!name) { showToast('Falta el nombre del plato'); return; }
  if (state.modalIngredients.length === 0) { showToast('Añade al menos un ingrediente'); return; }

  const dish = {
    id: state.editingDish || uid(),
    name,
    description,
    type,
    role,
    season,
    tags: [...state.modalTags],
    ingredients: state.modalIngredients,
    spices: state.modalSpices,
    createdAt: state.editingDish
      ? (state.dishes.find(d => d.id === state.editingDish)?.createdAt ?? Date.now())
      : Date.now()
  };

  // Detectar renames (mismo id, distinto nombre) en ingredientes Y especias
  // para que el estado `checked` de la lista de la compra sobreviva.
  const renames = new Map();
  if (state.editingDish) {
    const oldDish = state.dishes.find(d => d.id === state.editingDish);
    if (oldDish) {
      const detectRenames = (oldList, newList) => {
        for (const newItem of newList) {
          if (!newItem.id) continue;
          const oldItem = oldList.find(o => o.id === newItem.id);
          if (oldItem && oldItem.name.toLowerCase() !== newItem.name.toLowerCase()) {
            renames.set(oldItem.name.toLowerCase(), newItem.name.toLowerCase());
          }
        }
      };
      detectRenames(oldDish.ingredients || [], dish.ingredients);
      detectRenames(oldDish.spices || [], dish.spices);
    }
  }

  await idb.put(STORE_DISHES, dish);
  await loadDishes();

  // Si el plato está en la semana actual, la lista de la compra puede haber
  // quedado desfasada (rename, ingrediente añadido/eliminado). Recalcularla.
  const inCurrentWeek = state.week && state.week.some(d => d.lunch === dish.id || d.dinner === dish.id);
  if (inCurrentWeek) {
    await buildShoppingList(renames);
    renderWeek();
  }

  hideModal();
  showToast(state.editingDish ? 'Plato actualizado' : 'Plato creado');
}

async function deleteDish() {
  if (!state.editingDish) return;
  if (!confirm('¿Eliminar este plato?')) return;
  await idb.delete(STORE_DISHES, state.editingDish);
  await loadDishes();
  hideModal();
  showToast('Plato eliminado');
}

// ============ WEEK GENERATION ============
async function loadWeek() {
  const stored = await idb.get(STORE_WEEK, 'current');
  if (!stored?.data) {
    state.week = null;
    renderWeek();
    return;
  }
  // Normalizamos al shape actual {lunch, lunchStarter, dinner} aunque los datos
  // vengan de una versión anterior sin `lunchStarter`.
  state.week = stored.data.map(day => ({
    lunch: day.lunch || null,
    lunchStarter: day.lunchStarter || null,
    dinner: day.dinner || null
  }));
  renderWeek();
}

function renderWeek() {
  const grid = document.getElementById('weekGrid');
  const empty = document.getElementById('weekEmpty');

  if (!state.week) {
    grid.classList.remove('visible');
    empty.classList.add('visible');
    return;
  }

  empty.classList.remove('visible');
  grid.classList.add('visible');

  const rerollSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/></svg>`;
  const deleteSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>`;

  // Reroll siempre disponible (también en slot vacío, para poder repoblarlo).
  // Delete solo cuando hay contenido que eliminar.
  const actions = (dayIdx, meal, hasContent, labelDel, labelReroll) => `
    <div class="meal-actions">
      ${hasContent ? `<button class="meal-action meal-delete" data-day="${dayIdx}" data-meal="${meal}" aria-label="${labelDel}">${deleteSvg}</button>` : ''}
      <button class="meal-action meal-reroll" data-day="${dayIdx}" data-meal="${meal}" aria-label="${labelReroll}">${rerollSvg}</button>
    </div>
  `;

  grid.innerHTML = state.week.map((day, idx) => {
    const lunchDish = day.lunch ? state.dishes.find(d => d.id === day.lunch) : null;
    const lunchName = lunchDish?.name || null;
    const starterName = day.lunchStarter ? state.dishes.find(d => d.id === day.lunchStarter)?.name : null;
    const dinnerName = day.dinner ? state.dishes.find(d => d.id === day.dinner)?.name : null;
    const isWeekend = idx >= 5;

    // Mostramos la línea de entrante si hay entrante asignado, o si el plato
    // principal lo admite (role 'main', no 'complete'). Permite rerodar para
    // repoblar un entrante recién eliminado.
    const showStarterLine = !!day.lunchStarter || (lunchDish && lunchDish.role !== 'complete');

    return `
      <article class="day-card${isWeekend ? ' is-weekend' : ''}">
        <div class="day-header">
          <h3 class="day-name">${DAYS[idx]}</h3>
        </div>
        <div class="meal-slot lunch-slot" data-day="${idx}">
          <span class="meal-label">Comida</span>
          ${showStarterLine ? `
            <div class="meal-line starter-line">
              <span class="meal-starter ${starterName ? '' : 'empty'}">${starterName ? escapeHtml(starterName) : 'Sin entrante'}</span>
              ${actions(idx, 'lunchStarter', !!starterName, 'Eliminar entrante', 'Cambiar entrante')}
            </div>
          ` : ''}
          <div class="meal-line main-line">
            <span class="meal-dish ${!lunchName ? 'empty' : ''}">${lunchName ? escapeHtml(lunchName) : 'Sin asignar'}</span>
            ${actions(idx, 'lunch', !!lunchName, 'Eliminar comida', 'Cambiar comida')}
          </div>
        </div>
        <div class="meal-slot dinner-slot" data-day="${idx}">
          <span class="meal-label">Cena</span>
          <div class="meal-line">
            <span class="meal-dish ${!dinnerName ? 'empty' : ''}">${dinnerName ? escapeHtml(dinnerName) : 'Sin asignar'}</span>
            ${actions(idx, 'dinner', !!dinnerName, 'Eliminar cena', 'Cambiar cena')}
          </div>
        </div>
      </article>
    `;
  }).join('');

  grid.querySelectorAll('.meal-reroll').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      rerollMeal(parseInt(btn.dataset.day), btn.dataset.meal);
    });
  });
  grid.querySelectorAll('.meal-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMeal(parseInt(btn.dataset.day), btn.dataset.meal);
    });
  });
}

async function deleteMeal(dayIdx, meal) {
  // Eliminación granular: solo se vacía el slot clicado. Si el usuario quiere
  // limpiar también el entrante al borrar la comida, puede borrarlo aparte.
  state.week[dayIdx][meal] = null;
  await idb.put(STORE_WEEK, { id: 'current', data: state.week, generatedAt: Date.now() });
  await buildShoppingList();
  renderWeek();
}

// Dos slots son adyacentes si comparten día (cualquier combinación
// comida/entrante/cena dentro del mismo día) o si forman el "salto" temporal
// cena(d) ↔ entrante/comida(d+1).
function isAdjacentSlot(aDay, aMeal, bDay, bMeal) {
  if (aDay === bDay) return aMeal !== bMeal;
  const isDinner = m => m === 'dinner';
  const isLunchish = m => m === 'lunch' || m === 'lunchStarter';
  if (aDay === bDay - 1 && isDinner(aMeal) && isLunchish(bMeal)) return true;
  if (aDay === bDay + 1 && isLunchish(aMeal) && isDinner(bMeal)) return true;
  return false;
}

const SLOT_FIELDS = ['lunch', 'lunchStarter', 'dinner'];

// Devuelve un peso > 0 indicando lo deseable que es poner `dish` en (slotDay, slotMeal),
// dado el contenido actual de `week`. Los slots vacíos se ignoran.
function scoreDish(dish, week, slotDay, slotMeal) {
  let weight = 1.0;
  const dishTags = dish.tags || [];

  for (let d = 0; d < week.length; d++) {
    for (const meal of SLOT_FIELDS) {
      if (d === slotDay && meal === slotMeal) continue;
      const otherId = week[d][meal];
      if (!otherId) continue;
      const other = state.dishes.find(x => x.id === otherId);
      if (!other) continue;
      const adjacent = isAdjacentSlot(slotDay, slotMeal, d, meal);

      if (other.id === dish.id) {
        weight *= adjacent ? SCORE.sameDishAdjacent : SCORE.sameDishInWeek;
      }

      const otherTags = other.tags || [];
      for (const t of dishTags) {
        if (!otherTags.includes(t)) continue;
        weight *= adjacent ? SCORE.tagAdjacent : SCORE.tagInWeek;
      }
    }
  }

  return weight;
}

function weightedPick(items, weightFn) {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  const weights = items.map(weightFn);
  const total = weights.reduce((s, w) => s + w, 0);
  if (!isFinite(total) || total <= 0) {
    return items[Math.floor(Math.random() * items.length)];
  }
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// Filtro común por estación: en modo 'any' pasa todo; en 'invierno'/'verano'
// solo entran los platos de esa estación o los marcados como 'any'.
function matchesSeason(d) {
  if (state.seasonMode === 'any') return true;
  const s = d.season || 'any';
  return s === 'any' || s === state.seasonMode;
}

// Pools por tipo de slot. El "principal" de la comida acepta role 'main' o
// 'complete'; los entrantes solo 'starter'. La cena nunca lleva entrante.
function lunchMainPool() {
  return state.dishes.filter(d =>
    (d.type === 'comida' || d.type === 'ambos')
    && (d.role === 'main' || d.role === 'complete' || !d.role)
    && matchesSeason(d)
  );
}
function lunchStarterPool() {
  return state.dishes.filter(d =>
    (d.type === 'comida' || d.type === 'ambos')
    && d.role === 'starter'
    && matchesSeason(d)
  );
}
function dinnerPool() {
  return state.dishes.filter(d =>
    (d.type === 'cena' || d.type === 'ambos')
    && (d.role === 'main' || d.role === 'complete' || !d.role)
    && matchesSeason(d)
  );
}

// Devuelve el id de un entrante adecuado para acompañar al main dado, o null
// si no procede (main es 'complete', o no hay entrantes disponibles).
function pickStarterFor(mainDish, week, dayIdx) {
  if (!mainDish || mainDish.role === 'complete') return null;
  const starters = lunchStarterPool();
  if (starters.length === 0) return null;
  const pick = weightedPick(starters, d => scoreDish(d, week, dayIdx, 'lunchStarter'));
  return pick ? pick.id : null;
}

async function generateWeek() {
  await loadDishes();
  const lunches = lunchMainPool();
  const dinners = dinnerPool();

  if (lunches.length === 0) { showToast('Necesitas al menos un plato de comida'); return; }
  if (dinners.length === 0) { showToast('Necesitas al menos un plato de cena'); return; }

  const week = Array.from({ length: 7 }, () => ({ lunch: null, lunchStarter: null, dinner: null }));

  for (let i = 0; i < 7; i++) {
    const lunchPick = weightedPick(lunches, d => scoreDish(d, week, i, 'lunch'));
    week[i].lunch = lunchPick ? lunchPick.id : null;
    week[i].lunchStarter = pickStarterFor(lunchPick, week, i);
    const dinnerPick = weightedPick(dinners, d => scoreDish(d, week, i, 'dinner'));
    week[i].dinner = dinnerPick ? dinnerPick.id : null;
  }

  state.week = week;
  await idb.put(STORE_WEEK, { id: 'current', data: week, generatedAt: Date.now() });
  await buildShoppingList();
  renderWeek();
  showToast('Semana generada');
}

async function rerollMeal(dayIdx, meal) {
  let pool, previous;
  if (meal === 'lunch') {
    pool = lunchMainPool();
    previous = state.week[dayIdx].lunch;
  } else if (meal === 'lunchStarter') {
    pool = lunchStarterPool();
    previous = state.week[dayIdx].lunchStarter;
  } else {
    pool = dinnerPool();
    previous = state.week[dayIdx].dinner;
  }
  if (pool.length === 0) return;

  const slotField = meal;
  state.week[dayIdx][slotField] = null;

  const candidates = pool.filter(d => d.id !== previous);
  const finalPool = candidates.length > 0 ? candidates : pool;
  const picked = weightedPick(finalPool, d => scoreDish(d, state.week, dayIdx, meal));
  state.week[dayIdx][slotField] = picked ? picked.id : previous;

  // Si rerolamos el plato principal de la comida, el entrante puede dejar de
  // tener sentido (nuevo plato 'complete') o pasar a tenerlo (nuevo 'main' sin
  // entrante actual). Ajustamos el slot del entrante en consecuencia.
  if (meal === 'lunch') {
    const newMain = picked || state.dishes.find(d => d.id === previous);
    if (newMain && newMain.role === 'complete') {
      state.week[dayIdx].lunchStarter = null;
    } else if (newMain && !state.week[dayIdx].lunchStarter) {
      state.week[dayIdx].lunchStarter = pickStarterFor(newMain, state.week, dayIdx);
    }
  }

  await idb.put(STORE_WEEK, { id: 'current', data: state.week, generatedAt: Date.now() });
  await buildShoppingList();
  renderWeek();
}

// ============ SHOPPING LIST ============
function aggregateField(dishIds, fieldName) {
  // Devuelve Map<nameLower, {name, qtyCounts, sources}> agregando el campo
  // `ingredients` o `spices` de cada plato a lo largo de la semana.
  // - qtyCounts: Map<qtyCruda, conteo total>
  // - sources: Map<dishId, {name, count}> con el plato origen y cuántas veces
  //   sale ese plato en la semana (para mostrar "Pasta al pesto ×2").
  const aggregated = new Map();
  dishIds.forEach(id => {
    const dish = state.dishes.find(d => d.id === id);
    if (!dish) return;
    let occurrences = 0;
    state.week.forEach(day => {
      if (day.lunch === id) occurrences++;
      if (day.lunchStarter === id) occurrences++;
      if (day.dinner === id) occurrences++;
    });
    (dish[fieldName] || []).forEach(item => {
      const key = item.name.toLowerCase().trim();
      if (!key) return;
      if (!aggregated.has(key)) {
        aggregated.set(key, { name: item.name, qtyCounts: new Map(), sources: new Map() });
      }
      const entry = aggregated.get(key);
      const qty = item.qty ? item.qty.trim() : '';
      entry.qtyCounts.set(qty, (entry.qtyCounts.get(qty) || 0) + occurrences);
      // Cada plato aporta como source una sola vez (con su count de la semana).
      if (!entry.sources.has(dish.id)) {
        entry.sources.set(dish.id, { name: dish.name, count: occurrences });
      }
    });
  });
  return aggregated;
}

function materializeShoppingItems(aggregated, previousChecked, kind) {
  const items = Array.from(aggregated.values()).map(item => {
    const qtyStrings = [];
    for (const [qty, count] of item.qtyCounts) {
      if (!qty) continue;
      qtyStrings.push(count > 1 ? `${qty} ×${count}` : qty);
    }
    // Sources como array serializable (ordenado por nombre).
    const sources = Array.from(item.sources.values())
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return {
      id: uid(),
      kind,
      name: item.name,
      qty: qtyStrings.join(' + '),
      sources,
      checked: previousChecked.get(item.name.toLowerCase()) || false
    };
  });
  sortShopping(items);
  return items;
}

// Items no marcados primero (alfabéticos), marcados al final (alfabéticos).
// In-place: las funciones que ya tenían `state.shopping.sort(...)` se
// reemplazan por esta para uniformizar el orden.
function sortShopping(items) {
  items.sort((a, b) => {
    if (a.checked !== b.checked) return a.checked ? 1 : -1;
    return a.name.localeCompare(b.name, 'es');
  });
}

async function buildShoppingList(renames = new Map()) {
  if (!state.week) {
    state.shopping = [];
    state.spicesShopping = [];
    await idb.clear(STORE_SHOPPING);
    renderShopping();
    return;
  }

  // Recolecta IDs de plato; incluye el entrante (cuenta como un plato más).
  const dishIds = new Set();
  state.week.forEach(day => {
    if (day.lunch) dishIds.add(day.lunch);
    if (day.lunchStarter) dishIds.add(day.lunchStarter);
    if (day.dinner) dishIds.add(day.dinner);
  });

  const ingredientsAgg = aggregateField(dishIds, 'ingredients');
  const spicesAgg = aggregateField(dishIds, 'spices');

  // Preservar el estado `checked` por nombre normalizado, con propagación de
  // renames (mismo id, distinto nombre). El nuevo nombre hereda el check del
  // antiguo salvo que el destino ya tuviera uno propio (caso merge).
  const previousChecked = new Map();
  [...state.shopping, ...state.spicesShopping].forEach(item => {
    previousChecked.set(item.name.toLowerCase(), item.checked);
  });
  for (const [oldKey, newKey] of renames) {
    if (previousChecked.has(oldKey) && !previousChecked.has(newKey)) {
      previousChecked.set(newKey, previousChecked.get(oldKey));
    }
  }

  state.shopping = materializeShoppingItems(ingredientsAgg, previousChecked, 'ingredient');
  state.spicesShopping = materializeShoppingItems(spicesAgg, previousChecked, 'spice');

  // Una sola transacción: si dos invocaciones concurrentes se solapan,
  // cada una deja el store en un estado consistente (no entrelazado).
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_SHOPPING, 'readwrite');
    const store = transaction.objectStore(STORE_SHOPPING);
    store.clear();
    [...state.shopping, ...state.spicesShopping].forEach(item => store.put(item));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

  renderShopping();
}

async function loadShopping() {
  const all = await idb.getAll(STORE_SHOPPING);
  state.shopping = all.filter(i => (i.kind || 'ingredient') === 'ingredient');
  state.spicesShopping = all.filter(i => i.kind === 'spice');
  sortShopping(state.shopping);
  sortShopping(state.spicesShopping);
  renderShopping();
}

function shoppingItemHtml(item) {
  const sourcesText = state.showSources
    ? (item.sources || []).map(s => s.count > 1 ? `${s.name} ×${s.count}` : s.name).join(' · ')
    : '';
  return `
    <div class="shopping-item ${item.checked ? 'checked' : ''}" data-id="${item.id}">
      <div class="shopping-check">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5L20 7"/></svg>
      </div>
      <div class="shopping-content">
        <span class="shopping-name">${escapeHtml(item.name)}</span>
        ${sourcesText ? `<span class="shopping-sources">${escapeHtml(sourcesText)}</span>` : ''}
      </div>
      ${item.qty ? `<span class="shopping-qty">${escapeHtml(item.qty)}</span>` : ''}
      <button type="button" class="shopping-delete" data-id="${item.id}" aria-label="Eliminar de la lista">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
  `;
}

function renderShopping() {
  const list = document.getElementById('shoppingList');
  const empty = document.getElementById('emptyShopping');
  const meta = document.getElementById('shoppingMeta');
  const spicesSection = document.getElementById('spicesSection');
  const spicesList = document.getElementById('spicesList');

  const hasIngredients = state.shopping.length > 0;
  const hasSpices = state.spicesShopping.length > 0;

  if (!hasIngredients && !hasSpices) {
    list.classList.remove('visible');
    empty.classList.add('visible');
    meta.textContent = '';
    spicesSection.classList.remove('visible');
    return;
  }

  empty.classList.remove('visible');

  const wireShoppingItem = (el) => {
    el.addEventListener('click', () => toggleShopping(el.dataset.id));
    const del = el.querySelector('.shopping-delete');
    if (del) {
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteShoppingItem(del.dataset.id);
      });
    }
  };

  if (hasIngredients) {
    list.classList.add('visible');
    const total = state.shopping.length;
    const checked = state.shopping.filter(s => s.checked).length;
    meta.innerHTML = `<span>${checked} / ${total}</span> · ingredientes para la semana`;
    list.innerHTML = state.shopping.map(shoppingItemHtml).join('');
    list.querySelectorAll('.shopping-item').forEach(wireShoppingItem);
  } else {
    list.classList.remove('visible');
    list.innerHTML = '';
    meta.textContent = '';
  }

  if (hasSpices) {
    spicesSection.classList.add('visible');
    spicesList.innerHTML = state.spicesShopping.map(shoppingItemHtml).join('');
    spicesList.querySelectorAll('.shopping-item').forEach(wireShoppingItem);
  } else {
    spicesSection.classList.remove('visible');
    spicesList.innerHTML = '';
  }
}

async function deleteShoppingItem(id) {
  // Eliminación transitoria: vuelve a aparecer si se regenera la semana o si
  // cambia algún plato. Es "no comprar esto esta vez", no un blacklist global.
  const inIngredients = state.shopping.findIndex(s => s.id === id);
  if (inIngredients >= 0) {
    state.shopping.splice(inIngredients, 1);
  } else {
    const inSpices = state.spicesShopping.findIndex(s => s.id === id);
    if (inSpices < 0) return;
    state.spicesShopping.splice(inSpices, 1);
  }
  await idb.delete(STORE_SHOPPING, id);
  renderShopping();
}

async function toggleShopping(id) {
  const inIngredients = state.shopping.find(s => s.id === id);
  const item = inIngredients || state.spicesShopping.find(s => s.id === id);
  if (!item) return;
  item.checked = !item.checked;
  // Reordenar la lista a la que pertenece para mandar los marcados al final.
  sortShopping(inIngredients ? state.shopping : state.spicesShopping);
  await idb.put(STORE_SHOPPING, item);
  renderShopping();
}

async function clearChecks() {
  const all = [...state.shopping, ...state.spicesShopping];
  if (all.length === 0) return;
  if (!confirm('¿Desmarcar todos los ingredientes?')) return;

  const toUpdate = all.filter(item => item.checked);
  toUpdate.forEach(item => { item.checked = false; });

  // Una sola transacción; evita el patrón await-en-bucle con tx separadas.
  if (toUpdate.length > 0) {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_SHOPPING, 'readwrite');
      const store = transaction.objectStore(STORE_SHOPPING);
      toUpdate.forEach(item => store.put(item));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  renderShopping();
  showToast('Lista reiniciada');
}

// ============ EXPORT / IMPORT ============
async function exportData() {
  try {
    const dishes = await idb.getAll(STORE_DISHES);
    const week = await idb.get(STORE_WEEK, 'current');
    const shopping = await idb.getAll(STORE_SHOPPING);
    const settings = await idb.getAll(STORE_SETTINGS);

    const payload = {
      app: 'mise',
      schemaVersion: DB_VERSION,
      exportedAt: new Date().toISOString(),
      dishes,
      week: week?.data || null,
      weekGeneratedAt: week?.generatedAt || null,
      shopping,
      settings
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mise-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Datos exportados');
  } catch (err) {
    console.error('Export failed:', err);
    showToast('Error al exportar');
  }
}

// Normaliza un plato del JSON importado al schema actual. Rellena defaults para
// que exports de versiones antiguas (o JSONs manipulados con campos faltantes)
// no dejen registros inconsistentes en disco.
function normalizeImportedDish(d) {
  const validTypes = ['comida', 'cena', 'ambos'];
  const validRoles = ['main', 'starter', 'complete'];
  const validSeasons = ['any', 'invierno', 'verano'];
  const sanitizeItem = (it) => ({
    id: it.id || uid(),
    name: String(it.name),
    qty: it.qty != null ? String(it.qty) : ''
  });
  return {
    id: d.id,
    name: String(d.name),
    description: typeof d.description === 'string' ? d.description : '',
    type: validTypes.includes(d.type) ? d.type : 'comida',
    role: validRoles.includes(d.role) ? d.role : 'main',
    season: validSeasons.includes(d.season) ? d.season : 'any',
    tags: Array.isArray(d.tags) ? d.tags.filter(t => typeof t === 'string') : [],
    ingredients: Array.isArray(d.ingredients)
      ? d.ingredients.filter(i => i && typeof i.name === 'string' && i.name.trim()).map(sanitizeItem)
      : [],
    spices: Array.isArray(d.spices)
      ? d.spices.filter(s => s && typeof s.name === 'string' && s.name.trim()).map(sanitizeItem)
      : [],
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : Date.now()
  };
}

async function importData(file) {
  let payload;
  try {
    const text = await file.text();
    payload = JSON.parse(text);
  } catch {
    showToast('JSON inválido');
    return;
  }

  if (payload.app !== 'mise' || !Array.isArray(payload.dishes)) {
    showToast('Archivo no compatible');
    return;
  }

  // Validar y normalizar cada plato: descarta los que no tengan id+name válidos.
  const validDishes = [];
  let rejected = 0;
  for (const raw of payload.dishes) {
    if (!raw || typeof raw.id !== 'string' || !raw.id ||
        typeof raw.name !== 'string' || !raw.name.trim()) {
      rejected++;
      continue;
    }
    validDishes.push(normalizeImportedDish(raw));
  }

  if (validDishes.length === 0 && payload.dishes.length > 0) {
    showToast('Archivo sin platos válidos');
    return;
  }

  const msg = rejected > 0
    ? `Esto reemplazará TODOS tus datos actuales. Se descartarán ${rejected} platos malformados. ¿Continuar?`
    : 'Esto reemplazará TODOS tus datos actuales (platos, semana, lista, tema). ¿Continuar?';
  if (!confirm(msg)) return;

  try {
    // Una sola transacción sobre los 4 stores: o todo o nada.
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [STORE_DISHES, STORE_WEEK, STORE_SHOPPING, STORE_SETTINGS],
        'readwrite'
      );
      const dishStore = transaction.objectStore(STORE_DISHES);
      const weekStore = transaction.objectStore(STORE_WEEK);
      const shoppingStore = transaction.objectStore(STORE_SHOPPING);
      const settingsStore = transaction.objectStore(STORE_SETTINGS);

      dishStore.clear();
      weekStore.clear();
      shoppingStore.clear();
      settingsStore.clear();

      validDishes.forEach(d => dishStore.put(d));
      if (payload.week) {
        weekStore.put({
          id: 'current',
          data: payload.week,
          generatedAt: payload.weekGeneratedAt || Date.now()
        });
      }
      (payload.shopping || []).forEach(s => shoppingStore.put(s));
      (payload.settings || []).forEach(s => settingsStore.put(s));

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    await initTheme();
    await loadCustomTags();
    await loadSeasonMode();
    await loadShowSources();
    applySeasonChip();
    applyShowSourcesCheckbox();
    await loadDishes();
    await loadWeek();
    await loadShopping();
    showToast(rejected > 0 ? `Datos importados (${rejected} descartados)` : 'Datos importados');
  } catch (err) {
    console.error('Import failed:', err);
    showToast('Error al importar');
  }
}

// ============ INIT ============
async function init() {
  try {
    await openDB();
    await initTheme();
    await loadCustomTags();
    await loadSeasonMode();
    await loadShowSources();
    initTabs();
    initFilters();
    initSeasonFilter();
    initShowSourcesToggle();
    applySeasonChip();
    applyShowSourcesCheckbox();

    // Event handlers
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    document.getElementById('openCreateDish').addEventListener('click', openCreateDish);
    document.getElementById('modalClose').addEventListener('click', hideModal);
    document.getElementById('cancelDish').addEventListener('click', hideModal);
    document.getElementById('dishForm').addEventListener('submit', saveDish);
    document.getElementById('addIngredient').addEventListener('click', addIngredient);
    document.getElementById('deleteDish').addEventListener('click', deleteDish);
    document.getElementById('generateWeek').addEventListener('click', generateWeek);
    document.getElementById('clearChecks').addEventListener('click', clearChecks);

    document.getElementById('exportData').addEventListener('click', exportData);
    document.getElementById('importData').addEventListener('click', () => {
      document.getElementById('importFile').click();
    });
    document.getElementById('importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) await importData(file);
      e.target.value = '';
    });

    document.getElementById('modalBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'modalBackdrop') hideModal();
    });

    document.getElementById('ingredientName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('ingredientQty').focus(); }
    });
    document.getElementById('ingredientQty').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addIngredient(); }
    });

    document.getElementById('addNewTag').addEventListener('click', addCustomTag);
    document.getElementById('newTagInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addCustomTag(); }
    });

    document.getElementById('addSpice').addEventListener('click', addSpice);
    document.getElementById('spiceName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('spiceQty').focus(); }
    });
    document.getElementById('spiceQty').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addSpice(); }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('modalBackdrop').classList.contains('visible')) {
        hideModal();
      }
    });

    await loadDishes();
    await loadWeek();
    await loadShopping();

    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed:', err));
    }
  } catch (err) {
    console.error('Init failed:', err);
    showToast('Error al iniciar. Recarga la página.');
  }
}

init();
