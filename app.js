/* =========================================================================
   WBS Builder – app.js
   - Verwaltet eine hierarchische Liste (links) im App-Storage
   - Berechnet beim Sync ein Diff (neu / geändert / gelöscht)
   - Erzeugt/aktualisiert/löscht Shapes + Connectors auf dem Miro-Board
   ========================================================================= */

const STORAGE_KEY = 'wbs-tree-v1';

// Farben je Ebene (0 = Wurzel). Passe das gern an dein Schema an.
const LEVEL_COLORS = ['#f25c54', '#7c3aed', '#2563eb', '#16a34a', '#f59e0b'];

// Layout-Konstanten für Auto-Layout (analog zum Referenzbild: Spalten je Ebene)
const LAYOUT = {
  nodeWidth: 220,
  nodeHeight: 80,
  colGap: 260,   // horizontaler Abstand zwischen Ebenen
  rowGap: 40,    // vertikaler Abstand zwischen Geschwister-Knoten
  startX: 0,
  startY: 0
};

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
    title,
    children: [],
    miro: null,
    connectorIds: {}
  };
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
   Konvention analog zum Referenzbild:
   - Der/die obersten Wurzelknoten bekommen 0, 1, 2 ... (meist nur einer: "0. Cable Installation")
   - Direkte Kinder der Wurzel bekommen 1, 2, 3 ... (analog "1. Installationsvorbereitung")
   - Tiefere Ebenen hängen sich mit Punkt an: 1.1, 1.1.1, ...
*/
function assignCodes(nodes, prefix = '', depth = 0) {
  nodes.forEach((node, idx) => {
    if (depth === 0) {
      node.code = `${idx}`; // Wurzelebene: 0, 1, 2 ...
    } else {
      node.code = prefix ? `${prefix}.${idx + 1}` : `${idx + 1}`;
    }
    if (node.children && node.children.length) {
      assignCodes(node.children, node.code, depth + 1);
    }
  });
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
}

function renderNode(node, depth) {
  const wrapper = document.createElement('div');
  wrapper.className = 'node';

  const row = document.createElement('div');
  row.className = 'node-row';

  const dot = document.createElement('span');
  dot.className = 'node-color-dot';
  dot.style.background = LEVEL_COLORS[Math.min(depth, LEVEL_COLORS.length - 1)];
  row.appendChild(dot);

  const idSpan = document.createElement('span');
  idSpan.className = 'node-id';
  idSpan.textContent = node.code;
  row.appendChild(idSpan);

  const input = document.createElement('input');
  input.className = 'node-title';
  input.value = node.title;
  input.dataset.nodeId = node.id;
  input.addEventListener('input', () => {
    node.title = input.value;
    saveTree();
    // WICHTIG: hier NICHT renderTree() aufrufen – das würde das Input-Feld
    // neu erzeugen und den Cursor/Fokus verlieren (Ursache für "nur 1 Buchstabe tippbar").
    // Stattdessen nur das Status-Badge dieser Zeile gezielt aktualisieren.
    const badge = row.querySelector('.node-status');
    if (badge) setStatusBadge(badge, node);
  });
  row.appendChild(input);

  const statusBadge = document.createElement('span');
  statusBadge.className = 'node-status';
  row.appendChild(statusBadge);
  setStatusBadge(statusBadge, node);

  const actions = document.createElement('div');
  actions.className = 'node-actions';

  const addChildBtn = makeIconBtn('+', 'Unterpunkt hinzufügen', () => {
    node.children.push(makeNode('Neuer Punkt'));
    saveTree();
    renderTree();
  });
  const addSiblingBtn = makeIconBtn('↵', 'Geschwister-Knoten danach einfügen', () => {
    const arr = findParentArray(tree, node.id) || tree;
    const idx = arr.findIndex(n => n.id === node.id);
    arr.splice(idx + 1, 0, makeNode('Neuer Punkt'));
    saveTree();
    renderTree();
  });
  const deleteBtn = makeIconBtn('✕', 'Knoten löschen (inkl. Unterpunkte)', () => {
    if (confirm(`"${node.title}" und alle Unterpunkte löschen?`)) {
      removeNode(tree, node.id);
      saveTree();
      renderTree();
    }
  });

  actions.appendChild(addChildBtn);
  actions.appendChild(addSiblingBtn);
  actions.appendChild(deleteBtn);
  row.appendChild(actions);

  wrapper.appendChild(row);

  if (node.children && node.children.length) {
    const childWrap = document.createElement('div');
    childWrap.className = 'node-children';
    node.children.forEach(child => childWrap.appendChild(renderNode(child, depth + 1)));
    wrapper.appendChild(childWrap);
  }

  return wrapper;
}

function makeIconBtn(label, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'btn-icon';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
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
// Weist jedem Knoten eine x/y-Position zu, BEVOR wir Shapes erzeugen.
// X = Ebene (Tiefe) * Spaltenabstand  ->  alle Knoten der gleichen Hierarchieebene
//     stehen exakt in der gleichen Spalte (gleiches X), unabhängig davon, wie viele
//     Geschwister/Kinder sie haben.
// Y = vertikale Position, basierend auf der Position im Baum (Blätter werden von oben
//     nach unten durchnummeriert, Elternknoten mittig zwischen ihren Kindern zentriert).
function computeLayout() {
  let cursorY = 0;

  function visit(node, depth) {
    const x = LAYOUT.startX + depth * LAYOUT.colGap;
    if (!node.children || node.children.length === 0) {
      const y = cursorY;
      cursorY += LAYOUT.nodeHeight + LAYOUT.rowGap;
      node._layout = { x, y, depth };
      return y;
    }
    const childYs = node.children.map(child => visit(child, depth + 1));
    const y = (childYs[0] + childYs[childYs.length - 1]) / 2;
    node._layout = { x, y, depth };
    return y;
  }

  tree.forEach(root => visit(root, 0));
}

/* ============================== Import aus Text-Widget ============================== */
// Sucht alle Text-Items auf dem aktuellen Board, lässt den Nutzer eines auswählen
// (falls mehrere vorhanden sind) und parst dessen Inhalt als Gliederung.
async function importFromTextWidget() {
  if (typeof miro === 'undefined') {
    alert('Import funktioniert nur innerhalb von Miro.');
    return;
  }

  let textItems;
  try {
    textItems = await miro.board.get({ type: 'text' });
  } catch (err) {
    console.error('[WBS Import] Fehler beim Laden der Text-Widgets:', err);
    alert('Konnte Text-Widgets nicht laden: ' + err.message);
    return;
  }

  if (!textItems || textItems.length === 0) {
    alert('Kein Text-Widget auf dem Board gefunden.\n\nErstelle im Board ein Text-Element (Text-Tool) mit deiner Gliederung, z.B.:\n0. Cable Installation\n1. Installationsvorbereitung\n1.1 Vergabe- und Planungsklärung ...\n\nund klicke dann erneut auf "Import".');
    return;
  }

  let sourceItem = textItems[0];
  if (textItems.length > 1) {
    // Mehrere Text-Widgets gefunden -> Vorschau der ersten ~40 Zeichen anzeigen,
    // damit der Nutzer das richtige per Nummer auswählen kann.
    const choices = textItems
      .map((item, idx) => `${idx + 1}: ${stripHtml(item.content).slice(0, 60)}`)
      .join('\n');
    const answer = prompt(
      `Es wurden ${textItems.length} Text-Widgets gefunden. Welches soll importiert werden? (Zahl eingeben)\n\n${choices}`,
      '1'
    );
    const choiceIdx = parseInt(answer, 10) - 1;
    if (isNaN(choiceIdx) || !textItems[choiceIdx]) {
      return; // Abgebrochen oder ungültige Eingabe
    }
    sourceItem = textItems[choiceIdx];
  }

  const plainText = stripHtml(sourceItem.content);
  const parsedRoots = parseOutlineText(plainText);

  if (parsedRoots.length === 0) {
    alert('Konnte aus dem Text-Widget keine Gliederung erkennen. Bitte Format prüfen (z.B. "1. Titel", "1.1 Titel").');
    return;
  }

  const confirmMsg = `Es wurden ${flatten(parsedRoots).length} Einträge erkannt. ` +
    `Die aktuelle Gliederung in dieser App wird dadurch ERSETZT (bereits auf dem Board ` +
    `vorhandene Boxen bleiben unangetastet, bis du erneut auf "Sync → Board" klickst). Fortfahren?`;
  if (!confirm(confirmMsg)) return;

  tree = parsedRoots;
  saveTree();
  renderTree();
  renderDiffSummary();
}

function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  // <p>-Umbrüche als Zeilenumbrüche erhalten, bevor reiner Text extrahiert wird
  tmp.querySelectorAll('p, br, div').forEach(el => el.insertAdjacentText('beforebegin', '\n'));
  return tmp.textContent || tmp.innerText || '';
}
async function syncToBoard() {
  computeLayout();
  const flat = flatten(tree);
  const errors = [];

  // 1. Knoten anlegen oder aktualisieren
  for (const { node, depth } of flat) {
    const color = LEVEL_COLORS[Math.min(depth, LEVEL_COLORS.length - 1)];
    const { x, y } = node._layout;

    try {
      if (!node.miro || !node.miro.shapeId) {
        // Neuer Shape
        const shape = await miro.board.createShape({
          shape: 'rectangle',
          x,
          y,
          width: LAYOUT.nodeWidth,
          height: LAYOUT.nodeHeight,
          style: {
            fillColor: '#ffffff',
            borderColor: color,
            borderWidth: 2,
            textAlign: 'left',
            textAlignVertical: 'top',
            fontSize: 11
          },
          content: `<p><b>${escapeHtml(node.code)}</b></p><p>${escapeHtml(node.title)}</p><p>R:</p><p>A:</p>`
        });
        await shape.setMetadata('wbsId', node.id);
        node.miro = {
          shapeId: shape.id,
          x, y,
          lastSyncedTitle: node.title
        };
        console.log(`[WBS Sync] Neuer Shape angelegt für ${node.code}: ${shape.id}`);
      } else {
        // Bestehenden Shape aktualisieren (Text, Position UND Farbe/Border je Ebene)
        const shape = await miro.board.getById(node.miro.shapeId);
        if (shape) {
          shape.content = `<p><b>${escapeHtml(node.code)}</b></p><p>${escapeHtml(node.title)}</p><p>R:</p><p>A:</p>`;
          shape.x = x;
          shape.y = y;
          shape.style.borderColor = color; // Farbe je Ebene immer neu setzen,
                                            // falls sich die Tiefe eines Knotens geändert hat
          await shape.sync();
          node.miro.lastSyncedTitle = node.title;
          node.miro.x = x;
          node.miro.y = y;
        } else {
          console.warn(`[WBS Sync] Shape für ${node.code} existiert auf dem Board nicht mehr – wird als neu behandelt.`);
          node.miro = null;
          // Im nächsten Durchlauf (oder durch Re-Klick auf Sync) wird er neu angelegt.
          // Hier direkt neu anlegen, damit ein einziger Klick reicht:
          const shape2 = await miro.board.createShape({
            shape: 'rectangle',
            x, y,
            width: LAYOUT.nodeWidth,
            height: LAYOUT.nodeHeight,
            style: {
              fillColor: '#ffffff',
              borderColor: color,
              borderWidth: 2,
              textAlign: 'left',
              textAlignVertical: 'top',
              fontSize: 11
            },
            content: `<p><b>${escapeHtml(node.code)}</b></p><p>${escapeHtml(node.title)}</p><p>R:</p><p>A:</p>`
          });
          await shape2.setMetadata('wbsId', node.id);
          node.miro = { shapeId: shape2.id, x, y, lastSyncedTitle: node.title };
        }
      }
    } catch (err) {
      console.error(`[WBS Sync] Fehler bei Knoten ${node.code} (${node.title}):`, err);
      errors.push(`${node.code} ${node.title}: ${err.message}`);
      // WICHTIG: hier NICHT abbrechen (kein throw) – ein fehlerhafter Knoten
      // soll nicht verhindern, dass alle anderen Knoten + Connectors trotzdem
      // angelegt werden (das war zuvor die Ursache für "keine Verbindungen/Farben").
    }
  }

  // 2. Connectors zwischen Eltern und Kindern anlegen, falls noch nicht vorhanden
  for (const { node, parentId } of flat) {
    if (!parentId) continue;
    const parent = findNode(tree, parentId);
    if (!parent || !parent.miro || !node.miro) {
      console.warn(`[WBS Sync] Connector für ${node.code} übersprungen – Eltern- oder Kind-Shape fehlt noch.`);
      continue;
    }

    if (!parent.connectorIds[node.id]) {
      try {
        const connector = await miro.board.createConnector({
          start: { item: parent.miro.shapeId },
          end: { item: node.miro.shapeId },
          style: {
            strokeColor: '#9aa3b2',
            strokeWidth: 1,
            startStrokeCap: 'none',
            endStrokeCap: 'stealth'
          }
        });
        parent.connectorIds[node.id] = connector.id;
        console.log(`[WBS Sync] Connector angelegt: ${parent.code} -> ${node.code}`);
      } catch (err) {
        console.error(`[WBS Sync] Connector-Fehler ${parent.code} -> ${node.code}:`, err);
        errors.push(`Connector ${parent.code} → ${node.code}: ${err.message}`);
      }
    }
  }

  // 3. Knoten, die im Baum gelöscht wurden, aber noch Shapes auf dem Board haben, entfernen
  await removeOrphanedShapes(flat);

  saveTree();
  renderTree();
  renderDiffSummary();

  if (errors.length > 0) {
    alert('Sync abgeschlossen, aber mit Fehlern:\n\n' + errors.join('\n'));
  }
}

async function removeOrphanedShapes(flat) {
  const knownIds = new Set();
  const previousRaw = localStorage.getItem(STORAGE_KEY + '-last-shapes');
  const previousIds = previousRaw ? JSON.parse(previousRaw) : [];

  flat.forEach(({ node }) => {
    if (node.miro && node.miro.shapeId) knownIds.add(node.miro.shapeId);
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
    alert('Fehler beim Import: ' + err.message);
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
    alert('Fehler beim Sync: ' + err.message);
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
        shape.x = node._layout.x;
        shape.y = node._layout.y;
        await shape.sync();
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
