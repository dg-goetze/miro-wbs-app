/* =========================================================================
   WBS Builder – app.js
   - Verwaltet eine hierarchische Liste (links) im App-Storage
   - Berechnet beim Sync ein Diff (neu / geändert / gelöscht)
   - Erzeugt/aktualisiert/löscht Shapes + Connectors auf dem Miro-Board
   ========================================================================= */

const STORAGE_KEY = 'wbs-tree-v1';

// Farben je Ebene (0 = Wurzel). Dies ist die STANDARD-Farbe pro Ebene.
// Einzelne Knoten können das über node.customColor überschreiben (siehe resolveNodeColor).
const LEVEL_COLORS = ['#f25c54', '#7c3aed', '#2563eb', '#16a34a', '#f59e0b'];

// Kuratierte Farbpalette zur Auswahl, angelehnt an Miros eigene Farbauswahl-UI
// (begrenzte, aufeinander abgestimmte Auswahl statt freiem Hex-Eingabefeld).
const COLOR_PALETTE = [
  '#f25c54', '#f59e0b', '#eab308', '#16a34a', '#0ea5e9',
  '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#6b7280'
];

// Liefert die tatsächlich zu verwendende Farbe für einen Knoten:
// die manuell gewählte customColor, falls gesetzt, sonst die Standardfarbe seiner Ebene.
function resolveNodeColor(node, depth) {
  if (node.customColor) return node.customColor;
  return LEVEL_COLORS[Math.min(depth, LEVEL_COLORS.length - 1)];
}

// Layout-Konstanten: vertikaler Baum (Ebene 0 oben, höhere Ebenen darunter).
// Geschwister-Knoten der gleichen Ebene stehen standardmäßig mit gleichem Abstand
// nebeneinander in einer Reihe; Eltern werden horizontal über ihren Kindern zentriert.
// AUSNAHME: Auf der in VERTICAL_LEVEL_DEPTH konfigurierten Tiefe werden Geschwister
// stattdessen UNTEREINANDER mit gleichem Abstand gestapelt (umschaltbar in der UI).
const LAYOUT = {
  nodeWidth: 220,
  // HINWEIS: Miro-Karten (anders als Rechtecke) haben keine fest einstellbare Höhe –
  // die Höhe wird von Miro automatisch anhand des Titel-/Beschreibungstexts berechnet.
  // nodeHeight ist daher nur eine Schätzung für die Layout-Berechnung (Abstände).
  // Bei sehr langen Titeln kann die tatsächliche Karte etwas höher ausfallen als
  // geschätzt; die Abstände (rowGap/vGap) puffern das in den meisten Fällen ab.
  nodeHeight: 160, // Geschätzte Kartenhöhe inkl. Polsterzeilen (tatsächliche Höhe wird per
                   // Höhenangleichung pro Ebene normalisiert)
  colGap: 40,     // horizontaler Abstand zwischen Geschwister-Knoten (horizontal-Modus)
  rowGap: 220,    // vertikaler Abstand zwischen Hierarchie-Ebenen
  vGap: 40,       // vertikaler Abstand zwischen gestapelten Geschwistern (vertikal-Modus)
  startX: 0,
  startY: 0
};

// Tiefe (0-indiziert), auf der Geschwister standardmäßig vertikal statt horizontal
// angeordnet werden. Tiefe 3 = die 4. Ebene inklusive Wurzel (in der App grün dargestellt).
let VERTICAL_LEVEL_DEPTH = 3;
let level4LayoutMode = localStorage.getItem(STORAGE_KEY + '-level4-mode') || 'vertical';

function isVerticalLevel(depth) {
  return depth === VERTICAL_LEVEL_DEPTH && level4LayoutMode === 'vertical';
}

/* ---------- Datenmodell ----------
Ein Knoten:
{
  id: 'n_xxx',          // interne, stabile UUID (wird NICHT angezeigt)
  code: '1.1.2',        // sichtbarer hierarchischer Code (wird aus Position berechnet)
  title: 'Vergabe- und Planungsklärung ...',
  children: [ ... ],
  miro: {
    shapeId: '...',     // Miro-ID des erzeugten Shapes (sobald gesynct)
    x, y,                // letzte bekannte Board-Position
    lastSyncedTitle: '...' // um Änderungen zu erkennen
  },
  connectorIds: {}      // connectorId zu jedem Kind, key = childId
}
------------------------------------ */

let tree = loadTree();

function loadTree() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { /* fällt durch */ }
  }
  // Default: ein Wurzelknoten, analog "0. Cable Installation"
  return [
    makeNode('Cable Installation')
  ];
}

function saveTree() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tree));
}

function makeNode(title) {
  return {
    id: 'n_' + Math.random().toString(36).slice(2, 10),
    title: stripLeadingNumbering(title),
    children: [],
    miro: null,
    connectorIds: {}
  };
}

// Entfernt eine führende Nummerierung aus einem Titel-Text, z.B.:
// "1. Installationsvorbereitung" -> "Installationsvorbereitung"
// "1.1  Vergabe- und Planungsklärung" -> "Vergabe- und Planungsklärung"
// "0. Cable Installation" -> "Cable Installation"
// Wird sowohl beim Import als auch bei manueller Titel-Eingabe angewendet, damit der
// gespeicherte Titel NIE eine eigene Nummer enthält (die Nummer kommt ausschließlich
// aus dem automatisch berechneten node.code, nie aus dem Titel-Text selbst).
function stripLeadingNumbering(title) {
  if (!title) return title;
  return title.replace(/^\s*\d+(?:\.\d+)*\.?\s+/, '').trim();
}

/* ============================== Eigenes Dialog-System ==============================
   WICHTIG: Native alert()/confirm()/prompt() werden in Miro-App-Panels (iframe-Kontext)
   nicht zuverlässig angezeigt und können die App in einen blockierten Zustand bringen,
   in dem nichts mehr klickbar ist. Deshalb werden hier eigene, sichtbare UI-Overlays
   verwendet statt der nativen Browser-Dialoge.
   ========================================================================= */
function showNotice(message, type = 'info') {
  const overlay = document.getElementById('dialogOverlay');
  overlay.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'dialog-box';
  const msg = document.createElement('div');
  msg.className = 'dialog-message';
  msg.textContent = message;
  box.appendChild(msg);
  const okBtn = document.createElement('button');
  okBtn.className = 'btn btn-primary';
  okBtn.textContent = 'OK';
  okBtn.addEventListener('click', () => { overlay.classList.remove('visible'); });
  box.appendChild(okBtn);
  overlay.appendChild(box);
  overlay.classList.add('visible');
}

function showConfirm(message, onConfirm) {
  const overlay = document.getElementById('dialogOverlay');
  overlay.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'dialog-box';
  const msg = document.createElement('div');
  msg.className = 'dialog-message';
  msg.textContent = message;
  box.appendChild(msg);

  const btnRow = document.createElement('div');
  btnRow.className = 'dialog-btn-row';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Abbrechen';
  cancelBtn.addEventListener('click', () => { overlay.classList.remove('visible'); });

  const okBtn = document.createElement('button');
  okBtn.className = 'btn btn-primary';
  okBtn.textContent = 'Bestätigen';
  okBtn.addEventListener('click', () => {
    overlay.classList.remove('visible');
    onConfirm();
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(okBtn);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  overlay.classList.add('visible');
}

// Zeigt eine Liste anklickbarer Optionen (Ersatz für prompt() bei der Text-Widget-Auswahl)
function showChoice(message, options, onChoose) {
  const overlay = document.getElementById('dialogOverlay');
  overlay.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'dialog-box';
  const msg = document.createElement('div');
  msg.className = 'dialog-message';
  msg.textContent = message;
  box.appendChild(msg);

  const list = document.createElement('div');
  list.className = 'dialog-choice-list';
  options.forEach((optionLabel, idx) => {
    const optBtn = document.createElement('button');
    optBtn.className = 'dialog-choice-item';
    optBtn.textContent = optionLabel;
    optBtn.addEventListener('click', () => {
      overlay.classList.remove('visible');
      onChoose(idx);
    });
    list.appendChild(optBtn);
  });
  box.appendChild(list);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Abbrechen';
  cancelBtn.style.marginTop = '8px';
  cancelBtn.addEventListener('click', () => { overlay.classList.remove('visible'); });
  box.appendChild(cancelBtn);

  overlay.appendChild(box);
  overlay.classList.add('visible');
}

/* ---------- Import: Text mit nummerierter Gliederung in einen Baum parsen ----------
   Erwartetes Format (analog Referenzbild), eine Zeile pro Eintrag:
     0. Cable Installation
     1. Installationsvorbereitung
     1.1 Vergabe- und Planungsklärung für Teil Cable Installation zuarbeiten
     1.1.1 ...
     2. Ausführungs- und Durchführungsplanung
     2.1 Grundlagen ermitteln und konsolidieren

   Die Tiefe wird rein aus der Anzahl der Punkte im Nummern-Präfix abgeleitet:
   "1" -> Tiefe 1, "1.1" -> Tiefe 2, "1.1.1" -> Tiefe 3, usw.
   "0" (oder "0.") wird als alleinige Wurzel (Tiefe 0) behandelt.
   Zeilen ohne erkennbares Nummern-Präfix werden anhand der Einrückung (Tabs/Leerzeichen)
   als Kind der zuletzt gesehenen Zeile der nächsthöheren Ebene eingeordnet (Fallback).
*/
function parseOutlineText(text) {
  const lines = text.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim().length > 0);
  const numberedPattern = /^\s*(\d+(?:\.\d+)*)\.?\s+(.+)$/;

  const roots = [];
  // stack[i] = letzter Knoten, der auf Tiefe i eingefügt wurde
  const stack = [];

  for (const rawLine of lines) {
    const match = rawLine.match(numberedPattern);
    let depth, title;

    if (match) {
      const numberPart = match[1];
      title = match[2].trim();
      const segments = numberPart.split('.');
      // "0" -> Tiefe 0 (Wurzel). "1" -> Tiefe 1 (Kind der Wurzel). "1.1" -> Tiefe 2. usw.
      if (segments.length === 1 && segments[0] === '0') {
        depth = 0;
      } else {
        depth = segments.length;
      }
    } else {
      // Fallback: Einrückung zählen (jede Tab-Stufe oder je 2 Leerzeichen = 1 Ebene tiefer
      // als der zuletzt erkannte Knoten)
      const indentMatch = rawLine.match(/^(\s*)/);
      const indentLevel = Math.floor((indentMatch[1].match(/\t/g) || []).length
        + (indentMatch[1].replace(/\t/g, '').length / 2));
      depth = Math.max(1, indentLevel);
      title = rawLine.trim();
    }

    const node = makeNode(title);

    if (depth === 0 || stack.length === 0) {
      roots.push(node);
      stack.length = 0;
      stack[0] = node;
    } else {
      // Eltern = letzter bekannter Knoten auf depth - 1
      let parent = stack[depth - 1];
      if (!parent) {
        // Keine passende Eltern-Ebene gefunden (z.B. Sprung von Tiefe 1 auf Tiefe 3) ->
        // hänge an die tiefste bekannte Ebene, um nichts zu verlieren
        const deepestKnown = stack.filter(Boolean).pop();
        parent = deepestKnown || roots[roots.length - 1];
      }
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
      stack[depth] = node;
    }
    // Tiefere Ebenen verwerfen, da ein neuer Knoten auf dieser Tiefe begonnen hat
    stack.length = depth + 1;
    stack[depth] = node;
  }

  return roots;
}

/* ---------- Hierarchische Codes berechnen (1, 1.1, 1.1.1, ...) ----------
   Zwei umschaltbare Schemata (Einstellung showRootNumber):
   - AN (Standard):  Wurzel bekommt eine eigene Nummer (ROOT_START_NUMBER, Standard 1),
                      Kinder hängen sich mit Punkt an: 1, 1.1, 1.1.1, ...
   - AUS:             Wurzel bekommt KEINE Nummer (wird nur als Titel angezeigt),
                      die direkten Kinder der Wurzel starten direkt bei 1, 2, 3 ...
                      und die Zählung läuft ab dort wie gewohnt weiter: 1, 1.1, 1.1.1, ...
   Bei mehreren Wurzelknoten wird die Wurzel-Ebene weiterhin hochgezählt (1, 2, 3, ...),
   unabhängig vom showRootNumber-Schalter.
*/
let ROOT_START_NUMBER = parseInt(localStorage.getItem(STORAGE_KEY + '-root-start'), 10) || 1;
let showRootNumber = localStorage.getItem(STORAGE_KEY + '-show-root-number') !== 'false'; // Standard: true

function assignCodes(nodes, prefix = '', depth = 0) {
  nodes.forEach((node, idx) => {
    if (depth === 0) {
      if (showRootNumber) {
        node.code = `${ROOT_START_NUMBER + idx}`;
      } else {
        node.code = ''; // keine eigene Nummer für die Wurzel
      }
    } else if (depth === 1 && !showRootNumber) {
      // Direkte Kinder der Wurzel starten bei 1, 2, 3 ..., NICHT an einen
      // (leeren) Wurzel-Code angehängt
      node.code = `${idx + 1}`;
    } else {
      node.code = prefix ? `${prefix}.${idx + 1}` : `${idx + 1}`;
    }
    if (node.children && node.children.length) {
      assignCodes(node.children, node.code, depth + 1);
    }
  });
}

function setRootStartNumber(newValue) {
  const parsed = parseInt(newValue, 10);
  if (isNaN(parsed)) return;
  ROOT_START_NUMBER = parsed;
  localStorage.setItem(STORAGE_KEY + '-root-start', String(parsed));
  renderTree();
  renderDiffSummary();
}

function setShowRootNumber(value) {
  showRootNumber = value;
  localStorage.setItem(STORAGE_KEY + '-show-root-number', String(value));
  renderTree();
  renderDiffSummary();
}

/* ---------- Baum-Hilfsfunktionen ---------- */
function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

function findParentArray(nodes, id, parentArr = null) {
  for (const n of nodes) {
    if (n.id === id) return parentArr || nodes;
    if (n.children) {
      const res = findParentArray(n.children, id, n.children);
      if (res) return res;
    }
  }
  return null;
}

function removeNode(nodes, id) {
  const idx = nodes.findIndex(n => n.id === id);
  if (idx !== -1) {
    nodes.splice(idx, 1);
    return true;
  }
  for (const n of nodes) {
    if (n.children && removeNode(n.children, id)) return true;
  }
  return false;
}

function flatten(nodes, depth = 0, parentId = null, out = []) {
  nodes.forEach(n => {
    out.push({ node: n, depth, parentId });
    if (n.children && n.children.length) {
      flatten(n.children, depth + 1, n.id, out);
    }
  });
  return out;
}

/* ============================== UI: Baum rendern ============================== */
function renderTree() {
  assignCodes(tree);
  const container = document.getElementById('treeContainer');
  container.innerHTML = '';
  tree.forEach(node => container.appendChild(renderNode(node, 0)));

  // Zusätzliche Absicherung: alle Titel-Textareas einmal auf ihre Inhaltshöhe setzen,
  // nachdem der gesamte Baum im DOM eingefügt ist (zuverlässiger als sich nur auf den
  // einzelnen requestAnimationFrame-Call pro Knoten zu verlassen).
  requestAnimationFrame(() => {
    container.querySelectorAll('.node-title').forEach(el => {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    });
  });
}

function renderNode(node, depth) {
  const wrapper = document.createElement('div');
  wrapper.className = 'node';

  // --- Zeile 1: Farbe, Code, Titel-Input, Status ---
  const row = document.createElement('div');
  row.className = 'node-row';

  const dot = document.createElement('button');
  dot.type = 'button';
  dot.className = 'node-color-dot';
  dot.title = 'Farbe ändern';
  dot.style.background = resolveNodeColor(node, depth);
  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    showColorPicker(dot, node, depth);
  });
  row.appendChild(dot);

  const idSpan = document.createElement('span');
  idSpan.className = 'node-id';
  idSpan.textContent = node.code || '–';
  row.appendChild(idSpan);

  const input = document.createElement('textarea');
  input.className = 'node-title';
  input.value = node.title;
  input.dataset.nodeId = node.id;
  input.placeholder = '(Titel eingeben)';
  input.rows = 1;

  // Auto-Resize: die Höhe des Textfelds wächst automatisch mit dem Inhalt,
  // damit lange Titel komplett lesbar sind (mehrzeilig statt abgeschnitten).
  function autoResize() {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  }
  // Initiale Höhe setzen, sobald das Element im DOM ist (nach dem Einfügen in 'row').
  requestAnimationFrame(autoResize);

  input.addEventListener('input', () => {
    node.title = input.value;
    saveTree();
    autoResize();
    // WICHTIG: hier NICHT renderTree() aufrufen – das würde das Input-Feld
    // neu erzeugen und den Cursor/Fokus verlieren (Ursache für "nur 1 Buchstabe tippbar").
    // Stattdessen nur das Status-Badge dieser Zeile gezielt aktualisieren.
    const badge = row.querySelector('.node-status');
    if (badge) setStatusBadge(badge, node);
  });
  input.addEventListener('keydown', (e) => {
    // Enter im Titel-Feld soll keinen Zeilenumbruch im Titel selbst erzeugen
    // (ein WBS-Titel ist ein einzelner Eintrag) – Enter springt statt dessen
    // aus dem Feld heraus (blur), als Komfortfunktion.
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    // Erst beim Verlassen des Feldes eine eventuell mitgetippte führende Nummer
    // entfernen (z.B. "1. Mein Titel" -> "Mein Titel") – die Nummer kommt immer
    // aus node.code, nie aus dem Titel-Text selbst. Während des Tippens wird das
    // NICHT live gemacht, damit Zahlen mit Punkt normal eingegeben werden können.
    const cleaned = stripLeadingNumbering(input.value);
    if (cleaned !== input.value) {
      input.value = cleaned;
      node.title = cleaned;
      saveTree();
      autoResize();
    }
  });
  row.appendChild(input);

  const statusBadge = document.createElement('span');
  statusBadge.className = 'node-status';
  row.appendChild(statusBadge);
  setStatusBadge(statusBadge, node);

  wrapper.appendChild(row);

  // --- Zeile 2: Aktions-Buttons (eigene Zeile, damit sie bei jeder Panel-Breite
  //     sichtbar und klickbar bleiben – vorher in Zeile 1 gequetscht/abgeschnitten) ---
  const actions = document.createElement('div');
  actions.className = 'node-actions';

  const moveUpBtn = makeIconBtn('↑', 'Nach oben verschieben (vor den vorherigen Geschwister-Knoten)', () => {
    const arr = findParentArray(tree, node.id) || tree;
    const idx = arr.findIndex(n => n.id === node.id);
    if (idx > 0) {
      [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
      saveTree();
      renderTree();
      renderDiffSummary();
    }
  });
  const moveDownBtn = makeIconBtn('↓', 'Nach unten verschieben (hinter den nächsten Geschwister-Knoten)', () => {
    const arr = findParentArray(tree, node.id) || tree;
    const idx = arr.findIndex(n => n.id === node.id);
    if (idx !== -1 && idx < arr.length - 1) {
      [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
      saveTree();
      renderTree();
      renderDiffSummary();
    }
  });
  const addChildBtn = makeIconBtn('+ Unterpunkt', 'Unterpunkt hinzufügen', () => {
    node.children.push(makeNode('Neuer Punkt'));
    saveTree();
    renderTree();
  });
  const addSiblingBtn = makeIconBtn('+ Danach', 'Geschwister-Knoten danach einfügen', () => {
    const arr = findParentArray(tree, node.id) || tree;
    const idx = arr.findIndex(n => n.id === node.id);
    arr.splice(idx + 1, 0, makeNode('Neuer Punkt'));
    saveTree();
    renderTree();
  });
  const deleteBtn = makeIconBtn('✕ Löschen', 'Knoten löschen (inkl. Unterpunkte)', () => {
    showConfirm(`"${node.title}" und alle Unterpunkte löschen?`, () => {
      removeNode(tree, node.id);
      saveTree();
      renderTree();
    });
  }, 'btn-danger');

  actions.appendChild(moveUpBtn);
  actions.appendChild(moveDownBtn);
  actions.appendChild(addChildBtn);
  actions.appendChild(addSiblingBtn);
  actions.appendChild(deleteBtn);
  wrapper.appendChild(actions);

  if (node.children && node.children.length) {
    const childWrap = document.createElement('div');
    childWrap.className = 'node-children';
    node.children.forEach(child => childWrap.appendChild(renderNode(child, depth + 1)));
    wrapper.appendChild(childWrap);
  }

  return wrapper;
}

function makeIconBtn(label, title, onClick, extraClass = '') {
  const btn = document.createElement('button');
  btn.className = 'btn-icon' + (extraClass ? ' ' + extraClass : '');
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

/* ============================== Farbauswahl-Popover ==============================
   Öffnet eine kleine, direkt am Farbpunkt positionierte Palette (kein großer Dialog),
   ähnlich der Farbauswahl, die man aus Miro selbst kennt. Bietet die kuratierte Palette
   plus eine Option, zur automatischen Ebenenfarbe zurückzukehren.
   ========================================================================= */
let activeColorPicker = null;

function closeColorPicker() {
  if (activeColorPicker) {
    activeColorPicker.remove();
    activeColorPicker = null;
    document.removeEventListener('click', closeColorPicker);
  }
}

function showColorPicker(anchorEl, node, depth) {
  closeColorPicker();

  const picker = document.createElement('div');
  picker.className = 'color-picker-popover';

  const swatchGrid = document.createElement('div');
  swatchGrid.className = 'color-picker-grid';
  COLOR_PALETTE.forEach(color => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    swatch.style.background = color;
    swatch.title = color;
    if (node.customColor === color) swatch.classList.add('selected');
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      node.customColor = color;
      saveTree();
      closeColorPicker();
      renderTree();
      renderDiffSummary();
    });
    swatchGrid.appendChild(swatch);
  });
  picker.appendChild(swatchGrid);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'color-picker-reset';
  resetBtn.textContent = 'Standardfarbe der Ebene verwenden';
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    delete node.customColor;
    saveTree();
    closeColorPicker();
    renderTree();
    renderDiffSummary();
  });
  picker.appendChild(resetBtn);

  document.body.appendChild(picker);

  // Popover relativ zum geklickten Farbpunkt positionieren
  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = `${rect.bottom + window.scrollY + 4}px`;
  picker.style.left = `${rect.left + window.scrollX}px`;

  activeColorPicker = picker;
  // Klick außerhalb des Popovers schließt es (mit leichtem Timeout, damit der
  // öffnende Klick selbst nicht sofort wieder schließt)
  setTimeout(() => document.addEventListener('click', closeColorPicker), 0);
}

function setStatusBadge(el, node) {
  if (!node.miro || !node.miro.shapeId) {
    el.textContent = 'neu';
    el.className = 'node-status status-new';
  } else if (node.miro.lastSyncedTitle !== node.title) {
    el.textContent = 'geändert';
    el.className = 'node-status status-modified';
  } else {
    el.textContent = 'synced';
    el.className = 'node-status status-synced';
  }
}

function updateStatusBadge(node) {
  // Re-render nur des betroffenen Badges wäre aufwändiger; einfacher: ganzer Baum neu zeichnen
  // ist bei WBS-Größen (typisch < 200 Knoten) performant genug.
  renderTree();
}

/* ============================== Diff-Berechnung ============================== */
function computeDiff() {
  const flat = flatten(tree);
  const toAdd = [];
  const toUpdate = [];
  // gelöschte Knoten erkennen wir separat (siehe unten), da sie nicht mehr im Baum sind

  flat.forEach(({ node }) => {
    if (!node.miro || !node.miro.shapeId) {
      toAdd.push(node);
    } else if (node.miro.lastSyncedTitle !== node.title) {
      toUpdate.push(node);
    }
  });

  return { toAdd, toUpdate, flat };
}

function renderDiffSummary() {
  const { toAdd, toUpdate } = computeDiff();
  const container = document.getElementById('diffSummary');
  container.innerHTML = '';

  const groups = [
    { label: 'Wird neu angelegt', items: toAdd, cls: 'add' },
    { label: 'Wird aktualisiert', items: toUpdate, cls: 'update' }
  ];

  groups.forEach(g => {
    const groupEl = document.createElement('div');
    groupEl.className = 'diff-group';
    const h3 = document.createElement('h3');
    h3.textContent = `${g.label} (${g.items.length})`;
    groupEl.appendChild(h3);

    if (g.items.length === 0) {
      const p = document.createElement('div');
      p.className = 'diff-item none';
      p.textContent = '— keine —';
      groupEl.appendChild(p);
    } else {
      g.items.forEach(n => {
        const item = document.createElement('div');
        item.className = `diff-item ${g.cls}`;
        item.textContent = `${n.code} ${n.title}`;
        groupEl.appendChild(item);
      });
    }
    container.appendChild(groupEl);
  });
}

/* ============================== Auto-Layout (Positionen berechnen) ============================== */
// Hybrid-Baum-Layout:
// - Auf den meisten Ebenen: Y = Ebene * Zeilenabstand (alle Knoten der Ebene auf
//   gleicher Höhe), X = horizontale Position, Geschwister nebeneinander verteilt.
// - Auf der konfigurierten VERTICAL_LEVEL_DEPTH: die Kinder eines Elternknotens werden
//   stattdessen UNTEREINANDER gestapelt (gleiches X wie der Elternknoten + Versatz,
//   wachsende Y-Werte mit konstantem Abstand), statt auf der globalen Ebenen-Reihe.
function computeLayout() {
  // Schritt 1: für jeden Knoten die Breite UND Höhe seines Teilbaums berechnen.
  // subtreeWidth: wie breit der Bereich sein muss, den dieser Knoten (inkl. Nachkommen)
  //   horizontal einnimmt.
  // subtreeHeight: zusätzliche vertikale Ausdehnung durch vertikal gestapelte Kinder
  //   (über die normale Ebenen-Höhe hinaus). Bei rein horizontalen Teilbäumen ist das 0.
  function measure(node, depth) {
    if (!node.children || node.children.length === 0) {
      node._subtreeWidth = LAYOUT.nodeWidth;
      node._subtreeHeight = 0;
      return;
    }

    node.children.forEach(child => measure(child, depth + 1));

    if (isVerticalLevel(depth + 1)) {
      // Kinder werden untereinander gestapelt: Breite = breitestes Kind (meist nodeWidth),
      // Höhe = Summe aller Kinderhöhen (jeweils nodeHeight + vGap dazwischen) plus
      // die eigene subtreeHeight jedes Kindes (falls dessen Kinder wiederum gestapelt sind).
      const childWidths = node.children.map(c => c._subtreeWidth);
      node._subtreeWidth = Math.max(LAYOUT.nodeWidth, ...childWidths);
      const stackedHeight = node.children.reduce(
        (sum, c) => sum + LAYOUT.nodeHeight + c._subtreeHeight, 0
      ) + LAYOUT.vGap * (node.children.length - 1);
      node._subtreeHeight = stackedHeight;
    } else {
      // Standard: Kinder nebeneinander, Breite = Summe der Kinderbreiten
      const childrenWidth = node.children.reduce(
        (sum, child) => sum + child._subtreeWidth, 0
      ) + LAYOUT.colGap * (node.children.length - 1);
      node._subtreeWidth = Math.max(LAYOUT.nodeWidth, childrenWidth);
      // Höhe = die maximale zusätzliche Höhe unter den Kindern (falls eines von ihnen
      // selbst einen vertikal gestapelten Teilbaum hat)
      node._subtreeHeight = Math.max(0, ...node.children.map(c => c._subtreeHeight));
    }
  }
  tree.forEach(root => measure(root, 0));

  // Schritt 2: Positionen zuweisen.
  // leftEdge = linke Kante des verfügbaren horizontalen Bereichs für diesen Knoten.
  function place(node, depth, leftEdge, y) {
    if (!node.children || node.children.length === 0) {
      const x = leftEdge + (node._subtreeWidth - LAYOUT.nodeWidth) / 2;
      node._layout = { x, y, depth };
      return;
    }

    if (isVerticalLevel(depth + 1)) {
      // Kinder direkt unter dem Elternknoten stapeln (gleiches X wie Elternknoten-Zentrum)
      const childX = leftEdge + (node._subtreeWidth - LAYOUT.nodeWidth) / 2;
      let cursorY = y + LAYOUT.rowGap;
      node.children.forEach(child => {
        place(child, depth + 1, childX - (child._subtreeWidth - LAYOUT.nodeWidth) / 2, cursorY);
        cursorY += LAYOUT.nodeHeight + child._subtreeHeight + LAYOUT.vGap;
      });
      node._layout = { x: childX, y, depth };
      return;
    }

    // Standard: Kinder nacheinander von leftEdge aus nebeneinander platzieren
    let cursorX = leftEdge;
    node.children.forEach(child => {
      place(child, depth + 1, cursorX, y + LAYOUT.rowGap);
      cursorX += child._subtreeWidth + LAYOUT.colGap;
    });

    // Eltern-Knoten horizontal über der Mitte seiner Kinder zentrieren
    const firstChild = node.children[0];
    const lastChild = node.children[node.children.length - 1];
    const center = (firstChild._layout.x + lastChild._layout.x + LAYOUT.nodeWidth) / 2;
    node._layout = { x: center - LAYOUT.nodeWidth / 2, y, depth };
  }

  let cursorLeft = LAYOUT.startX;
  tree.forEach(root => {
    place(root, 0, cursorLeft, LAYOUT.startY);
    cursorLeft += root._subtreeWidth + LAYOUT.colGap;
  });
}

/* ============================== Import aus Text-Widget ============================== */
// Sucht alle Text-Items auf dem aktuellen Board, lässt den Nutzer eines auswählen
// (falls mehrere vorhanden sind) und parst dessen Inhalt als Gliederung.
async function importFromTextWidget() {
  if (typeof miro === 'undefined') {
    showNotice('Import funktioniert nur innerhalb von Miro.');
    return;
  }

  let textItems;
  try {
    textItems = await miro.board.get({ type: 'text' });
  } catch (err) {
    console.error('[WBS Import] Fehler beim Laden der Text-Widgets:', err);
    showNotice('Konnte Text-Widgets nicht laden: ' + err.message);
    return;
  }

  if (!textItems || textItems.length === 0) {
    showNotice('Kein Text-Widget auf dem Board gefunden. Erstelle im Board ein Text-Element (Text-Tool) mit deiner Gliederung, z.B.: "0. Cable Installation", "1. Installationsvorbereitung", "1.1 Vergabe- und Planungsklärung ...", und klicke dann erneut auf "Import".');
    return;
  }

  if (textItems.length === 1) {
    processImportedTextItem(textItems[0]);
    return;
  }

  // Mehrere Text-Widgets gefunden -> eigene Auswahl-UI statt prompt()
  const choiceLabels = textItems.map((item, idx) => {
    const preview = stripHtml(item.content).trim().slice(0, 60).replace(/\n/g, ' ');
    return `${idx + 1}. ${preview || '(leer)'}`;
  });
  showChoice(
    `Es wurden ${textItems.length} Text-Widgets gefunden. Welches soll importiert werden?`,
    choiceLabels,
    (choiceIdx) => processImportedTextItem(textItems[choiceIdx])
  );
}

function processImportedTextItem(sourceItem) {
  const plainText = stripHtml(sourceItem.content);
  const parsedRoots = parseOutlineText(plainText);

  if (parsedRoots.length === 0) {
    showNotice('Konnte aus dem Text-Widget keine Gliederung erkennen. Bitte Format prüfen (z.B. "1. Titel", "1.1 Titel").');
    return;
  }

  const confirmMsg = `Es wurden ${flatten(parsedRoots).length} Einträge erkannt. ` +
    `Die aktuelle Gliederung in dieser App wird dadurch ERSETZT (bereits auf dem Board ` +
    `vorhandene Boxen bleiben unangetastet, bis du erneut auf "Sync → Board" klickst). Fortfahren?`;

  showConfirm(confirmMsg, () => {
    tree = parsedRoots;
    saveTree();
    renderTree();
    renderDiffSummary();
  });
}

function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  // <p>-Umbrüche als Zeilenumbrüche erhalten, bevor reiner Text extrahiert wird
  tmp.querySelectorAll('p, br, div').forEach(el => el.insertAdjacentText('beforebegin', '\n'));
  return tmp.textContent || tmp.innerText || '';
}
async function syncToBoard() {
  // Beim allerersten Sync (noch keine Knoten mit existierendem Shape) wird der
  // aktuelle Bildausschnitt (Viewport-Mittelpunkt) als Startpunkt für das Layout
  // verwendet, damit das Diagramm dort entsteht, wo der Nutzer aktuell hinschaut,
  // statt immer bei der festen Board-Koordinate (0,0).
  const flatBeforeLayout = flatten(tree);
  const hasAnyExistingShape = flatBeforeLayout.some(({ node }) => node.miro && node.miro.shapeId);

  if (!hasAnyExistingShape && typeof miro !== 'undefined') {
    try {
      const viewport = await miro.board.viewport.get();
      LAYOUT.startX = viewport.x + viewport.width / 2 - LAYOUT.nodeWidth / 2;
      LAYOUT.startY = viewport.y + viewport.height / 2 - LAYOUT.nodeHeight / 2;
    } catch (err) {
      console.warn('[WBS Sync] Konnte Viewport nicht lesen, verwende Standard-Startposition:', err);
    }
  }

  computeLayout();
  const flat = flatten(tree);
  const errors = [];

  // Baut den Karten-Titel-Text auf. Falls der Knoten keinen Code hat (z.B. die Wurzel,
  // wenn "Wurzel-Nr. anzeigen" deaktiviert ist), wird nur der Titel angezeigt, ohne
  // führenden Zeilenumbruch/Leerraum.
  // HINWEIS: <br> wird im Card-Titel von Miro nicht zuverlässig als Zeilenumbruch
  // respektiert (kann als Text "<br>" erscheinen oder ignoriert werden). Stattdessen
  // wird ein <p>-Absatz für Code und Titel separat verwendet, da <p> zu den von
  // Miro im title-Feld unterstützten HTML-Tags gehört und zuverlässig einen
  // Absatz-/Zeilenumbruch erzeugt.
  // "R:" steht jetzt direkt im Titel (statt in der Description), da Karten standardmäßig
  // eingeklappt angezeigt werden und die Description in diesem Zustand nicht sichtbar ist.
  function buildCardTitle(node, extraPadLines = 0) {
    const pad = '<p>&nbsp;</p>';
    const extraPadding = extraPadLines > 0 ? pad.repeat(extraPadLines) : '';
    if (!node.code) {
      return `<p>${escapeHtml(node.title)}</p>${pad}<p>R:</p>${extraPadding}`;
    }
    return `<p><b>${escapeHtml(node.code)}</b></p><p>${escapeHtml(node.title)}</p>${pad}<p>R:</p>${extraPadding}`;
  }

  // Hilfsfunktion: erzeugt eine neue Karte für einen Knoten
  // WICHTIG: computeLayout() berechnet x/y als LINKE OBERE ECKE der Karte (das ist das
  // interne Layout-Modell dieser App). Miro selbst erwartet x/y aber als MITTELPUNKT
  // des Items. Deshalb wird hier zentral umgerechnet: Mittelpunkt = linke obere Ecke
  // + halbe Breite/Höhe. Ohne diese Umrechnung würden alle Karten (und davon abgeleitet
  // auch die Anchor-Punkte) systematisch um eine halbe Kartenbreite/-höhe verschoben
  // platziert – das war die Ursache für die nicht mittig ansetzenden Verbindungslinien.
  async function createCardForNode(node, topLeftX, topLeftY, color) {
    const centerX = topLeftX + LAYOUT.nodeWidth / 2;
    const centerY = topLeftY + LAYOUT.nodeHeight / 2;
    const card = await miro.board.createCard({
      x: centerX,
      y: centerY,
      width: LAYOUT.nodeWidth,
      title: buildCardTitle(node),
      style: { cardTheme: color, fillBackground: false }
    });
    await card.setMetadata('wbsId', node.id);
    return card;
  }

  // 1. Knoten anlegen oder aktualisieren
  for (const { node, depth } of flat) {
    const color = resolveNodeColor(node, depth);
    const { x, y } = node._layout;

    try {
      if (!node.miro || !node.miro.shapeId) {
        // Neue Karte
        const card = await createCardForNode(node, x, y, color);
        node.miro = {
          shapeId: card.id,
          x, y,
          lastSyncedTitle: node.title
        };
        console.log(`[WBS Sync] Neue Karte angelegt für ${node.code}: ${card.id}`);
      } else {
        // Bestehende Karte aktualisieren.
        // STRATEGIE: Statt die Karte per card.sync() zu aktualisieren (was bei Miro
        // ein Re-Rendering auslöst und manuell aufgeklappte Karten wieder einklappt),
        // wird die Karte GELÖSCHT und NEU ERSTELLT. Die Description (z.B. manuell
        // eingetragene Verantwortliche) wird dabei aus der alten Karte übernommen.
        // Neu erstellte Karten sind immer im "aufgeklappten" Default-Zustand.
        const newCenterX = x + LAYOUT.nodeWidth / 2;
        const newCenterY = y + LAYOUT.nodeHeight / 2;

        // Prüfen, ob sich tatsächlich etwas geändert hat
        const titleChanged = (node.miro.lastSyncedTitle !== node.title);
        const positionChanged = Math.abs((node.miro.x || 0) - x) > 1 || Math.abs((node.miro.y || 0) - y) > 1;
        const colorChanged = (node.miro.lastSyncedColor || '').toLowerCase() !== (color || '').toLowerCase();

        if (titleChanged || positionChanged || colorChanged) {
          try {
            // Description aus der alten Karte lesen (bewahrt manuell eingetragene Daten)
            const oldCard = await miro.board.getById(node.miro.shapeId);
            const preservedDescription = oldCard ? (oldCard.description || '') : '';

            // Alte Karte löschen
            if (oldCard) await miro.board.remove(oldCard);

            // Neue Karte erstellen (immer aufgeklappt, da frisch erstellt)
            const newCard = await miro.board.createCard({
              x: newCenterX,
              y: newCenterY,
              width: LAYOUT.nodeWidth,
              title: buildCardTitle(node),
              description: preservedDescription,
              style: { cardTheme: color, fillBackground: false }
            });
            await newCard.setMetadata('wbsId', node.id);
            node.miro.shapeId = newCard.id;
            console.log(`[WBS Sync] Karte ${node.code} neu erstellt (Titel: ${titleChanged}, Pos: ${positionChanged}, Farbe: ${colorChanged})`);
          } catch (err) {
            console.error(`[WBS Sync] Karten-Neuerstellung für ${node.code} fehlgeschlagen:`, err);
          }
        }
        node.miro.lastSyncedTitle = node.title;
        node.miro.lastSyncedColor = color;
        node.miro.x = x;
        node.miro.y = y;
      }
    } catch (err) {
      console.error(`[WBS Sync] Fehler bei Knoten ${node.code} (${node.title}):`, err);
      errors.push(`${node.code} ${node.title}: ${err.message}`);
      // WICHTIG: hier NICHT abbrechen (kein throw) – ein fehlerhafter Knoten
      // soll nicht verhindern, dass alle anderen Knoten + Connectors trotzdem
      // angelegt werden (das war zuvor die Ursache für "keine Verbindungen/Farben").
    }
  }

  // 1b. Höhenangleichung: Alle Karten einer Ebene auf die gleiche Höhe bringen.
  //     Nach dem Erstellen aller Karten werden die tatsächlichen Höhen ausgelesen,
  //     pro Hierarchie-Ebene die größte Karte ermittelt, und kürzere Karten durch
  //     zusätzliche Polsterzeilen (<p>&nbsp;</p>) auf die Maximalhöhe aufgefüllt.
  //     Dabei wird die Karte gelöscht und neu erstellt (kein sync() → kein Zuklappen).
  const LINE_HEIGHT_ESTIMATE = 18; // geschätzte Höhe einer <p>-Zeile in dp

  // Höhen auslesen und nach Tiefe gruppieren
  const heightsByDepth = new Map();
  for (const { node, depth } of flat) {
    if (!node.miro || !node.miro.shapeId) continue;
    try {
      const card = await miro.board.getById(node.miro.shapeId);
      if (card) {
        node._actualHeight = card.height;
        node._actualDescription = card.description || '';
        if (!heightsByDepth.has(depth)) heightsByDepth.set(depth, []);
        heightsByDepth.get(depth).push({ node, depth, height: card.height });
      }
    } catch (e) { /* Karte nicht gefunden */ }
  }

  // Pro Ebene: Maximalhöhe ermitteln und kürzere Karten auffüllen
  for (const [depth, entries] of heightsByDepth) {
    const maxHeight = Math.max(...entries.map(e => e.height));
    for (const entry of entries) {
      const diff = maxHeight - entry.height;
      if (diff < 5) continue; // innerhalb der Toleranz, kein Padding nötig

      const extraLines = Math.round(diff / LINE_HEIGHT_ESTIMATE);
      if (extraLines < 1) continue;

      const { node } = entry;
      const color = resolveNodeColor(node, depth);

      try {
        // Alte Karte löschen, mit Padding neu erstellen
        const oldCard = await miro.board.getById(node.miro.shapeId);
        const preservedDescription = node._actualDescription || '';
        if (oldCard) await miro.board.remove(oldCard);

        const x = node.miro.x;
        const y = node.miro.y;
        const newCard = await miro.board.createCard({
          x: x + LAYOUT.nodeWidth / 2,
          y: y + LAYOUT.nodeHeight / 2,
          width: LAYOUT.nodeWidth,
          title: buildCardTitle(node, extraLines),
          description: preservedDescription,
          style: { cardTheme: color, fillBackground: false }
        });
        await newCard.setMetadata('wbsId', node.id);
        node.miro.shapeId = newCard.id;
        console.log(`[WBS Sync] Karte ${node.code} aufgefüllt (+${extraLines} Zeilen, Δ${Math.round(diff)}dp)`);
      } catch (err) {
        console.error(`[WBS Sync] Höhenangleichung für ${node.code} fehlgeschlagen:`, err);
      }
    }
  }

  // 2. Verbindungen zwischen Eltern und Kindern anlegen.
  //
  // Architektur: Pro Elternknoten mit Kindern wird ein "Sammelschienen"-System gebaut:
  //   a) Ein unsichtbarer "Stem"-Punkt direkt unterhalb der Elternkarte (halber Weg
  //      zwischen Eltern-Unterkante und Kind-Oberkante)
  //   b) Pro Kind ein unsichtbarer "Branch"-Punkt auf gleicher Y-Höhe wie der Stem,
  //      aber auf der X-Position des jeweiligen Kindes
  //   c) straight-Connector: Elternkarte → Stem (vertikale Linie nach unten)
  //   d) straight-Connectors: zwischen benachbarten Punkten auf der Schiene, sortiert
  //      nach X (= durchgehende horizontale Linie)
  //   e) straight-Connector pro Kind: Branch → Kind (vertikale Linie nach unten)
  //
  // Da alle Connectors 'straight' sind, gibt es kein Miro-Auto-Routing, das die
  // horizontalen Segmente auf unterschiedliche Höhen stellen könnte.
  //
  // Die Schiene wird NUR neu erstellt, wenn sich das Layout tatsächlich verändert hat
  // (neue Knoten, verschobene Positionen). Ohne Layout-Änderung bleiben alle
  // bestehenden Objekte unangetastet, um unnötiges Re-Rendering (→ Zuklappen) zu
  // vermeiden.

  const RAIL_Y_FRACTION = 0.35; // Schiene bei 35% des Abstands zwischen Eltern und Kind

  // Sammle Eltern-Kind-Beziehungen
  const childrenByParent = new Map();
  flat.forEach(({ node, parentId }) => {
    if (!parentId) return;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(node);
  });

  for (const [parentId, children] of childrenByParent) {
    const parent = findNode(tree, parentId);
    if (!parent || !parent.miro) continue;
    const validChildren = children.filter(c => c.miro);
    if (validChildren.length === 0) continue;

    // Sonderfall: Kinder auf vertikaler Ebene (alle auf gleicher X, verschiedene Y).
    // Hier braucht es keine horizontale Schiene, sondern nur einfache gerade Connectors
    // direkt von Elternkarte zum jeweiligen Kind.
    const childCenterXs = validChildren.map(c => c.miro.x + LAYOUT.nodeWidth / 2);
    const allSameX = childCenterXs.every(x => Math.abs(x - childCenterXs[0]) < 2);

    if (allSameX) {
      // Vertikale Anordnung: einfache straight-Connectors
      const layoutKey = `vertical,${parent.miro.shapeId},${parent.miro.x},${parent.miro.y},${validChildren.map(c => `${c.miro.shapeId}:${c.miro.y}`).join(',')}`;
      const previousKey = parent.miro._railLayoutKey || '';
      if (layoutKey === previousKey && parent.miro._railBuilt) continue;

      // Alte Objekte entfernen
      const oldIds = parent.miro._railObjectIds || [];
      for (const oldId of oldIds) {
        try { const old = await miro.board.getById(oldId); if (old) await miro.board.remove(old); } catch (e) {}
      }
      parent.connectorIds = {};
      const newObjectIds = [];

      try {
        for (const child of validChildren) {
          const conn = await miro.board.createConnector({
            shape: 'elbowed',
            start: { item: parent.miro.shapeId, position: { x: 0.0, y: 1.0 } },
            end: { item: child.miro.shapeId, position: { x: 0.0, y: 0.5 } },
            style: { strokeColor: '#9aa3b2', strokeWidth: 1, startStrokeCap: 'none', endStrokeCap: 'none' }
          });
          newObjectIds.push(conn.id);
          try { await miro.board.sendToBack(conn); } catch (e) {}
          parent.connectorIds[child.id] = conn.id;
        }
        parent.miro._railObjectIds = newObjectIds;
        parent.miro._railLayoutKey = layoutKey;
        parent.miro._railBuilt = true;
      } catch (err) {
        console.error(`[WBS Sync] Connector-Fehler (vertikal) bei ${parent.code}:`, err);
      }
      continue;
    }

    // Prüfen, ob sich das Layout für diesen Elternknoten geändert hat
    const parentCenterX = parent.miro.x + LAYOUT.nodeWidth / 2;
    const parentBottomY = parent.miro.y + LAYOUT.nodeHeight;
    const childTopY = validChildren[0].miro.y;
    const railY = parentBottomY + (childTopY - parentBottomY) * RAIL_Y_FRACTION;

    const currentChildXs = validChildren.map(c => c.miro.x + LAYOUT.nodeWidth / 2).sort((a, b) => a - b);
    const layoutKey = `${parent.miro.shapeId},${parentCenterX},${railY},${validChildren.map(c => `${c.miro.shapeId}:${c.miro.x}`).join(',')}`;
    const previousKey = parent.miro._railLayoutKey || '';

    if (layoutKey === previousKey && parent.miro._railBuilt) {
      // Keine Änderung → Schiene und Connectors unangetastet lassen
      continue;
    }

    // Layout hat sich geändert → altes System komplett entfernen
    const oldIds = parent.miro._railObjectIds || [];
    for (const oldId of oldIds) {
      try {
        const old = await miro.board.getById(oldId);
        if (old) await miro.board.remove(old);
      } catch (e) { /* existiert nicht mehr */ }
    }
    // Alte Connector-IDs ebenfalls leeren
    parent.connectorIds = {};

    const newObjectIds = [];

    try {
      // a) Stem-Punkt: direkt unter der Elternkarte, auf Schienen-Höhe
      const stem = await miro.board.createShape({
        shape: 'circle', x: parentCenterX, y: railY,
        width: 8, height: 8,
        style: { fillColor: '#9aa3b2', fillOpacity: 1, borderOpacity: 0 }
      });
      newObjectIds.push(stem.id);
      try { await miro.board.sendToBack(stem); } catch (e) {}

      // b) Branch-Punkte: einer pro Kind, auf Schienen-Höhe, an Kind-X
      const branchPoints = [];
      for (const child of validChildren) {
        const childCenterX = child.miro.x + LAYOUT.nodeWidth / 2;
        const branch = await miro.board.createShape({
          shape: 'circle', x: childCenterX, y: railY,
          width: 8, height: 8,
          style: { fillColor: '#9aa3b2', fillOpacity: 1, borderOpacity: 0 }
        });
        newObjectIds.push(branch.id);
        try { await miro.board.sendToBack(branch); } catch (e) {}
        branchPoints.push({ id: branch.id, x: childCenterX, childNode: child });
      }

      // c) Connector: Elternkarte → Stem (vertikale Linie nach unten)
      const stemConn = await miro.board.createConnector({
        shape: 'straight',
        start: { item: parent.miro.shapeId, position: { x: 0.5, y: 1.0 } },
        end: { item: stem.id, snapTo: 'top' },
        style: { strokeColor: '#9aa3b2', strokeWidth: 1, startStrokeCap: 'none', endStrokeCap: 'none' }
      });
      newObjectIds.push(stemConn.id);
      try { await miro.board.sendToBack(stemConn); } catch (e) {}

      // d) Horizontale Schiene: EINE durchgehende Linie von ganz links nach ganz rechts.
      //    Statt vieler kurzer Segmente (die sichtbare Lücken an den Hilfspunkten erzeugen)
      //    wird EIN Connector vom äußersten linken zum äußersten rechten Punkt gezogen.
      //    Dazwischenliegende Branch-Punkte sitzen visuell auf dieser Linie (gleiche Y),
      //    sind aber nicht Teil des Connectors — da sie transparent sind, entsteht der
      //    Eindruck einer einzigen, durchgehenden horizontalen Linie.
      const allXs = [parentCenterX, ...branchPoints.map(bp => bp.x)];
      const leftMostX = Math.min(...allXs);
      const rightMostX = Math.max(...allXs);

      // Finde die Items an den äußersten Positionen
      const allPointItems = [
        { id: stem.id, x: parentCenterX },
        ...branchPoints.map(bp => ({ id: bp.id, x: bp.x }))
      ];
      const leftItem = allPointItems.reduce((a, b) => a.x < b.x ? a : b);
      const rightItem = allPointItems.reduce((a, b) => a.x > b.x ? a : b);

      if (leftItem.id !== rightItem.id) {
        const railConn = await miro.board.createConnector({
          shape: 'straight',
          start: { item: leftItem.id, snapTo: 'right' },
          end: { item: rightItem.id, snapTo: 'left' },
          style: { strokeColor: '#9aa3b2', strokeWidth: 1, startStrokeCap: 'none', endStrokeCap: 'none' }
        });
        newObjectIds.push(railConn.id);
        try { await miro.board.sendToBack(railConn); } catch (e) {}
      }

      // e) Vertikale Linien: Branch → Kind
      for (const bp of branchPoints) {
        const childConn = await miro.board.createConnector({
          shape: 'straight',
          start: { item: bp.id, snapTo: 'bottom' },
          end: { item: bp.childNode.miro.shapeId, position: { x: 0.5, y: 0.0 } },
          style: { strokeColor: '#9aa3b2', strokeWidth: 1, startStrokeCap: 'none', endStrokeCap: 'none' }
        });
        newObjectIds.push(childConn.id);
        try { await miro.board.sendToBack(childConn); } catch (e) {}
        parent.connectorIds[bp.childNode.id] = childConn.id;
      }

      parent.miro._railObjectIds = newObjectIds;
      parent.miro._railLayoutKey = layoutKey;
      parent.miro._railBuilt = true;
    } catch (err) {
      console.error(`[WBS Sync] Schienen-Fehler bei ${parent.code}:`, err);
      errors.push(`Schiene ${parent.code}: ${err.message}`);
    }
  }

  // 3. Knoten, die im Baum gelöscht wurden, aber noch Shapes auf dem Board haben, entfernen
  await removeOrphanedShapes(flat);

  saveTree();
  renderTree();
  renderDiffSummary();

  if (errors.length > 0) {
    showNotice('Sync abgeschlossen, aber mit Fehlern:\n\n' + errors.join('\n'));
  }
}

async function removeOrphanedShapes(flat) {
  const knownIds = new Set();
  const previousRaw = localStorage.getItem(STORAGE_KEY + '-last-shapes');
  const previousIds = previousRaw ? JSON.parse(previousRaw) : [];

  flat.forEach(({ node }) => {
    if (node.miro && node.miro.shapeId) knownIds.add(node.miro.shapeId);
    if (node.miro && node.miro._railObjectIds) {
      node.miro._railObjectIds.forEach(id => knownIds.add(id));
    }
  });

  const orphaned = previousIds.filter(id => !knownIds.has(id));
  for (const shapeId of orphaned) {
    try {
      const shape = await miro.board.getById(shapeId);
      if (shape) await miro.board.remove(shape);
    } catch (e) { /* Shape existiert evtl. schon nicht mehr */ }
  }

  localStorage.setItem(STORAGE_KEY + '-last-shapes', JSON.stringify([...knownIds]));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ============================== Init & Events ============================== */

// Settings-Felder: initiale Werte aus localStorage übernehmen
const showRootNumberCheckbox = document.getElementById('showRootNumberCheckbox');
const rootStartLabel = document.getElementById('rootStartLabel');
showRootNumberCheckbox.checked = showRootNumber;
rootStartLabel.style.display = showRootNumber ? '' : 'none';
showRootNumberCheckbox.addEventListener('change', () => {
  setShowRootNumber(showRootNumberCheckbox.checked);
  rootStartLabel.style.display = showRootNumberCheckbox.checked ? '' : 'none';
});

const rootStartInput = document.getElementById('rootStartInput');
rootStartInput.value = ROOT_START_NUMBER;
rootStartInput.addEventListener('change', () => {
  setRootStartNumber(rootStartInput.value);
});

const level4LayoutSelect = document.getElementById('level4LayoutSelect');
level4LayoutSelect.value = level4LayoutMode;
level4LayoutSelect.addEventListener('change', () => {
  level4LayoutMode = level4LayoutSelect.value;
  localStorage.setItem(STORAGE_KEY + '-level4-mode', level4LayoutMode);
  // Layout-Modus wirkt sich erst beim nächsten Sync/Auto-Layout auf das Board aus;
  // ein Hinweis dazu wird über den Diff-Bereich implizit klar, da sich Positionen ändern.
});

document.getElementById('addRootBtn').addEventListener('click', () => {
  tree.push(makeNode('Neuer Wurzelpunkt'));
  saveTree();
  renderTree();
  renderDiffSummary();
});

document.getElementById('importBtn').addEventListener('click', async () => {
  const btn = document.getElementById('importBtn');
  btn.disabled = true;
  btn.textContent = 'Importiere ...';
  try {
    await importFromTextWidget();
  } catch (err) {
    console.error(err);
    showNotice('Fehler beim Import: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import aus Text-Widget';
  }
});

document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = 'Synchronisiere ...';
  try {
    await syncToBoard();
  } catch (err) {
    console.error(err);
    showNotice('Fehler beim Sync: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync → Board';
  }
});

document.getElementById('autoLayoutBtn').addEventListener('click', async () => {
  computeLayout();
  const flat = flatten(tree);
  for (const { node } of flat) {
    if (node.miro && node.miro.shapeId && node._layout) {
      const shape = await miro.board.getById(node.miro.shapeId);
      if (shape) {
        const newX = node._layout.x + LAYOUT.nodeWidth / 2;
        const newY = node._layout.y + LAYOUT.nodeHeight / 2;
        // Nur syncen, wenn sich die Position tatsächlich geändert hat (mit Toleranz),
        // um unnötiges Zuklappen durch Miros Re-Rendering zu vermeiden.
        if (Math.abs(shape.x - newX) > 1 || Math.abs(shape.y - newY) > 1) {
          shape.x = newX;
          shape.y = newY;
          await shape.sync();
        }
        node.miro.x = node._layout.x;
        node.miro.y = node._layout.y;
      }
    }
  }
  saveTree();
  await miro.board.viewport.zoomTo(
    (await miro.board.get()).filter(w => w.type === 'shape')
  );
});

renderTree();
renderDiffSummary();

/* ============================== Panel- vs. Modal-Modus ==============================
   Die App erkennt anhand eines URL-Parameters (?mode=modal), ob sie aktuell in der
   breiteren "ausgeklappten" Modal-Ansicht läuft oder im normalen, schmalen Board-Panel.
   Im Modal-Modus wird eine CSS-Klasse gesetzt, die ein breiteres Side-by-Side-Layout
   aktiviert (siehe style.css: body.modal-mode).
   ========================================================================= */
const urlParams = new URLSearchParams(window.location.search);
const isModalMode = urlParams.get('mode') === 'modal';
if (isModalMode) {
  document.body.classList.add('modal-mode');
  // Im Modal ist "Ausklappen" sinnlos (man ist ja schon ausgeklappt) -> Button verstecken
  const expandBtn = document.getElementById('expandBtn');
  if (expandBtn) expandBtn.style.display = 'none';
}

document.getElementById('expandBtn').addEventListener('click', async () => {
  if (typeof miro === 'undefined') return;
  try {
    await miro.board.ui.openModal({
      url: 'app.html?mode=modal',
      width: 900,
      height: 700
    });
  } catch (err) {
    console.error('[WBS] Konnte Modal nicht öffnen:', err);
    showNotice('Konnte die ausgeklappte Ansicht nicht öffnen: ' + err.message);
  }
});

/* ============================== Miro Panel-Registrierung ==============================
   WICHTIG: Ohne diesen Block zeigt Miro das App-Icon im Board NICHT an, selbst wenn
   die App korrekt installiert ist. Miro muss wissen, dass beim Klick auf das Icon
   ein Panel mit dieser app.html geöffnet werden soll.
   ========================================================================= */
async function initMiroIntegration() {
  if (typeof miro === 'undefined') {
    console.warn('Miro SDK nicht gefunden – läuft diese Seite außerhalb eines Miro-iframes?');
    return;
  }

  miro.board.ui.on('icon:click', async () => {
    await miro.board.ui.openPanel({ url: 'app.html' });
  });
}

initMiroIntegration();
