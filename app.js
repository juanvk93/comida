/* ============================================
   MIMENU · Menú Semanal — App Logic
   ============================================ */

// ============ INDEXED DB ============
const DB_NAME = 'mise-db';
const DB_VERSION = 5;
const STORE_DISHES = 'dishes';
const STORE_WEEK = 'week';
const STORE_SHOPPING = 'shopping';
const STORE_SETTINGS = 'settings';
const STORE_HISTORY = 'history';   // semanas archivadas (snapshots)
const STORE_PANTRY = 'pantry';     // ingredientes que ya tienes en casa

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

      // v4 -> v5: stores `history` y `pantry`; backfill `contains: []`,
      // `rating: 0` y `yields: 1` en cada plato.
      if (oldVersion < 5) {
        if (!database.objectStoreNames.contains(STORE_HISTORY)) {
          database.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(STORE_PANTRY)) {
          database.createObjectStore(STORE_PANTRY, { keyPath: 'id' });
        }
        const store = upgradeTx.objectStore(STORE_DISHES);
        store.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;
          const dish = cursor.value;
          let mutated = false;
          if (!Array.isArray(dish.contains)) { dish.contains = []; mutated = true; }
          if (typeof dish.rating !== 'number') { dish.rating = 0; mutated = true; }
          if (typeof dish.yields !== 'number' || dish.yields < 1) { dish.yields = 1; mutated = true; }
          if (mutated) cursor.update(dish);
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
  search: '',          // buscador de la vista Platos (nombre o ingrediente)
  theme: 'dark',
  accent: 'indigo',    // clave de ACCENTS; 'indigo' usa los valores por defecto del CSS
  seasonMode: 'any',   // 'any' | 'invierno' | 'verano' — filtra los pools de generación
  restrictions: [],    // restricciones dietéticas activas (filtro DURO) — ids de RESTRICTIONS
  useRatings: true,    // si las valoraciones influyen en la generación
  useHistory: true,    // si el historial penaliza repetir semanas recientes
  showSources: false,  // toggle UI: mostrar plato origen en cada item de la compra
  pantry: [],          // [{id, name}] ingredientes que ya tienes en casa
  pantryHidden: 0,     // nº de items ocultados de la compra por estar en despensa
  weekGeneratedAt: null,
  history: [],         // [{id, data, generatedAt, archivedAt}] semanas archivadas
  recentDishIds: new Set(), // ids de platos de la última semana archivada (penalización)
  editingDish: null,
  modalIngredients: [],
  modalSpices: [],
  modalTags: [],
  modalContains: [],   // alérgenos/atributos que contiene el plato en edición
  modalRating: 0,      // valoración del plato en edición (0–5)
  modalYields: 1,      // raciones (comidas que rinde) del plato en edición
  customTags: [],
  drag: null           // estado transitorio del drag & drop en la semana
};

// ============ UTILS ============
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const BUILTIN_TAGS = ['pasta', 'arroz', 'legumbre', 'pescado', 'carne', 'ave', 'huevo', 'verdura', 'sopa', 'ensalada'];

const APP_VERSION = '1.5.0';

// Paleta curada de acentos. `indigo` (por defecto) no define vars: deja que el
// CSS aplique los valores afinados por tema (dark/light) de :root. El resto
// sobreescribe --accent / --accent-strong / --accent-soft vía estilo inline en
// <body>, con un set de valores por tema para mantener contraste razonable.
const ACCENTS = {
  indigo:  { name: 'Índigo',    swatch: '#818cf8', dark: null, light: null },
  emerald: { name: 'Esmeralda', swatch: '#34d399',
    dark:  { accent: '#34d399', strong: '#6ee7b7', soft: 'rgba(52,211,153,0.14)' },
    light: { accent: '#059669', strong: '#047857', soft: 'rgba(5,150,105,0.10)' } },
  rose:    { name: 'Frambuesa', swatch: '#fb7185',
    dark:  { accent: '#fb7185', strong: '#fda4af', soft: 'rgba(251,113,133,0.14)' },
    light: { accent: '#e11d48', strong: '#be123c', soft: 'rgba(225,29,72,0.10)' } },
  amber:   { name: 'Ámbar',     swatch: '#f59e0b',
    dark:  { accent: '#f59e0b', strong: '#fbbf24', soft: 'rgba(245,158,11,0.14)' },
    light: { accent: '#d97706', strong: '#b45309', soft: 'rgba(217,119,6,0.10)' } },
  sky:     { name: 'Cielo',     swatch: '#38bdf8',
    dark:  { accent: '#38bdf8', strong: '#7dd3fc', soft: 'rgba(56,189,248,0.14)' },
    light: { accent: '#0284c7', strong: '#0369a1', soft: 'rgba(2,132,199,0.10)' } },
  violet:  { name: 'Violeta',   swatch: '#a78bfa',
    dark:  { accent: '#a78bfa', strong: '#c4b5fd', soft: 'rgba(167,139,250,0.14)' },
    light: { accent: '#7c3aed', strong: '#6d28d9', soft: 'rgba(124,58,237,0.10)' } }
};

// Historial de cambios. El primero es el más reciente y se marca como "actual".
const CHANGELOG = [
  { version: '1.5.0', date: 'Junio 2026', items: [
    'Fijar platos (📌) en la semana: «Generar» respeta lo fijado y rellena el resto.',
    'Restricciones alimentarias como filtro duro (vegetariano, sin gluten, sin lácteos…).',
    'Valoración de platos (estrellas): los favoritos salen más; configurable en Ajustes.',
    'Historial de semanas y estadísticas; evita repetir lo reciente (configurable).',
    'Batch cooking: marca cuántas comidas rinde un plato y ocupa varios huecos como sobras.',
    'La lista de la compra ahora SUMA cantidades de verdad (200 g + 300 g = 500 g).',
    'Despensa: marca lo que ya tienes y desaparece de la compra.',
    'Compartir la lista (sistema nativo / WhatsApp / portapapeles).',
    'Buscador de platos por nombre o ingrediente.',
    'Importar recetas desde una URL o pegando el texto.',
    'Arrastrar y soltar para mover platos entre huecos de la semana.'
  ]},
  { version: '1.4.0', date: 'Junio 2026', items: [
    'Rediseño pensado para móvil: cabecera más limpia sin el icono junto al título.',
    'Pestañas Platos / Semana / Compra como control segmentado a todo el ancho.',
    'Nuevo menú lateral de ajustes (tema, color de acento, datos e información).',
    'Color de acento personalizable con 6 tonos.',
    'Almacenamiento persistente: los datos no se borran por falta de uso o espacio.',
    'Esta pantalla de novedades.'
  ]},
  { version: '1.3.0', date: 'Mayo 2026', items: [
    'Modo de estación (invierno / verano) para la generación de la semana.',
    'Cada plato puede marcarse como de temporada o para cualquier época.'
  ]},
  { version: '1.2.0', date: 'Mayo 2026', items: [
    'Roles de plato: principal, entrante y completo.',
    'Las comidas pueden llevar entrante; las cenas no.',
    'Especias por plato, sugeridas aparte en la lista de la compra.'
  ]},
  { version: '1.1.0', date: 'Mayo 2026', items: [
    'Etiquetas en los platos y filtro por etiqueta en el recetario.',
    'La generación evita repetir etiquetas en días cercanos.'
  ]},
  { version: '1.0.0', date: 'Mayo 2026', items: [
    'Recetario de platos con ingredientes y cantidades.',
    'Generación aleatoria ponderada de la semana.',
    'Lista de la compra automática a partir de la semana.',
    'App instalable (PWA) que funciona sin conexión.'
  ]}
];

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
  tagAdjacent: 0.4,       // por cada tag compartida con el slot adyacente
  recentWeek: 0.3         // si el plato salió en la última semana archivada (si useHistory)
};

// Alérgenos / atributos que un plato puede contener. El usuario los marca en el
// modal; las restricciones (abajo) excluyen platos según lo que contienen.
const CONTAINS_FLAGS = [
  { id: 'carne',        label: 'Carne' },
  { id: 'pescado',      label: 'Pescado' },
  { id: 'gluten',       label: 'Gluten' },
  { id: 'lactosa',      label: 'Lácteos' },
  { id: 'huevo',        label: 'Huevo' },
  { id: 'frutossecos',  label: 'Frutos secos' }
];

// Restricciones dietéticas (filtro DURO). Cada una excluye los platos que
// contengan cualquiera de los flags listados en `excludes`.
const RESTRICTIONS = [
  { id: 'vegetariano',     label: 'Vegetariano',     excludes: ['carne', 'pescado'] },
  { id: 'vegano',          label: 'Vegano',          excludes: ['carne', 'pescado', 'lactosa', 'huevo'] },
  { id: 'singluten',       label: 'Sin gluten',      excludes: ['gluten'] },
  { id: 'sinlactosa',      label: 'Sin lácteos',     excludes: ['lactosa'] },
  { id: 'sinhuevo',        label: 'Sin huevo',       excludes: ['huevo'] },
  { id: 'sinfrutossecos',  label: 'Sin frutos secos', excludes: ['frutossecos'] }
];

// Multiplicador de peso por valoración (0 = sin valorar → neutral). Los
// favoritos (4–5★) salen más; los flojos (1–2★) casi nunca. Solo se aplica si
// state.useRatings está activo.
const RATING_WEIGHT = { 0: 1.0, 1: 0.15, 2: 0.45, 3: 0.85, 4: 1.4, 5: 2.0 };

// Semanas de historial a conservar (poda de las más antiguas).
const HISTORY_LIMIT = 26;

// ============ PARSER DE CANTIDADES ============
// Permite SUMAR cantidades de verdad (200 g + 300 g = 500 g) normalizando a una
// base por dimensión. Lo que no se puede parsear se conserva como texto crudo.
const UNIT_DEFS = {
  // masa (base: g)
  g: { dim: 'mass', f: 1 }, gr: { dim: 'mass', f: 1 }, grs: { dim: 'mass', f: 1 },
  gramo: { dim: 'mass', f: 1 }, gramos: { dim: 'mass', f: 1 }, mg: { dim: 'mass', f: 0.001 },
  kg: { dim: 'mass', f: 1000 }, kgs: { dim: 'mass', f: 1000 },
  kilo: { dim: 'mass', f: 1000 }, kilos: { dim: 'mass', f: 1000 },
  kilogramo: { dim: 'mass', f: 1000 }, kilogramos: { dim: 'mass', f: 1000 },
  // volumen (base: ml)
  ml: { dim: 'vol', f: 1 }, mililitro: { dim: 'vol', f: 1 }, mililitros: { dim: 'vol', f: 1 },
  cl: { dim: 'vol', f: 10 }, dl: { dim: 'vol', f: 100 },
  l: { dim: 'vol', f: 1000 }, lt: { dim: 'vol', f: 1000 },
  litro: { dim: 'vol', f: 1000 }, litros: { dim: 'vol', f: 1000 }
};

// Unidades de conteo: no se convierten entre sí, se suman si coincide la unidad
// canónica (singular). El '' (sin unidad) agrupa los números pelados.
const COUNT_UNITS = {
  '': '', ud: 'ud', uds: 'ud', unidad: 'ud', unidades: 'ud', u: 'ud',
  diente: 'diente', dientes: 'diente', lata: 'lata', latas: 'lata',
  loncha: 'loncha', lonchas: 'loncha', rodaja: 'rodaja', rodajas: 'rodaja',
  hoja: 'hoja', hojas: 'hoja', rama: 'rama', ramas: 'rama',
  puñado: 'puñado', puñados: 'puñado', pizca: 'pizca', pizcas: 'pizca',
  cucharada: 'cucharada', cucharadas: 'cucharada', cda: 'cucharada', cdas: 'cucharada',
  cucharadita: 'cucharadita', cucharaditas: 'cucharadita', cdta: 'cucharadita', cdtas: 'cucharadita',
  vaso: 'vaso', vasos: 'vaso', sobre: 'sobre', sobres: 'sobre',
  paquete: 'paquete', paquetes: 'paquete', bote: 'bote', botes: 'bote',
  trozo: 'trozo', trozos: 'trozo', filete: 'filete', filetes: 'filete'
};

function parseNumberToken(tok) {
  tok = tok.trim();
  const mixed = tok.match(/^(\d+)\s+(\d+)\/(\d+)$/);   // "1 1/2"
  if (mixed) return parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
  const frac = tok.match(/^(\d+)\/(\d+)$/);            // "1/2"
  if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10);
  const n = parseFloat(tok);
  return isFinite(n) ? n : null;
}

// Devuelve {value, dim, unit} (value en base) o null si no parece una cantidad.
function parseQty(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase().replace(',', '.');
  const m = s.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)\s*(.*)$/);
  if (!m) return null;
  const value = parseNumberToken(m[1]);
  if (value === null) return null;
  let unitRaw = m[2].trim().replace(/^de\s+/, '');
  unitRaw = (unitRaw.split(/\s+/)[0] || '').replace(/[.)]+$/, '');
  const u = UNIT_DEFS[unitRaw];
  if (u) return { value: value * u.f, dim: u.dim, unit: u.dim === 'mass' ? 'g' : 'ml' };
  if (unitRaw in COUNT_UNITS) return { value, dim: 'count', unit: COUNT_UNITS[unitRaw] };
  return { value, dim: 'count', unit: unitRaw.replace(/s$/, '') }; // palabra suelta como unidad
}

function formatNum(n) {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r).replace('.', ',');
}

// total: {dim, unit, value} acumulado en base. Devuelve string legible.
function formatQtyTotal(total) {
  if (total.dim === 'mass') {
    return total.value >= 1000 ? `${formatNum(total.value / 1000)} kg` : `${formatNum(total.value)} g`;
  }
  if (total.dim === 'vol') {
    return total.value >= 1000 ? `${formatNum(total.value / 1000)} l` : `${formatNum(total.value)} ml`;
  }
  const n = formatNum(total.value);
  return total.unit ? `${n} ${total.unit}` : n;
}

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

async function loadRestrictions() {
  const setting = await idb.get(STORE_SETTINGS, 'restrictions');
  const valid = new Set(RESTRICTIONS.map(r => r.id));
  state.restrictions = Array.isArray(setting?.value)
    ? setting.value.filter(r => valid.has(r))
    : [];
}

async function loadToggles() {
  const r = await idb.get(STORE_SETTINGS, 'useRatings');
  const h = await idb.get(STORE_SETTINGS, 'useHistory');
  state.useRatings = r?.value !== false;   // default true
  state.useHistory = h?.value !== false;   // default true
}

async function loadPantry() {
  const all = await idb.getAll(STORE_PANTRY);
  state.pantry = all.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

async function loadHistory() {
  const all = await idb.getAll(STORE_HISTORY);
  state.history = all.sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  computeRecentDishIds();
}

// Conjunto de ids de plato de la semana archivada más reciente, para penalizar
// repetir lo de la última semana (solo si useHistory está activo).
function computeRecentDishIds() {
  state.recentDishIds = new Set();
  const last = state.history[0];
  if (!last || !Array.isArray(last.data)) return;
  last.data.forEach(day => {
    ['lunch', 'lunchStarter', 'dinner'].forEach(slot => {
      if (day[slot]) state.recentDishIds.add(day[slot]);
    });
  });
}

// Conjunto de nombres (lowercase) de ingredientes en la despensa.
function pantrySet() {
  return new Set(state.pantry.map(p => p.name.toLowerCase().trim()));
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

async function loadAccent() {
  const setting = await idb.get(STORE_SETTINGS, 'accent');
  state.accent = ACCENTS[setting?.value] ? setting.value : 'indigo';
}

function applyTheme() {
  document.body.dataset.theme = state.theme;
  document.querySelector('meta[name="theme-color"]').setAttribute(
    'content', state.theme === 'dark' ? '#131313' : '#ffffff'
  );
  applyAccent();          // el acento tiene valores distintos por tema
  applyThemeOptions();
}

// Sobreescribe (o limpia) las variables de acento en <body> según el preset y
// el tema actual. Inline en body gana a las reglas de :root / [data-theme].
function applyAccent() {
  const preset = ACCENTS[state.accent] || ACCENTS.indigo;
  const vars = preset[state.theme];
  const map = { '--accent': 'accent', '--accent-strong': 'strong', '--accent-soft': 'soft' };
  for (const cssVar in map) {
    if (vars) document.body.style.setProperty(cssVar, vars[map[cssVar]]);
    else document.body.style.removeProperty(cssVar);
  }
}

function applyThemeOptions() {
  document.querySelectorAll('.seg-option[data-theme-opt]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeOpt === state.theme);
  });
}

function renderAccentSwatches() {
  const container = document.getElementById('accentSwatches');
  if (!container) return;
  container.innerHTML = Object.entries(ACCENTS).map(([key, preset]) => {
    const active = state.accent === key;
    return `<button type="button" class="accent-swatch ${active ? 'active' : ''}"
      data-accent="${key}" style="--swatch:${preset.swatch}"
      title="${escapeHtml(preset.name)}" aria-label="${escapeHtml(preset.name)}"
      aria-pressed="${active}"></button>`;
  }).join('');
  container.querySelectorAll('.accent-swatch').forEach(btn => {
    btn.addEventListener('click', () => setAccent(btn.dataset.accent));
  });
}

async function setTheme(value) {
  if (value !== 'dark' && value !== 'light') return;
  state.theme = value;
  applyTheme();
  await idb.put(STORE_SETTINGS, { key: 'theme', value });
}

async function setAccent(value) {
  if (!ACCENTS[value]) return;
  state.accent = value;
  applyAccent();
  renderAccentSwatches();
  await idb.put(STORE_SETTINGS, { key: 'accent', value });
}

// ============ DRAWER (menú lateral) ============
function openDrawer() {
  document.getElementById('drawerBackdrop').classList.add('visible');
  const drawer = document.getElementById('drawer');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  document.getElementById('menuToggle').setAttribute('aria-expanded', 'true');
  updateStorageStatus();
}

function closeDrawer() {
  document.getElementById('drawerBackdrop').classList.remove('visible');
  const drawer = document.getElementById('drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  document.getElementById('menuToggle').setAttribute('aria-expanded', 'false');
}

// Restricciones dietéticas (chips del drawer, filtro DURO de la generación).
function renderRestrictions() {
  const c = document.getElementById('restrictionChips');
  if (!c) return;
  c.innerHTML = RESTRICTIONS.map(r => {
    const active = state.restrictions.includes(r.id);
    return `<button type="button" class="chip ${active ? 'active' : ''}" data-restriction="${r.id}" aria-pressed="${active}">${escapeHtml(r.label)}</button>`;
  }).join('');
  c.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.restriction;
      const i = state.restrictions.indexOf(id);
      if (i >= 0) state.restrictions.splice(i, 1); else state.restrictions.push(id);
      renderRestrictions();
      await idb.put(STORE_SETTINGS, { key: 'restrictions', value: state.restrictions });
    });
  });
}

// Toggles de generación (valoraciones / historial).
function applyToggleButtons() {
  const r = document.getElementById('toggleRatings');
  const h = document.getElementById('toggleHistory');
  if (r) { r.classList.toggle('active', state.useRatings); r.setAttribute('aria-pressed', String(state.useRatings)); }
  if (h) { h.classList.toggle('active', state.useHistory); h.setAttribute('aria-pressed', String(state.useHistory)); }
}

function initToggles() {
  const r = document.getElementById('toggleRatings');
  const h = document.getElementById('toggleHistory');
  if (r) r.addEventListener('click', async () => {
    state.useRatings = !state.useRatings;
    applyToggleButtons();
    await idb.put(STORE_SETTINGS, { key: 'useRatings', value: state.useRatings });
  });
  if (h) h.addEventListener('click', async () => {
    state.useHistory = !state.useHistory;
    applyToggleButtons();
    await idb.put(STORE_SETTINGS, { key: 'useHistory', value: state.useHistory });
  });
}

// ============ CHANGELOG ============
function renderChangelog() {
  const body = document.getElementById('changelogBody');
  if (!body) return;
  body.innerHTML = CHANGELOG.map((entry, idx) => `
    <div class="changelog-entry ${idx === 0 ? 'current' : ''}">
      <div class="changelog-entry-head">
        <span class="changelog-version">v${escapeHtml(entry.version)}</span>
        <span class="changelog-date">${escapeHtml(entry.date)}</span>
      </div>
      <ul class="changelog-list">
        ${entry.items.map(it => `<li>${escapeHtml(it)}</li>`).join('')}
      </ul>
    </div>
  `).join('');
}

function openChangelog() {
  closeDrawer();   // el changelog es un overlay; el drawer no debe quedar encima
  renderChangelog();
  document.getElementById('changelogBackdrop').classList.add('visible');
}

function closeChangelog() {
  document.getElementById('changelogBackdrop').classList.remove('visible');
}

// ============ ALMACENAMIENTO PERSISTENTE ============
// Pide al navegador que no descarte los datos por falta de uso o presión de
// espacio. Es idempotente y silencioso si la API no existe (no soportada).
async function ensurePersistence() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    if (!(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (err) {
    console.warn('persist() falló:', err);
  }
}

async function updateStorageStatus() {
  const el = document.getElementById('storageStatus');
  if (!el) return;
  if (!navigator.storage || !navigator.storage.estimate) {
    el.textContent = 'Tu navegador no informa del estado de almacenamiento.';
    el.classList.remove('ok');
    return;
  }
  try {
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const { usage } = await navigator.storage.estimate();
    const kb = usage != null ? `${Math.max(1, Math.round(usage / 1024))} KB usados` : '';
    el.textContent = (persisted
      ? 'Datos protegidos: no se borrarán por falta de uso o espacio.'
      : 'Almacenamiento estándar (puede borrarse si falta espacio).')
      + (kb ? ` · ${kb}` : '');
    el.classList.toggle('ok', persisted);
  } catch (err) {
    el.textContent = '';
    el.classList.remove('ok');
  }
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
    if (!Array.isArray(d.contains)) d.contains = [];
    if (typeof d.rating !== 'number') d.rating = 0;
    if (typeof d.yields !== 'number' || d.yields < 1) d.yields = 1;
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

  // Buscador: por nombre, ingrediente o etiqueta.
  const q = state.search.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter(d => {
      if (d.name.toLowerCase().includes(q)) return true;
      if ((d.tags || []).some(t => t.toLowerCase().includes(q))) return true;
      if ((d.ingredients || []).some(i => i.name.toLowerCase().includes(q))) return true;
      return false;
    });
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
      <p>${q ? 'Ningún plato coincide con la búsqueda.' : 'No hay platos en esta categoría todavía.'}</p>
    </div>`;
    return;
  }

  const ratingStars = (r) => r > 0
    ? `<span class="dish-rating" title="${r}/5">${'★'.repeat(r)}<span class="dim">${'★'.repeat(5 - r)}</span></span>`
    : '';
  const dietBadge = (id) => {
    const f = CONTAINS_FLAGS.find(x => x.id === id);
    return f ? `<span class="dish-diet">${escapeHtml(f.label)}</span>` : '';
  };

  grid.innerHTML = filtered.map(dish => {
    const typeLabel = dish.type === 'ambos' ? 'Comida · Cena' : (dish.type.charAt(0).toUpperCase() + dish.type.slice(1));
    const allIngredients = Array.isArray(dish.ingredients) ? dish.ingredients : [];
    const ingredients = allIngredients.slice(0, 4);
    const more = allIngredients.length - 4;
    const tags = Array.isArray(dish.tags) ? dish.tags : [];
    const contains = Array.isArray(dish.contains) ? dish.contains : [];
    const yields = dish.yields || 1;
    return `
      <article class="dish-card" data-id="${dish.id}">
        <div class="dish-card-top">
          <div class="dish-type">${typeLabel}</div>
          ${ratingStars(dish.rating || 0)}
        </div>
        <h3 class="dish-name">${escapeHtml(dish.name)}</h3>
        ${dish.description ? `<p class="dish-desc">${escapeHtml(dish.description)}</p>` : ''}
        ${(tags.length || contains.length || yields > 1) ? `<div class="dish-tags">
          ${tags.map(t => `<span class="dish-tag">${escapeHtml(t)}</span>`).join('')}
          ${yields > 1 ? `<span class="dish-yields">♻ rinde ${yields}</span>` : ''}
          ${contains.map(dietBadge).join('')}
        </div>` : ''}
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

function initSearch() {
  const input = document.getElementById('dishSearch');
  if (!input) return;
  input.addEventListener('input', () => {
    state.search = input.value;
    renderDishes();
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
function openCreateDish(prefill = null) {
  state.editingDish = null;
  state.modalIngredients = prefill?.ingredients ? prefill.ingredients.map(i => ({ id: uid(), name: i.name, qty: i.qty || '' })) : [];
  state.modalSpices = [];
  state.modalTags = [];
  state.modalContains = [];
  state.modalRating = 0;
  state.modalYields = 1;
  document.getElementById('modalEyebrow').textContent = prefill ? 'Receta importada' : '';
  document.getElementById('modalTitle').textContent = prefill?.name ? prefill.name : 'Nuevo plato';
  document.getElementById('dishId').value = '';
  document.getElementById('dishName').value = prefill?.name || '';
  document.getElementById('dishDescription').value = '';
  document.querySelector('input[name="dishType"][value="comida"]').checked = true;
  document.querySelector('input[name="dishRole"][value="main"]').checked = true;
  document.querySelector('input[name="dishSeason"][value="any"]').checked = true;
  document.getElementById('deleteDish').hidden = true;
  refreshIngredientSuggestions();
  renderModalIngredients();
  renderModalSpices();
  renderModalTags();
  renderModalContains();
  renderModalRating();
  renderModalYields();
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
  state.modalContains = Array.isArray(dish.contains) ? [...dish.contains] : [];
  state.modalRating = typeof dish.rating === 'number' ? dish.rating : 0;
  state.modalYields = typeof dish.yields === 'number' && dish.yields >= 1 ? dish.yields : 1;
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
  renderModalContains();
  renderModalRating();
  renderModalYields();
  showModal();
}

// --- Render de los nuevos campos del modal ---
function renderModalContains() {
  const container = document.getElementById('containsPicker');
  if (!container) return;
  container.innerHTML = CONTAINS_FLAGS.map(f => {
    const active = state.modalContains.includes(f.id);
    return `<button type="button" class="tag-chip ${active ? 'active' : ''}" data-flag="${f.id}" aria-pressed="${active}">${escapeHtml(f.label)}</button>`;
  }).join('');
  container.querySelectorAll('.tag-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.flag;
      const i = state.modalContains.indexOf(id);
      if (i >= 0) state.modalContains.splice(i, 1); else state.modalContains.push(id);
      renderModalContains();
    });
  });
}

function renderModalRating() {
  const container = document.getElementById('ratingPicker');
  if (!container) return;
  const r = state.modalRating;
  const starsHtml = [1, 2, 3, 4, 5].map(n => {
    const on = n <= r;
    return `<button type="button" class="star ${on ? 'on' : ''}" data-value="${n}" aria-label="${n} estrella${n > 1 ? 's' : ''}">
      <svg viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.4L12 18.8 6.2 21.8l1.1-6.4L2.6 9.8l6.5-.9z"/></svg>
    </button>`;
  }).join('');
  container.innerHTML = `${starsHtml}<button type="button" class="rating-clear" data-value="0" title="Sin valorar">limpiar</button>`;
  container.querySelectorAll('[data-value]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = parseInt(btn.dataset.value);
      state.modalRating = (v === state.modalRating) ? 0 : v;  // reclic en la misma estrella = limpiar
      renderModalRating();
    });
  });
}

function renderModalYields() {
  const container = document.getElementById('yieldsPicker');
  if (!container) return;
  container.innerHTML = [1, 2, 3, 4].map(n => {
    const active = state.modalYields === n;
    const label = n === 1 ? '1 comida' : `${n} comidas`;
    return `<button type="button" class="seg-option ${active ? 'active' : ''}" data-yields="${n}" aria-pressed="${active}">${label}</button>`;
  }).join('');
  container.querySelectorAll('[data-yields]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.modalYields = parseInt(btn.dataset.yields);
      renderModalYields();
    });
  });
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
    contains: [...state.modalContains],
    rating: state.modalRating,
    yields: state.modalYields,
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
  const inCurrentWeek = state.week && state.week.some(d => d.lunch === dish.id || d.lunchStarter === dish.id || d.dinner === dish.id);
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
// Shape de un día: ids por slot + flags paralelos `locked` (fijado, no cambia al
// generar) y `leftover` (sobras de batch, no cuenta para la compra).
function emptyDay() {
  return {
    lunch: null, lunchStarter: null, dinner: null,
    locked: { lunch: false, lunchStarter: false, dinner: false },
    leftover: { lunch: false, lunchStarter: false, dinner: false }
  };
}

function normalizeDay(day) {
  const d = emptyDay();
  if (!day) return d;
  d.lunch = day.lunch || null;
  d.lunchStarter = day.lunchStarter || null;
  d.dinner = day.dinner || null;
  for (const s of SLOT_FIELDS) {
    if (day.locked) d.locked[s] = !!day.locked[s];
    if (day.leftover) d.leftover[s] = !!day.leftover[s];
  }
  return d;
}

async function persistWeek() {
  await idb.put(STORE_WEEK, {
    id: 'current',
    data: state.week,
    generatedAt: state.weekGeneratedAt || Date.now()
  });
}

async function loadWeek() {
  const stored = await idb.get(STORE_WEEK, 'current');
  if (!stored?.data) {
    state.week = null;
    state.weekGeneratedAt = null;
    renderWeek();
    return;
  }
  state.week = stored.data.map(normalizeDay);
  state.weekGeneratedAt = stored.generatedAt || null;
  renderWeek();
}

const REROLL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/></svg>`;
const DELETE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
const LOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

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

  // Reroll siempre disponible (también en slot vacío). Con contenido se añade
  // fijar y eliminar. Si el slot está fijado, solo se ofrece desfijar.
  const actions = (dayIdx, meal, has, locked, labels) => {
    if (!has) {
      return `<div class="meal-actions"><button class="meal-action meal-reroll" data-day="${dayIdx}" data-meal="${meal}" aria-label="${labels.reroll}">${REROLL_SVG}</button></div>`;
    }
    if (locked) {
      return `<div class="meal-actions"><button class="meal-action meal-lock active" data-day="${dayIdx}" data-meal="${meal}" aria-label="Quitar fijado" title="Fijado · no cambia al generar">${LOCK_SVG}</button></div>`;
    }
    return `<div class="meal-actions">
      <button class="meal-action meal-lock" data-day="${dayIdx}" data-meal="${meal}" aria-label="Fijar" title="Fijar · se mantiene al generar">${LOCK_SVG}</button>
      <button class="meal-action meal-delete" data-day="${dayIdx}" data-meal="${meal}" aria-label="${labels.del}">${DELETE_SVG}</button>
      <button class="meal-action meal-reroll" data-day="${dayIdx}" data-meal="${meal}" aria-label="${labels.reroll}">${REROLL_SVG}</button>
    </div>`;
  };

  const nameSpan = (cls, dayIdx, meal, dish, leftover, locked, emptyLabel) => {
    const has = !!dish;
    const draggable = has && !locked;
    const classes = `${cls}${has ? '' : ' empty'}${leftover ? ' is-leftover' : ''}${draggable ? ' draggable-dish' : ''}`;
    const badge = leftover ? `<span class="leftover-badge" title="Se cocina una vez y rinde varias comidas">♻ sobras</span>` : '';
    return `<span class="${classes}" data-day="${dayIdx}" data-meal="${meal}">${has ? escapeHtml(dish.name) : emptyLabel}</span>${badge}`;
  };

  grid.innerHTML = state.week.map((day, idx) => {
    const lunchDish = day.lunch ? state.dishes.find(d => d.id === day.lunch) : null;
    const starterDish = day.lunchStarter ? state.dishes.find(d => d.id === day.lunchStarter) : null;
    const dinnerDish = day.dinner ? state.dishes.find(d => d.id === day.dinner) : null;
    const isWeekend = idx >= 5;
    const L = day.locked, LO = day.leftover;

    // Línea de entrante si hay entrante o si el principal lo admite (no complete).
    const showStarterLine = !!day.lunchStarter || (lunchDish && lunchDish.role !== 'complete');
    const lineCls = (meal) => `meal-line${L[meal] ? ' is-locked' : ''}`;

    return `
      <article class="day-card${isWeekend ? ' is-weekend' : ''}">
        <div class="day-header">
          <h3 class="day-name">${DAYS[idx]}</h3>
        </div>
        <div class="meal-slot lunch-slot" data-day="${idx}">
          <span class="meal-label">Comida</span>
          ${showStarterLine ? `
            <div class="${lineCls('lunchStarter')} starter-line" data-day="${idx}" data-meal="lunchStarter">
              ${nameSpan('meal-starter', idx, 'lunchStarter', starterDish, LO.lunchStarter, L.lunchStarter, 'Sin entrante')}
              ${actions(idx, 'lunchStarter', !!starterDish, L.lunchStarter, { del: 'Eliminar entrante', reroll: 'Cambiar entrante' })}
            </div>
          ` : ''}
          <div class="${lineCls('lunch')} main-line" data-day="${idx}" data-meal="lunch">
            ${nameSpan('meal-dish', idx, 'lunch', lunchDish, LO.lunch, L.lunch, 'Sin asignar')}
            ${actions(idx, 'lunch', !!lunchDish, L.lunch, { del: 'Eliminar comida', reroll: 'Cambiar comida' })}
          </div>
        </div>
        <div class="meal-slot dinner-slot" data-day="${idx}">
          <span class="meal-label">Cena</span>
          <div class="${lineCls('dinner')}" data-day="${idx}" data-meal="dinner">
            ${nameSpan('meal-dish', idx, 'dinner', dinnerDish, LO.dinner, L.dinner, 'Sin asignar')}
            ${actions(idx, 'dinner', !!dinnerDish, L.dinner, { del: 'Eliminar cena', reroll: 'Cambiar cena' })}
          </div>
        </div>
      </article>
    `;
  }).join('');

  wireWeekActions(grid);
  initWeekDnd(grid);
}

function wireWeekActions(grid) {
  grid.querySelectorAll('.meal-reroll').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); rerollMeal(parseInt(btn.dataset.day), btn.dataset.meal); });
  });
  grid.querySelectorAll('.meal-delete').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteMeal(parseInt(btn.dataset.day), btn.dataset.meal); });
  });
  grid.querySelectorAll('.meal-lock').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleLock(parseInt(btn.dataset.day), btn.dataset.meal); });
  });
}

async function toggleLock(dayIdx, meal) {
  const day = state.week[dayIdx];
  if (!day[meal]) return;            // no tiene sentido fijar un hueco vacío
  day.locked[meal] = !day.locked[meal];
  await persistWeek();
  renderWeek();
}

// Limpia las sobras encadenadas (mismo plato, slots leftover contiguos) que
// cuelgan de un lead fresco en el mismo carril de comida.
function clearTrailingLeftovers(dayIdx, meal, dishId) {
  for (let d = dayIdx + 1; d < state.week.length; d++) {
    if (state.week[d][meal] === dishId && state.week[d].leftover[meal]) {
      state.week[d][meal] = null;
      state.week[d].leftover[meal] = false;
      state.week[d].locked[meal] = false;
    } else {
      break;
    }
  }
}

async function deleteMeal(dayIdx, meal) {
  // Granular: vacía solo el slot clicado. Si era el lead de un batch, arrastra
  // también sus sobras (no tendría sentido dejarlas sin el plato cocinado).
  const day = state.week[dayIdx];
  const freshLead = !day.leftover[meal] ? day[meal] : null;
  day[meal] = null;
  day.locked[meal] = false;
  day.leftover[meal] = false;
  if ((meal === 'lunch' || meal === 'dinner') && freshLead) {
    clearTrailingLeftovers(dayIdx, meal, freshLead);
  }
  await persistWeek();
  await buildShoppingList();
  renderWeek();
}

// ============ DRAG & DROP (mover platos entre slots) ============
let dragCtx = null;

function initWeekDnd(grid) {
  grid.querySelectorAll('.draggable-dish').forEach(el => {
    el.addEventListener('pointerdown', onDragStart);
  });
}

function onDragStart(e) {
  if (e.button != null && e.button > 0) return;   // solo botón principal / touch
  const el = e.currentTarget;
  dragCtx = {
    fromDay: parseInt(el.dataset.day), fromMeal: el.dataset.meal,
    el, startX: e.clientX, startY: e.clientY,
    active: false, ghost: null, lastTarget: null
  };
  window.addEventListener('pointermove', onDragMove, { passive: false });
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}

function slotFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const line = el.closest('.meal-line');
  if (!line || !line.dataset.meal) return null;
  if (line.classList.contains('is-locked')) return null;   // no soltar en fijado
  return line;
}

function onDragMove(e) {
  if (!dragCtx) return;
  const dx = e.clientX - dragCtx.startX, dy = e.clientY - dragCtx.startY;
  if (!dragCtx.active) {
    if (Math.hypot(dx, dy) < 8) return;   // umbral: distingue tap/scroll de drag
    dragCtx.active = true;
    document.body.classList.add('dragging-meal');
    dragCtx.el.classList.add('drag-source');
    const g = document.createElement('div');
    g.className = 'drag-ghost';
    g.textContent = dragCtx.el.textContent;
    document.body.appendChild(g);
    dragCtx.ghost = g;
  }
  if (dragCtx.ghost) {
    dragCtx.ghost.style.left = e.clientX + 'px';
    dragCtx.ghost.style.top = e.clientY + 'px';
  }
  const target = slotFromPoint(e.clientX, e.clientY);
  if (dragCtx.lastTarget && dragCtx.lastTarget !== target) dragCtx.lastTarget.classList.remove('drop-target');
  if (target) target.classList.add('drop-target');
  dragCtx.lastTarget = target;
  e.preventDefault();
}

async function onDragEnd(e) {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  const ctx = dragCtx;
  dragCtx = null;
  if (!ctx) return;
  document.body.classList.remove('dragging-meal');
  if (ctx.ghost) ctx.ghost.remove();
  if (ctx.el) ctx.el.classList.remove('drag-source');
  if (ctx.lastTarget) ctx.lastTarget.classList.remove('drop-target');
  if (!ctx.active) return;
  const target = slotFromPoint(e.clientX, e.clientY);
  if (!target) return;
  const toDay = parseInt(target.dataset.day), toMeal = target.dataset.meal;
  if (toDay === ctx.fromDay && toMeal === ctx.fromMeal) return;
  await moveDish(ctx.fromDay, ctx.fromMeal, toDay, toMeal);
}

// ¿Encaja `dish` en un slot de tipo `meal`? (null = hueco vacío, siempre vale)
function dishFitsSlot(dish, meal) {
  if (!dish) return true;
  if (meal === 'lunchStarter') return (dish.type === 'comida' || dish.type === 'ambos') && dish.role === 'starter';
  if (meal === 'lunch') return (dish.type === 'comida' || dish.type === 'ambos') && dish.role !== 'starter';
  if (meal === 'dinner') return (dish.type === 'cena' || dish.type === 'ambos') && dish.role !== 'starter';
  return true;
}

async function moveDish(fromDay, fromMeal, toDay, toMeal) {
  const a = state.week[fromDay], b = state.week[toDay];
  if (a.locked[fromMeal] || b.locked[toMeal]) { showToast('Hay un plato fijado'); return; }
  const aId = a[fromMeal], bId = b[toMeal];
  const aDish = aId ? state.dishes.find(d => d.id === aId) : null;
  const bDish = bId ? state.dishes.find(d => d.id === bId) : null;
  if (!dishFitsSlot(aDish, toMeal)) { showToast(`"${aDish?.name}" no encaja ahí`); return; }
  if (!dishFitsSlot(bDish, fromMeal)) { showToast(`"${bDish?.name}" no encaja ahí`); return; }

  // Mover rompe los lazos de batch: limpiamos las sobras de los leads movidos.
  if ((fromMeal === 'lunch' || fromMeal === 'dinner') && aId && !a.leftover[fromMeal]) clearTrailingLeftovers(fromDay, fromMeal, aId);
  if ((toMeal === 'lunch' || toMeal === 'dinner') && bId && !b.leftover[toMeal]) clearTrailingLeftovers(toDay, toMeal, bId);

  a[fromMeal] = bId; a.leftover[fromMeal] = false;
  b[toMeal] = aId;   b.leftover[toMeal] = false;

  if (fromMeal === 'lunch') ensureStarter(state.week, fromDay);
  if (toMeal === 'lunch') ensureStarter(state.week, toDay);

  await persistWeek();
  await buildShoppingList();
  renderWeek();
  showToast('Plato movido');
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

  // Valoración (configurable): favoritos salen más, flojos casi nunca.
  if (state.useRatings) weight *= (RATING_WEIGHT[dish.rating] ?? 1.0);
  // Historial (configurable): penaliza repetir lo de la última semana.
  if (state.useHistory && state.recentDishIds.has(dish.id)) weight *= SCORE.recentWeek;

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

// Filtro DURO por restricciones dietéticas activas. Un plato pasa si NO contiene
// ninguno de los flags excluidos por las restricciones activas.
function matchesRestrictions(d) {
  if (!state.restrictions || state.restrictions.length === 0) return true;
  const contains = d.contains || [];
  for (const rid of state.restrictions) {
    const r = RESTRICTIONS.find(x => x.id === rid);
    if (r && r.excludes.some(flag => contains.includes(flag))) return false;
  }
  return true;
}

// Pasa los dos filtros que afectan a TODOS los pools.
function eligible(d) {
  return matchesSeason(d) && matchesRestrictions(d);
}

// Pools por tipo de slot. El "principal" de la comida acepta role 'main' o
// 'complete'; los entrantes solo 'starter'. La cena nunca lleva entrante.
function lunchMainPool() {
  return state.dishes.filter(d =>
    (d.type === 'comida' || d.type === 'ambos')
    && (d.role === 'main' || d.role === 'complete' || !d.role)
    && eligible(d)
  );
}
function lunchStarterPool() {
  return state.dishes.filter(d =>
    (d.type === 'comida' || d.type === 'ambos')
    && d.role === 'starter'
    && eligible(d)
  );
}
function dinnerPool() {
  return state.dishes.filter(d =>
    (d.type === 'cena' || d.type === 'ambos')
    && (d.role === 'main' || d.role === 'complete' || !d.role)
    && eligible(d)
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

// Batch cooking: si el plato rinde para N comidas, rellena los siguientes
// slots del MISMO carril como sobras (no cuentan para la compra). Se detiene en
// huecos ya ocupados o fijados.
function placeLeftovers(week, leadDay, meal, dish) {
  const yields = Math.max(1, dish.yields || 1);
  if (yields < 2) return;
  let placed = 1;
  for (let d = leadDay + 1; d < week.length && placed < yields; d++) {
    if (week[d].locked[meal] || week[d][meal]) break;
    week[d][meal] = dish.id;
    week[d].leftover[meal] = true;
    placed++;
  }
}

// Garantiza la coherencia del entrante de la comida del día i: respeta lo
// fijado; sin entrante si el principal es 'complete' o es sobras; asigna uno si
// el principal es 'main' y no hay.
function ensureStarter(week, i) {
  if (week[i].locked.lunchStarter) return;
  const main = week[i].lunch ? state.dishes.find(d => d.id === week[i].lunch) : null;
  if (!main || main.role === 'complete' || week[i].leftover.lunch) {
    if (week[i].lunchStarter) week[i].lunchStarter = null;
    return;
  }
  if (!week[i].lunchStarter) week[i].lunchStarter = pickStarterFor(main, week, i);
}

// Archiva la semana actual (si tiene contenido) en el historial y poda las más
// antiguas. Solo si el historial está activo.
async function archiveCurrentWeek() {
  if (!state.useHistory || !state.week) return;
  const hasContent = state.week.some(day => day.lunch || day.lunchStarter || day.dinner);
  if (!hasContent) return;
  const snapshot = {
    id: uid(),
    data: state.week.map(d => ({ lunch: d.lunch, lunchStarter: d.lunchStarter, dinner: d.dinner })),
    generatedAt: state.weekGeneratedAt || Date.now(),
    archivedAt: Date.now()
  };
  await idb.put(STORE_HISTORY, snapshot);
  const all = (await idb.getAll(STORE_HISTORY)).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  for (const old of all.slice(HISTORY_LIMIT)) await idb.delete(STORE_HISTORY, old.id);
}

async function generateWeek() {
  await loadDishes();
  const lunches = lunchMainPool();
  const dinners = dinnerPool();

  if (lunches.length === 0) { showToast('Necesitas un plato de comida (revisa restricciones/estación)'); return; }
  if (dinners.length === 0) { showToast('Necesitas un plato de cena (revisa restricciones/estación)'); return; }

  // Archivamos la semana saliente y recalculamos la penalización de recientes.
  await archiveCurrentWeek();
  await loadHistory();

  // Partimos de huecos vacíos salvo los FIJADOS, que se conservan tal cual.
  const prev = state.week;
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = emptyDay();
    if (prev && prev[i]) {
      for (const meal of SLOT_FIELDS) {
        if (prev[i].locked?.[meal] && prev[i][meal]) {
          d[meal] = prev[i][meal];
          d.locked[meal] = true;
          d.leftover[meal] = !!prev[i].leftover?.[meal];
        }
      }
    }
    return d;
  });

  for (let i = 0; i < 7; i++) {
    if (!week[i].lunch) {
      const pick = weightedPick(lunches, d => scoreDish(d, week, i, 'lunch'));
      if (pick) { week[i].lunch = pick.id; placeLeftovers(week, i, 'lunch', pick); }
    }
    ensureStarter(week, i);
    if (!week[i].dinner) {
      const pick = weightedPick(dinners, d => scoreDish(d, week, i, 'dinner'));
      if (pick) { week[i].dinner = pick.id; placeLeftovers(week, i, 'dinner', pick); }
    }
  }

  state.week = week;
  state.weekGeneratedAt = Date.now();
  await persistWeek();
  await buildShoppingList();
  renderWeek();
  showToast('Semana generada');
}

async function rerollMeal(dayIdx, meal) {
  const day = state.week[dayIdx];
  if (day.locked[meal]) { showToast('Ese plato está fijado'); return; }

  let pool;
  if (meal === 'lunch') pool = lunchMainPool();
  else if (meal === 'lunchStarter') pool = lunchStarterPool();
  else pool = dinnerPool();
  if (pool.length === 0) { showToast('No hay platos disponibles para este hueco'); return; }

  const previous = day[meal];
  // Reroll manual = un solo slot. Si era lead de un batch, soltamos sus sobras.
  if ((meal === 'lunch' || meal === 'dinner') && previous && !day.leftover[meal]) {
    clearTrailingLeftovers(dayIdx, meal, previous);
  }
  day[meal] = null;
  day.leftover[meal] = false;

  const candidates = pool.filter(d => d.id !== previous);
  const finalPool = candidates.length > 0 ? candidates : pool;
  const picked = weightedPick(finalPool, d => scoreDish(d, state.week, dayIdx, meal));
  day[meal] = picked ? picked.id : previous;

  // Coherencia del entrante al cambiar el principal de la comida.
  if (meal === 'lunch') ensureStarter(state.week, dayIdx);

  await persistWeek();
  await buildShoppingList();
  renderWeek();
}

// ============ SHOPPING LIST ============
function aggregateField(dishIds, fieldName) {
  // Devuelve Map<nameLower, {name, totals, raws, sources}>:
  // - totals: Map<unitKey, {dim, unit, value}> sumas de cantidades parseadas.
  // - raws:   Map<qtyCruda, conteo> cantidades que no se pudieron parsear.
  // - sources: Map<dishId, {name, count}> plato origen y veces que se cocina.
  // Las cantidades parseadas y las crudas NO se mezclan (evita duplicación).
  const aggregated = new Map();
  dishIds.forEach(id => {
    const dish = state.dishes.find(d => d.id === id);
    if (!dish) return;
    // Solo cuentan los slots FRESCOS (no sobras): un batch se cocina una vez.
    let occurrences = 0;
    state.week.forEach(day => {
      if (day.lunch === id && !day.leftover?.lunch) occurrences++;
      if (day.lunchStarter === id && !day.leftover?.lunchStarter) occurrences++;
      if (day.dinner === id && !day.leftover?.dinner) occurrences++;
    });
    if (occurrences === 0) return;   // solo aparece como sobras → no se cocina
    (dish[fieldName] || []).forEach(item => {
      const key = item.name.toLowerCase().trim();
      if (!key) return;
      if (!aggregated.has(key)) {
        aggregated.set(key, { name: item.name, totals: new Map(), raws: new Map(), sources: new Map() });
      }
      const entry = aggregated.get(key);
      const rawQty = item.qty ? item.qty.trim() : '';
      if (rawQty) {
        const parsed = parseQty(rawQty);
        if (parsed) {
          const uk = parsed.dim === 'count' ? `count:${parsed.unit}` : parsed.dim;
          const cur = entry.totals.get(uk) || { dim: parsed.dim, unit: parsed.unit, value: 0 };
          cur.value += parsed.value * occurrences;
          entry.totals.set(uk, cur);
        } else {
          entry.raws.set(rawQty, (entry.raws.get(rawQty) || 0) + occurrences);
        }
      }
      if (!entry.sources.has(dish.id)) {
        entry.sources.set(dish.id, { name: dish.name, count: occurrences });
      }
    });
  });
  return aggregated;
}

function materializeShoppingItems(aggregated, previousChecked, kind) {
  const items = Array.from(aggregated.values()).map(item => {
    const parts = [];
    for (const total of item.totals.values()) parts.push(formatQtyTotal(total));
    for (const [raw, count] of item.raws) parts.push(count > 1 ? `${raw} ×${count}` : raw);
    const sources = Array.from(item.sources.values())
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return {
      id: uid(),
      kind,
      name: item.name,
      qty: parts.join(' + '),
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

  let ingredients = materializeShoppingItems(ingredientsAgg, previousChecked, 'ingredient');
  let spices = materializeShoppingItems(spicesAgg, previousChecked, 'spice');

  // Despensa: ocultamos lo que ya tienes en casa (por nombre normalizado).
  const pantry = pantrySet();
  const before = ingredients.length + spices.length;
  if (pantry.size > 0) {
    ingredients = ingredients.filter(it => !pantry.has(it.name.toLowerCase().trim()));
    spices = spices.filter(it => !pantry.has(it.name.toLowerCase().trim()));
  }
  state.pantryHidden = before - (ingredients.length + spices.length);
  state.shopping = ingredients;
  state.spicesShopping = spices;

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
      <button type="button" class="shopping-pantry" data-name="${escapeHtml(item.name)}" aria-label="Ya lo tengo en casa" title="Ya lo tengo · mover a la despensa">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8M5 10v10h14V10"/></svg>
      </button>
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

  const pantryNote = state.pantryHidden > 0
    ? `<span class="pantry-note">🏠 ${state.pantryHidden} en tu despensa</span>`
    : '';

  if (!hasIngredients && !hasSpices) {
    list.classList.remove('visible');
    spicesSection.classList.remove('visible');
    if (state.pantryHidden > 0) {
      empty.classList.remove('visible');
      meta.innerHTML = pantryNote + ' · todo lo demás ya lo tienes';
    } else {
      empty.classList.add('visible');
      meta.textContent = '';
    }
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
    const pantryBtn = el.querySelector('.shopping-pantry');
    if (pantryBtn) {
      pantryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        addToPantry(pantryBtn.dataset.name);
      });
    }
  };

  if (hasIngredients) {
    list.classList.add('visible');
    const total = state.shopping.length;
    const checked = state.shopping.filter(s => s.checked).length;
    meta.innerHTML = `<span>${checked} / ${total}</span> · ingredientes para la semana${pantryNote ? ' · ' + pantryNote : ''}`;
    list.innerHTML = state.shopping.map(shoppingItemHtml).join('');
    list.querySelectorAll('.shopping-item').forEach(wireShoppingItem);
  } else {
    list.classList.remove('visible');
    list.innerHTML = '';
    meta.innerHTML = pantryNote;
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

// ============ DESPENSA ============
async function addToPantry(name) {
  const clean = (name || '').trim();
  if (!clean) return;
  const exists = state.pantry.some(p => p.name.toLowerCase() === clean.toLowerCase());
  if (!exists) {
    const entry = { id: uid(), name: clean };
    state.pantry.push(entry);
    state.pantry.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    await idb.put(STORE_PANTRY, entry);
  }
  await buildShoppingList();   // re-filtra: lo que ya tienes desaparece de la compra
  renderPantry();
  showToast(`"${clean}" guardado en la despensa`);
}

async function removeFromPantry(id) {
  const idx = state.pantry.findIndex(p => p.id === id);
  if (idx < 0) return;
  state.pantry.splice(idx, 1);
  await idb.delete(STORE_PANTRY, id);
  await buildShoppingList();
  renderPantry();
}

// ============ COMPARTIR LISTA ============
function shoppingListText() {
  const lines = ['🛒 Lista de la compra · MiMenu', ''];
  if (state.shopping.length) {
    lines.push('INGREDIENTES');
    state.shopping.forEach(it => lines.push(`• ${it.name}${it.qty ? ` — ${it.qty}` : ''}`));
  }
  if (state.spicesShopping.length) {
    if (state.shopping.length) lines.push('');
    lines.push('ESPECIAS');
    state.spicesShopping.forEach(it => lines.push(`• ${it.name}${it.qty ? ` — ${it.qty}` : ''}`));
  }
  return lines.join('\n');
}

async function shareShoppingList() {
  if (state.shopping.length === 0 && state.spicesShopping.length === 0) {
    showToast('No hay nada que compartir');
    return;
  }
  const text = shoppingListText();
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Lista de la compra', text });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // el usuario canceló
      // si share falla por otro motivo, caemos al portapapeles
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Lista copiada al portapapeles');
  } catch {
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }
}

// ============ MODAL DESPENSA ============
function renderPantry() {
  const list = document.getElementById('pantryList');
  if (!list) return;
  if (state.pantry.length === 0) {
    list.innerHTML = `<li class="pantry-empty">Aún no hay nada. Marca «ya lo tengo» 🏠 en la lista de la compra, o añádelo aquí arriba.</li>`;
    return;
  }
  list.innerHTML = state.pantry.map(p => `
    <li>
      <span class="ing-name">${escapeHtml(p.name)}</span>
      <button type="button" class="ing-remove" data-id="${p.id}" aria-label="Quitar de la despensa">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </li>`).join('');
  list.querySelectorAll('.ing-remove').forEach(btn => {
    btn.addEventListener('click', () => removeFromPantry(btn.dataset.id));
  });
}

function openPantry() {
  closeDrawer();
  renderPantry();
  document.getElementById('pantryBackdrop').classList.add('visible');
}
function closePantry() {
  document.getElementById('pantryBackdrop').classList.remove('visible');
}
async function addPantryFromInput() {
  const input = document.getElementById('pantryInput');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  await addToPantry(name);
  input.value = '';
  input.focus();
}

// ============ MODAL HISTORIAL / ESTADÍSTICAS ============
function computeStats() {
  const counts = new Map();   // dishId -> nº de apariciones
  let totalSlots = 0;
  state.history.forEach(w => (w.data || []).forEach(day => {
    ['lunch', 'lunchStarter', 'dinner'].forEach(slot => {
      if (day[slot]) { counts.set(day[slot], (counts.get(day[slot]) || 0) + 1); totalSlots++; }
    });
  }));
  const ranked = Array.from(counts.entries())
    .map(([id, count]) => ({ dish: state.dishes.find(d => d.id === id), count }))
    .filter(x => x.dish)
    .sort((a, b) => b.count - a.count);
  return { ranked, totalSlots, distinct: counts.size, weeks: state.history.length };
}

function renderHistory() {
  const body = document.getElementById('historyBody');
  if (!body) return;
  const stats = computeStats();
  if (stats.weeks === 0) {
    body.innerHTML = `<p class="history-empty">Todavía no hay semanas archivadas. Cada vez que generes una semana nueva, la anterior se guardará aquí.</p>`;
    return;
  }
  const top = stats.ranked.slice(0, 8);
  const maxCount = top.length ? top[0].count : 1;
  const variety = stats.totalSlots ? Math.round((stats.distinct / stats.totalSlots) * 100) : 0;
  body.innerHTML = `
    <div class="stats-grid">
      <div class="stat"><span class="stat-num">${stats.weeks}</span><span class="stat-label">semanas</span></div>
      <div class="stat"><span class="stat-num">${stats.distinct}</span><span class="stat-label">platos distintos</span></div>
      <div class="stat"><span class="stat-num">${variety}%</span><span class="stat-label">variedad</span></div>
    </div>
    <h4 class="stats-heading">Platos más frecuentes</h4>
    <ul class="stats-list">
      ${top.map(x => `<li>
        <span class="stats-name">${escapeHtml(x.dish.name)}</span>
        <span class="stats-bar"><span style="width:${Math.round((x.count / maxCount) * 100)}%"></span></span>
        <span class="stats-count">${x.count}</span>
      </li>`).join('')}
    </ul>
    <button type="button" class="btn-ghost stats-clear" id="clearHistory">Borrar historial</button>
  `;
  const clr = document.getElementById('clearHistory');
  if (clr) clr.addEventListener('click', clearHistory);
}

function openHistory() {
  closeDrawer();
  renderHistory();
  document.getElementById('historyBackdrop').classList.add('visible');
}
function closeHistory() {
  document.getElementById('historyBackdrop').classList.remove('visible');
}
async function clearHistory() {
  if (!confirm('¿Borrar todo el historial de semanas?')) return;
  await idb.clear(STORE_HISTORY);
  await loadHistory();
  renderHistory();
  showToast('Historial borrado');
}

// ============ IMPORTAR RECETA (texto / URL) ============
function parseIngredientLine(line) {
  const s = line.replace(/^[\-*•·•]\s*/, '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)\s+(.*)$/);
  if (!m) return { name: s, qty: '' };
  const num = m[1];
  const words = m[2].trim().split(/\s+/);
  const firstWord = words[0].toLowerCase().replace(/[.)]+$/, '');
  let qty, nameWords;
  if (UNIT_DEFS[firstWord] || firstWord in COUNT_UNITS) {
    qty = `${num} ${firstWord}`;
    nameWords = words.slice(1);
  } else {
    qty = num;
    nameWords = words;
  }
  if (nameWords[0] && /^de$/i.test(nameWords[0])) nameWords = nameWords.slice(1);
  const name = nameWords.join(' ').trim();
  return { name: name || m[2].trim(), qty };
}

function findRecipeNode(json) {
  const isRecipe = (o) => {
    if (!o || typeof o !== 'object') return false;
    const t = o['@type'];
    return t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));
  };
  const stack = [json];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) { stack.push(...cur); continue; }
    if (cur && typeof cur === 'object') {
      if (isRecipe(cur)) return cur;
      if (Array.isArray(cur['@graph'])) stack.push(...cur['@graph']);
      for (const k in cur) if (cur[k] && typeof cur[k] === 'object') stack.push(cur[k]);
    }
  }
  return null;
}

// Intenta extraer una receta de JSON-LD (schema.org/Recipe) presente en HTML o
// en JSON pegado directamente. Devuelve {name, ingredients} o null.
function parseRecipeJsonLd(text) {
  const candidates = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let mm;
  while ((mm = re.exec(text))) candidates.push(mm[1]);
  const t = text.trim();
  if (candidates.length === 0 && (t.startsWith('{') || t.startsWith('['))) candidates.push(t);
  for (const c of candidates) {
    let json;
    try { json = JSON.parse(c); } catch { continue; }
    const recipe = findRecipeNode(json);
    if (!recipe) continue;
    const name = typeof recipe.name === 'string' ? recipe.name.trim() : '';
    const ingRaw = Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient
                 : Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    const ingredients = ingRaw.map(x => typeof x === 'string' ? parseIngredientLine(x) : null).filter(Boolean);
    if (name || ingredients.length) return { name, ingredients };
  }
  return null;
}

function parseRecipeText(text) {
  const fromLd = parseRecipeJsonLd(text);
  if (fromLd) return fromLd;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const name = lines[0].replace(/^#+\s*/, '').trim();
  const ingredients = lines.slice(1).map(parseIngredientLine).filter(Boolean);
  return { name, ingredients };
}

function openImport() {
  closeDrawer();
  document.getElementById('recipeUrl').value = '';
  document.getElementById('recipeText').value = '';
  document.getElementById('importBackdrop').classList.add('visible');
  setTimeout(() => document.getElementById('recipeUrl').focus(), 100);
}
function closeImport() {
  document.getElementById('importBackdrop').classList.remove('visible');
}

async function importRecipeFromUrl() {
  const url = document.getElementById('recipeUrl').value.trim();
  if (!url) { showToast('Pega una URL de receta'); return; }
  showToast('Leyendo la receta…');
  try {
    const res = await fetch(url, { mode: 'cors' });
    const html = await res.text();
    const parsed = parseRecipeJsonLd(html);
    if (parsed && (parsed.name || parsed.ingredients.length)) {
      closeImport();
      openCreateDish(parsed);
      showToast('Receta importada · revísala y guarda');
      return;
    }
    showToast('No encontré datos de receta. Prueba a pegar el texto abajo.');
  } catch (err) {
    showToast('El sitio bloquea la lectura. Copia el texto y pégalo abajo.');
  }
}

function importRecipeFromText() {
  const text = document.getElementById('recipeText').value;
  const parsed = parseRecipeText(text);
  if (!parsed || (!parsed.name && parsed.ingredients.length === 0)) {
    showToast('No pude extraer la receta del texto');
    return;
  }
  closeImport();
  openCreateDish(parsed);
  showToast('Receta importada · revísala y guarda');
}

// ============ EXPORT / IMPORT ============
async function exportData() {
  try {
    const dishes = await idb.getAll(STORE_DISHES);
    const week = await idb.get(STORE_WEEK, 'current');
    const shopping = await idb.getAll(STORE_SHOPPING);
    const settings = await idb.getAll(STORE_SETTINGS);
    const history = await idb.getAll(STORE_HISTORY);
    const pantry = await idb.getAll(STORE_PANTRY);

    const payload = {
      app: 'mise',
      schemaVersion: DB_VERSION,
      exportedAt: new Date().toISOString(),
      dishes,
      week: week?.data || null,
      weekGeneratedAt: week?.generatedAt || null,
      shopping,
      settings,
      history,
      pantry
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
    contains: Array.isArray(d.contains) ? d.contains.filter(c => CONTAINS_FLAGS.some(f => f.id === c)) : [],
    rating: typeof d.rating === 'number' && d.rating >= 0 && d.rating <= 5 ? Math.round(d.rating) : 0,
    yields: typeof d.yields === 'number' && d.yields >= 1 ? Math.min(4, Math.round(d.yields)) : 1,
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
    // Una sola transacción sobre los 6 stores: o todo o nada.
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        [STORE_DISHES, STORE_WEEK, STORE_SHOPPING, STORE_SETTINGS, STORE_HISTORY, STORE_PANTRY],
        'readwrite'
      );
      const dishStore = transaction.objectStore(STORE_DISHES);
      const weekStore = transaction.objectStore(STORE_WEEK);
      const shoppingStore = transaction.objectStore(STORE_SHOPPING);
      const settingsStore = transaction.objectStore(STORE_SETTINGS);
      const historyStore = transaction.objectStore(STORE_HISTORY);
      const pantryStore = transaction.objectStore(STORE_PANTRY);

      dishStore.clear();
      weekStore.clear();
      shoppingStore.clear();
      settingsStore.clear();
      historyStore.clear();
      pantryStore.clear();

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
      (Array.isArray(payload.history) ? payload.history : []).forEach(h => {
        if (h && typeof h.id === 'string' && Array.isArray(h.data)) historyStore.put(h);
      });
      (Array.isArray(payload.pantry) ? payload.pantry : []).forEach(p => {
        if (p && typeof p.id === 'string' && typeof p.name === 'string') pantryStore.put(p);
      });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    await loadAccent();
    await initTheme();
    await loadCustomTags();
    await loadSeasonMode();
    await loadShowSources();
    await loadRestrictions();
    await loadToggles();
    await loadPantry();
    await loadHistory();
    applySeasonChip();
    applyShowSourcesCheckbox();
    renderAccentSwatches();
    renderRestrictions();
    applyToggleButtons();
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
    await ensurePersistence();
    await loadAccent();
    await initTheme();      // applyTheme() ya aplica acento y marca el tema activo
    await loadCustomTags();
    await loadSeasonMode();
    await loadShowSources();
    await loadRestrictions();
    await loadToggles();
    await loadPantry();
    await loadHistory();
    initTabs();
    initFilters();
    initSeasonFilter();
    initShowSourcesToggle();
    initSearch();
    initToggles();
    applySeasonChip();
    applyShowSourcesCheckbox();
    renderAccentSwatches();
    renderRestrictions();
    applyToggleButtons();
    document.getElementById('drawerVersion').textContent = `MiMenu · v${APP_VERSION}`;

    // Event handlers
    document.getElementById('menuToggle').addEventListener('click', openDrawer);
    document.getElementById('drawerClose').addEventListener('click', closeDrawer);
    document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);
    document.querySelectorAll('.seg-option[data-theme-opt]').forEach(btn => {
      btn.addEventListener('click', () => setTheme(btn.dataset.themeOpt));
    });
    document.getElementById('openChangelog').addEventListener('click', openChangelog);
    document.getElementById('changelogClose').addEventListener('click', closeChangelog);
    document.getElementById('changelogBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'changelogBackdrop') closeChangelog();
    });

    // Despensa
    document.getElementById('openPantry').addEventListener('click', openPantry);
    document.getElementById('pantryClose').addEventListener('click', closePantry);
    document.getElementById('pantryBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'pantryBackdrop') closePantry();
    });
    document.getElementById('addPantry').addEventListener('click', addPantryFromInput);
    document.getElementById('pantryInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addPantryFromInput(); }
    });

    // Historial / estadísticas
    document.getElementById('openHistory').addEventListener('click', openHistory);
    document.getElementById('historyClose').addEventListener('click', closeHistory);
    document.getElementById('historyBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'historyBackdrop') closeHistory();
    });

    // Importar receta
    document.getElementById('openImport').addEventListener('click', openImport);
    document.getElementById('importClose').addEventListener('click', closeImport);
    document.getElementById('importBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'importBackdrop') closeImport();
    });
    document.getElementById('importUrlBtn').addEventListener('click', importRecipeFromUrl);
    document.getElementById('importTextBtn').addEventListener('click', importRecipeFromText);

    // Compartir lista de la compra
    document.getElementById('shareShopping').addEventListener('click', shareShoppingList);

    document.getElementById('openCreateDish').addEventListener('click', () => openCreateDish());
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
      if (e.key !== 'Escape') return;
      const vis = (id) => document.getElementById(id).classList.contains('visible');
      if (vis('modalBackdrop')) hideModal();
      else if (vis('importBackdrop')) closeImport();
      else if (vis('pantryBackdrop')) closePantry();
      else if (vis('historyBackdrop')) closeHistory();
      else if (vis('changelogBackdrop')) closeChangelog();
      else if (document.getElementById('drawer').classList.contains('open')) closeDrawer();
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
