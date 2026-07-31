const boardEl = document.getElementById('canvas-board');
const addModal = document.getElementById('add-modal');
const boardListEl = document.getElementById('board-list');
const newBoardBtn = document.getElementById('new-board');
const deleteBoardBtn = document.getElementById('delete-board');
const synthesizeBtn = document.getElementById('synthesize-board');

const STORAGE_KEY = 'canvas_boards';
let activeBoardId = null;

async function loadData() {
  let { [STORAGE_KEY]: boards = [] } = await chrome.storage.local.get(STORAGE_KEY);
  
  // Migration from old single array format
  const { canvas_artifacts } = await chrome.storage.local.get('canvas_artifacts');
  if (canvas_artifacts && canvas_artifacts.length > 0 && boards.length === 0) {
    boards = [{ id: 'board_default', name: 'Default', widgets: canvas_artifacts }];
    await chrome.storage.local.set({ [STORAGE_KEY]: boards });
    await chrome.storage.local.remove('canvas_artifacts');
  }
  
  if (boards.length === 0) {
    boards.push({ id: 'board_default', name: 'Default', widgets: [] });
    await chrome.storage.local.set({ [STORAGE_KEY]: boards });
  }
  
  if (!activeBoardId || !boards.find(b => b.id === activeBoardId)) {
    activeBoardId = boards[0].id;
  }
  
  renderSidebar(boards);
  renderActiveBoard(boards.find(b => b.id === activeBoardId));
}

function renderSidebar(boards) {
  boardListEl.innerHTML = '';
  boards.forEach(board => {
    const li = document.createElement('li');
    li.textContent = board.name;
    if (board.id === activeBoardId) li.classList.add('active');
    li.addEventListener('click', () => {
      activeBoardId = board.id;
      renderSidebar(boards);
      renderActiveBoard(board);
    });
    boardListEl.appendChild(li);
  });
}

function renderActiveBoard(board) {
  boardEl.innerHTML = '';
  
  if (!board || board.widgets.length === 0) {
    boardEl.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: #666; padding: 100px;">No widgets in this board yet. Click "Add Widget" or ask the AI to extract a component.</div>';
    return;
  }
  
  board.widgets.forEach((art, index) => {
    const el = document.createElement('div');
    el.className = 'widget';
    el.innerHTML = `
      <div class="widget-header">
        <span class="widget-title">${art.title || art.url}</span>
        <div class="widget-controls">
          <button class="remove-btn" data-index="${index}">×</button>
        </div>
      </div>
      <iframe class="widget-frame" src="${art.url}" onload="initIframe(this, '${art.selector.replace(/'/g, "\\'")}')"></iframe>
    `;
    boardEl.appendChild(el);
  });
  
  document.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      const { [STORAGE_KEY]: boards = [] } = await chrome.storage.local.get(STORAGE_KEY);
      const active = boards.find(b => b.id === activeBoardId);
      if (active) {
        active.widgets.splice(idx, 1);
        await chrome.storage.local.set({ [STORAGE_KEY]: boards });
        loadData();
      }
    });
  });
}

// Called when iframe loads. Posts a message to customizer.js inside the iframe
window.initIframe = function(iframe, selector) {
  if (iframe.contentWindow) {
    iframe.contentWindow.postMessage({
      __openagent: true,
      type: 'ISOLATE_ELEMENT',
      selector: selector
    }, '*');
  }
};

newBoardBtn.addEventListener('click', async () => {
  const name = prompt('Enter a name for the new board:');
  if (name && name.trim()) {
    const { [STORAGE_KEY]: boards = [] } = await chrome.storage.local.get(STORAGE_KEY);
    const newBoard = { id: 'board_' + Date.now(), name: name.trim(), widgets: [] };
    boards.push(newBoard);
    await chrome.storage.local.set({ [STORAGE_KEY]: boards });
    activeBoardId = newBoard.id;
    loadData();
  }
});

deleteBoardBtn.addEventListener('click', async () => {
  if (confirm('Are you sure you want to delete this board and all its widgets?')) {
    const { [STORAGE_KEY]: boards = [] } = await chrome.storage.local.get(STORAGE_KEY);
    const newBoards = boards.filter(b => b.id !== activeBoardId);
    await chrome.storage.local.set({ [STORAGE_KEY]: newBoards });
    activeBoardId = null;
    loadData();
  }
});

synthesizeBtn.addEventListener('click', async () => {
  const { [STORAGE_KEY]: boards = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const active = boards.find(b => b.id === activeBoardId);
  if (!active || active.widgets.length === 0) return alert('No widgets to summarize on this board.');
  
  chrome.runtime.sendMessage({
    type: 'SYNTHESIZE_BOARD',
    boardName: active.name,
    widgets: active.widgets
  });
});

document.getElementById('add-manual').addEventListener('click', () => {
  addModal.classList.remove('hidden');
});

document.getElementById('close-modal').addEventListener('click', () => {
  addModal.classList.add('hidden');
});

document.getElementById('save-widget').addEventListener('click', async () => {
  const url = document.getElementById('widget-url').value.trim();
  const selector = document.getElementById('widget-selector').value.trim();
  const title = document.getElementById('widget-title').value.trim();
  
  if (!url || !selector) return alert('URL and Selector are required.');
  
  const { [STORAGE_KEY]: boards = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const active = boards.find(b => b.id === activeBoardId);
  if (active) {
    active.widgets.push({ url, selector, title });
    await chrome.storage.local.set({ [STORAGE_KEY]: boards });
  }
  
  addModal.classList.add('hidden');
  document.getElementById('widget-url').value = '';
  document.getElementById('widget-selector').value = '';
  document.getElementById('widget-title').value = '';
  loadData();
});

// Auto-refresh when AI adds a widget via storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    loadData();
  }
});

loadData();
