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

/* ---------- Hierarchische Codes berechnen (1, 1.1, 1.1.1, ...) ---------- */
function assignCodes(nodes, prefix = '') {
  nodes.forEach((node, idx) => {
    node.code = prefix ? `${prefix}.${idx + 1}` : `${idx}`; // Wurzelebene: 0,1,2...
    if (node.children && node.children.length) {
      assignCodes(node.children, node.code);
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
  input.addEventListener('input', () => {
    node.title = input.value;
    saveTree();
    updateStatusBadge(node);
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
// Spalten = Ebene (Tiefe), Reihen = Geschwister-Reihenfolge mit vertikalem Stacking
// nach Anzahl der Nachkommen (analog zum Referenzbild).
function computeLayout() {
  let cursorY = 0;

  function visit(node, depth) {
    const x = LAYOUT.startX + depth * LAYOUT.colGap;
    if (!node.children || node.children.length === 0) {
      const y = cursorY;
      cursorY += LAYOUT.nodeHeight + LAYOUT.rowGap;
      node._layout = { x, y };
      return y;
    }
    const childYs = node.children.map(child => visit(child, depth + 1));
    const y = (childYs[0] + childYs[childYs.length - 1]) / 2;
    node._layout = { x, y };
    return y;
  }

  tree.forEach(root => visit(root, 0));
}

/* ============================== Miro-Board-Sync ============================== */
async function syncToBoard() {
  computeLayout();
  const flat = flatten(tree);

  // 1. Knoten anlegen oder aktualisieren
  for (const { node, depth } of flat) {
    const color = LEVEL_COLORS[Math.min(depth, LEVEL_COLORS.length - 1)];
    const { x, y } = node._layout;

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
    } else {
      // Bestehenden Shape aktualisieren (Text und/oder Position)
      const shape = await miro.board.getById(node.miro.shapeId);
      if (shape) {
        shape.content = `<p><b>${escapeHtml(node.code)}</b></p><p>${escapeHtml(node.title)}</p><p>R:</p><p>A:</p>`;
        shape.x = x;
        shape.y = y;
        await shape.sync();
        node.miro.lastSyncedTitle = node.title;
        node.miro.x = x;
        node.miro.y = y;
      } else {
        // Shape wurde manuell vom Board gelöscht -> als "neu" behandeln
        node.miro = null;
      }
    }
  }

  // 2. Connectors zwischen Eltern und Kindern anlegen, falls noch nicht vorhanden
  for (const { node, parentId } of flat) {
    if (!parentId) continue;
    const parent = findNode(tree, parentId);
    if (!parent || !parent.miro || !node.miro) continue;

    if (!parent.connectorIds[node.id]) {
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
    }
  }

  // 3. Knoten, die im Baum gelöscht wurden, aber noch Shapes auf dem Board haben:
  //    Wir vergleichen alle bekannten shapeIds aus dem letzten Speicherstand
  //    gegen die aktuell im Baum vorhandenen.
  await removeOrphanedShapes(flat);

  saveTree();
  renderTree();
  renderDiffSummary();
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
