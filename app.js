/**
 * SideDock ToDo v2 - Static / Local-Only Task Manager
 * Status-based workflow: IN_PROGRESS → WAITING → DONE
 */

(function () {
  'use strict';

  // ===== Constants =====
  const DB_NAME = 'SideDockToDo';
  const DB_VERSION = 2; // Increment for migration
  const STORE_DAYS = 'days';
  const STORE_META = 'meta';
  const ARCHIVE_DAYS = 7;

  const ESTIMATE_VALUES = [null, 5, 15, 30, 60];
  const PRIORITY_VALUES = [1, 2, 3];
  const STATUS_VALUES = ['IN_PROGRESS', 'WAITING', 'DONE'];
  const STATUS_LABELS = {
    'IN_PROGRESS': '進行中',
    'WAITING': '承認・返信待ち',
    'DONE': '完了'
  };

  const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

  // ===== State =====
  let db = null;
  let selectedDate = getTodayString();
  let currentFilter = 'all';
  let collapsedSections = {};

  // ===== DOM Elements =====
  const elements = {};

  // ===== Utility Functions =====
  function getTodayString() {
    const now = new Date();
    return formatDate(now);
  }

  function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  function generateId() {
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function formatEstimate(minutes) {
    if (minutes === null) return '—';
    return `${minutes}m`;
  }

  function parseEstimate(text) {
    const match = text.match(/(\d+)\s*(m|min|分)/i);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    const validValues = [5, 15, 30, 60];
    let closest = null;
    let minDiff = Infinity;
    for (const v of validValues) {
      const diff = Math.abs(v - value);
      if (diff < minDiff) {
        minDiff = diff;
        closest = v;
      }
    }
    return closest;
  }

  function parseTags(text) {
    const matches = text.match(/#([^\s#]+)/g) || [];
    return matches.map(t => t.slice(1));
  }

  function parseInput(input) {
    const tags = parseTags(input);
    const estimate = parseEstimate(input);

    let title = input
      .replace(/#[^\s#]+/g, '')
      .replace(/\d+\s*(m|min|分)/gi, '')
      .trim();

    if (!title) title = '（無題）';

    return { title, tags, estimate };
  }

  function getRecentDates(days) {
    const dates = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push({
        date: formatDate(d),
        dayName: DAY_NAMES[d.getDay()],
        dayNum: d.getDate(),
        isToday: i === 0
      });
    }
    return dates;
  }

  function isToday(dateString) {
    return dateString === getTodayString();
  }

  // ===== IndexedDB =====
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        db = request.result;
        resolve(db);
      };

      request.onupgradeneeded = (event) => {
        const database = event.target.result;

        if (!database.objectStoreNames.contains(STORE_DAYS)) {
          database.createObjectStore(STORE_DAYS, { keyPath: 'date' });
        }

        if (!database.objectStoreNames.contains(STORE_META)) {
          database.createObjectStore(STORE_META);
        }
      };
    });
  }

  function getDayRecord(date) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DAYS, 'readonly');
      const store = tx.objectStore(STORE_DAYS);
      const request = store.get(date);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function saveDayRecord(record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DAYS, 'readwrite');
      const store = tx.objectStore(STORE_DAYS);
      record.updatedAt = Date.now();
      const request = store.put(record);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function getAllDayRecords() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DAYS, 'readonly');
      const store = tx.objectStore(STORE_DAYS);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  function deleteDayRecord(date) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DAYS, 'readwrite');
      const store = tx.objectStore(STORE_DAYS);
      const request = store.delete(date);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function getMeta(key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function setMeta(key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      const request = store.put(value, key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function clearAllData() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DAYS, STORE_META], 'readwrite');
      tx.objectStore(STORE_DAYS).clear();
      tx.objectStore(STORE_META).clear();

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ===== Data Migration =====
  async function migrateData() {
    const allRecords = await getAllDayRecords();

    for (const record of allRecords) {
      let needsSave = false;

      for (const task of record.tasks) {
        // Migrate done boolean to status enum
        if ('done' in task && !('status' in task)) {
          task.status = task.done ? 'DONE' : 'IN_PROGRESS';
          delete task.done;
          needsSave = true;
        }

        // Ensure status exists
        if (!task.status) {
          task.status = 'IN_PROGRESS';
          needsSave = true;
        }
      }

      if (needsSave) {
        await saveDayRecord(record);
      }
    }
  }

  // ===== Data Operations =====
  async function getDateRecord(date) {
    let record = await getDayRecord(date);
    if (!record) {
      record = { date: date, tasks: [], updatedAt: Date.now() };
    }
    return record;
  }

  async function addTask(title, tags, estimate, date) {
    const record = await getDateRecord(date);
    const maxOrder = record.tasks.reduce((max, t) => Math.max(max, t.order), -1);

    const task = {
      id: generateId(),
      title,
      status: 'IN_PROGRESS',
      priority: 1,
      estimateMinutes: estimate,
      tags,
      createdAt: Date.now(),
      carriedFrom: null,
      order: maxOrder + 1
    };

    record.tasks.push(task);
    await saveDayRecord(record);
    return task;
  }

  async function updateTask(date, taskId, updates) {
    const record = await getDateRecord(date);
    const task = record.tasks.find(t => t.id === taskId);
    if (task) {
      Object.assign(task, updates);
      await saveDayRecord(record);
    }
    return task;
  }

  async function deleteTask(date, taskId) {
    const record = await getDateRecord(date);
    record.tasks = record.tasks.filter(t => t.id !== taskId);
    await saveDayRecord(record);
  }

  async function reorderTasks(date, taskIds) {
    const record = await getDateRecord(date);
    taskIds.forEach((id, index) => {
      const task = record.tasks.find(t => t.id === id);
      if (task) task.order = index;
    });
    await saveDayRecord(record);
  }

  // ===== Rollover Logic =====
  async function checkAndPerformRollover() {
    const today = getTodayString();
    const lastOpened = await getMeta('lastOpenedDate');

    if (lastOpened && lastOpened !== today) {
      await performRollover(lastOpened, today);
    }

    await setMeta('lastOpenedDate', today);
  }

  async function performRollover(fromDate, toDate) {
    const yesterdayRecord = await getDayRecord(fromDate);
    if (!yesterdayRecord) return;

    // Get IN_PROGRESS and WAITING tasks (not DONE)
    const carryTasks = yesterdayRecord.tasks.filter(t =>
      t.status === 'IN_PROGRESS' || t.status === 'WAITING'
    );

    if (carryTasks.length === 0) return;

    let todayRecord = await getDayRecord(toDate);
    if (!todayRecord) {
      todayRecord = { date: toDate, tasks: [], updatedAt: Date.now() };
    }

    const maxOrder = todayRecord.tasks.reduce((max, t) => Math.max(max, t.order), -1);

    carryTasks.forEach((task, index) => {
      const newTask = {
        id: generateId(),
        title: task.title,
        status: task.status, // Keep original status
        priority: task.priority,
        estimateMinutes: task.estimateMinutes,
        tags: [...task.tags],
        createdAt: Date.now(),
        carriedFrom: fromDate,
        order: maxOrder + 1 + index
      };
      todayRecord.tasks.push(newTask);
    });

    await saveDayRecord(todayRecord);
  }

  async function purgeOldRecords() {
    const recentDates = new Set(getRecentDates(ARCHIVE_DAYS).map(d => d.date));
    const allRecords = await getAllDayRecords();

    for (const record of allRecords) {
      if (!recentDates.has(record.date)) {
        await deleteDayRecord(record.date);
      }
    }
  }

  // ===== Export/Import =====
  async function exportData() {
    const days = await getAllDayRecords();
    const lastOpenedDate = await getMeta('lastOpenedDate');

    const data = {
      version: 2,
      exportedAt: Date.now(),
      days,
      meta: { lastOpenedDate }
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `sidedock-todo-${selectedDate}.json`;
    a.click();

    URL.revokeObjectURL(url);
  }

  async function importData(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target.result);

          if (!data.days || !Array.isArray(data.days)) {
            throw new Error('Invalid data format');
          }

          await clearAllData();

          for (const day of data.days) {
            // Migrate v1 data if needed
            for (const task of day.tasks) {
              if ('done' in task && !('status' in task)) {
                task.status = task.done ? 'DONE' : 'IN_PROGRESS';
                delete task.done;
              }
            }
            await saveDayRecord(day);
          }

          if (data.meta && data.meta.lastOpenedDate) {
            await setMeta('lastOpenedDate', data.meta.lastOpenedDate);
          }

          resolve();
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  // ===== UI Rendering =====
  function createTaskElement(task) {
    const li = document.createElement('li');
    li.className = 'task-card' + (task.status === 'DONE' ? ' done' : '');
    li.dataset.id = task.id;
    li.draggable = true;

    // Top row
    const row = document.createElement('div');
    row.className = 'task-row';

    // Status icon
    const statusIcon = document.createElement('span');
    statusIcon.className = `status-icon ${task.status}`;
    statusIcon.title = STATUS_LABELS[task.status];
    statusIcon.addEventListener('click', () => cycleStatus(task.id));
    row.appendChild(statusIcon);

    // Priority dot
    const priorityDot = document.createElement('span');
    priorityDot.className = `priority-dot priority-${task.priority}`;
    priorityDot.title = `優先度: ${['低', '中', '高'][task.priority - 1]}`;
    priorityDot.addEventListener('click', () => cyclePriority(task.id));
    row.appendChild(priorityDot);

    // Title
    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;
    title.addEventListener('dblclick', () => startEditing(task.id, title));
    row.appendChild(title);

    // Time badge
    const timeBadge = document.createElement('span');
    timeBadge.className = 'time-badge';
    timeBadge.textContent = formatTime(task.createdAt);
    row.appendChild(timeBadge);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.title = '削除';
    deleteBtn.addEventListener('click', () => handleDelete(task.id));
    row.appendChild(deleteBtn);

    li.appendChild(row);

    // Meta row
    const meta = document.createElement('div');
    meta.className = 'task-meta';

    // Estimate chip
    const estimateChip = document.createElement('span');
    estimateChip.className = 'chip estimate';
    estimateChip.textContent = formatEstimate(task.estimateMinutes);
    estimateChip.addEventListener('click', () => cycleEstimate(task.id));
    meta.appendChild(estimateChip);

    // Tag chips
    task.tags.forEach(tag => {
      const tagChip = document.createElement('span');
      tagChip.className = 'chip tag';
      tagChip.textContent = `#${tag}`;
      meta.appendChild(tagChip);
    });

    // Carried from chip
    if (task.carriedFrom) {
      const carriedChip = document.createElement('span');
      carriedChip.className = 'chip carried';
      carriedChip.textContent = `↪ ${task.carriedFrom}`;
      meta.appendChild(carriedChip);
    }

    li.appendChild(meta);

    // Drag events
    li.addEventListener('dragstart', handleDragStart);
    li.addEventListener('dragend', handleDragEnd);
    li.addEventListener('dragover', handleDragOver);
    li.addEventListener('drop', handleDrop);
    li.addEventListener('dragleave', handleDragLeave);

    return li;
  }

  async function renderTasks() {
    const record = await getDateRecord(selectedDate);
    const tasks = [...record.tasks].sort((a, b) => a.order - b.order);

    // Group by status
    const grouped = {
      'IN_PROGRESS': [],
      'WAITING': [],
      'DONE': []
    };

    tasks.forEach(task => {
      if (currentFilter === 'all' || currentFilter === task.status) {
        grouped[task.status].push(task);
      }
    });

    // Render each section
    const statusToKey = {
      'IN_PROGRESS': 'InProgress',
      'WAITING': 'Waiting',
      'DONE': 'Done'
    };

    ['IN_PROGRESS', 'WAITING', 'DONE'].forEach(status => {
      const key = statusToKey[status];
      const list = elements[`list${key}`];
      const count = elements[`count${key}`];

      if (!list || !count) return;

      // Clear list without innerHTML
      while (list.firstChild) {
        list.removeChild(list.firstChild);
      }
      count.textContent = grouped[status].length;

      if (grouped[status].length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        const icon = document.createElement('span');
        icon.className = 'empty-state-icon';
        icon.textContent = '📭';
        empty.appendChild(icon);
        list.appendChild(empty);
      } else {
        grouped[status].forEach(task => {
          list.appendChild(createTaskElement(task));
        });
      }
    });

    updateHeaderDate();
  }

  function updateHeaderDate() {
    if (isToday(selectedDate)) {
      elements.headerDate.textContent = '今日';
    } else {
      const date = new Date(selectedDate);
      const dayName = DAY_NAMES[date.getDay()];
      elements.headerDate.textContent = `${selectedDate} (${dayName})`;
    }
  }

  function renderDateStrip() {
    const dates = getRecentDates(ARCHIVE_DAYS);
    // Clear without innerHTML
    while (elements.dateStrip.firstChild) {
      elements.dateStrip.removeChild(elements.dateStrip.firstChild);
    }

    dates.forEach(d => {
      const chip = document.createElement('button');
      chip.className = 'date-chip';
      if (d.date === selectedDate) chip.classList.add('active');
      if (d.isToday) chip.classList.add('today');

      const daySpan = document.createElement('span');
      daySpan.className = 'date-chip-day';
      daySpan.textContent = d.dayName;
      chip.appendChild(daySpan);

      const dateSpan = document.createElement('span');
      dateSpan.className = 'date-chip-date';
      dateSpan.textContent = d.dayNum;
      chip.appendChild(dateSpan);

      chip.addEventListener('click', () => selectDate(d.date));
      elements.dateStrip.appendChild(chip);
    });
  }

  function selectDate(date) {
    selectedDate = date;
    renderDateStrip();
    renderTasks();
  }

  // ===== Event Handlers =====
  function handleAddTask() {
    const input = elements.taskInput.value.trim();
    if (!input) return;

    const { title, tags, estimate } = parseInput(input);
    addTask(title, tags, estimate, selectedDate).then(() => {
      elements.taskInput.value = '';
      closeAddModal();
      renderTasks();
    });
  }

  async function cycleStatus(taskId) {
    const record = await getDateRecord(selectedDate);
    const task = record.tasks.find(t => t.id === taskId);
    if (task) {
      const currentIndex = STATUS_VALUES.indexOf(task.status);
      const nextIndex = (currentIndex + 1) % STATUS_VALUES.length;
      await updateTask(selectedDate, taskId, { status: STATUS_VALUES[nextIndex] });
      renderTasks();
    }
  }

  async function cyclePriority(taskId) {
    const record = await getDateRecord(selectedDate);
    const task = record.tasks.find(t => t.id === taskId);
    if (task) {
      const nextPriority = (task.priority % 3) + 1;
      await updateTask(selectedDate, taskId, { priority: nextPriority });
      renderTasks();
    }
  }

  async function cycleEstimate(taskId) {
    const record = await getDateRecord(selectedDate);
    const task = record.tasks.find(t => t.id === taskId);
    if (task) {
      const currentIndex = ESTIMATE_VALUES.indexOf(task.estimateMinutes);
      const nextIndex = (currentIndex + 1) % ESTIMATE_VALUES.length;
      await updateTask(selectedDate, taskId, { estimateMinutes: ESTIMATE_VALUES[nextIndex] });
      renderTasks();
    }
  }

  async function handleDelete(taskId) {
    await deleteTask(selectedDate, taskId);
    renderTasks();
  }

  function startEditing(taskId, titleElement) {
    const currentText = titleElement.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-title-input';
    input.value = currentText;

    const finishEditing = async (save) => {
      if (save && input.value.trim()) {
        await updateTask(selectedDate, taskId, { title: input.value.trim() });
      }
      renderTasks();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finishEditing(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finishEditing(false);
      }
    });

    input.addEventListener('blur', () => finishEditing(true));

    titleElement.replaceWith(input);
    input.focus();
    input.select();
  }

  // ===== Drag and Drop =====
  let draggedElement = null;

  function handleDragStart(e) {
    draggedElement = e.currentTarget;
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    document.querySelectorAll('.task-card').forEach(el => {
      el.classList.remove('drag-over');
    });
    draggedElement = null;
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const target = e.currentTarget;
    if (target !== draggedElement) {
      target.classList.add('drag-over');
    }
  }

  function handleDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
  }

  function handleDrop(e) {
    e.preventDefault();
    const target = e.currentTarget;
    target.classList.remove('drag-over');

    if (!draggedElement || target === draggedElement) return;

    // Find the correct list
    const targetList = target.closest('.task-list');
    const draggedList = draggedElement.closest('.task-list');

    if (targetList !== draggedList) return; // Only reorder within same section

    const cards = Array.from(targetList.querySelectorAll('.task-card'));
    const draggedIndex = cards.indexOf(draggedElement);
    const targetIndex = cards.indexOf(target);

    if (draggedIndex < targetIndex) {
      target.after(draggedElement);
    } else {
      target.before(draggedElement);
    }

    // Save new order
    const newOrder = Array.from(targetList.querySelectorAll('.task-card')).map(el => el.dataset.id);
    reorderTasks(selectedDate, newOrder);
  }

  // ===== Section Collapse =====
  function toggleSection(sectionEl) {
    const header = sectionEl.querySelector('.section-header');
    const isCollapsed = header.dataset.collapsed === 'true';
    header.dataset.collapsed = !isCollapsed;
    sectionEl.dataset.collapsed = !isCollapsed;
  }

  // ===== Filter =====
  function setFilter(filter) {
    currentFilter = filter;
    elements.filterChips.forEach(chip => {
      chip.classList.toggle('active', chip.dataset.filter === filter);
    });
    renderTasks();
  }

  // ===== Modals =====
  function openAddModal() {
    elements.addModal.classList.remove('hidden');
    elements.taskInput.value = '';
    elements.taskInput.focus();
  }

  function closeAddModal() {
    elements.addModal.classList.add('hidden');
  }

  function openSettingsModal() {
    elements.settingsModal.classList.remove('hidden');
  }

  function closeSettingsModal() {
    elements.settingsModal.classList.add('hidden');
  }

  // ===== Confirm Dialog =====
  function showConfirmDialog(message, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const title = document.createElement('h3');
    title.textContent = '確認';
    dialog.appendChild(title);

    const msg = document.createElement('p');
    msg.textContent = message;
    dialog.appendChild(msg);

    const btns = document.createElement('div');
    btns.className = 'confirm-dialog-btns';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-cancel';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.addEventListener('click', () => overlay.remove());
    btns.appendChild(cancelBtn);

    const okBtn = document.createElement('button');
    okBtn.className = 'confirm-ok';
    okBtn.textContent = '実行';
    okBtn.addEventListener('click', () => {
      overlay.remove();
      onConfirm();
    });
    btns.appendChild(okBtn);

    dialog.appendChild(btns);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  function handlePanic() {
    showConfirmDialog('すべてのデータを削除しますか？', () => {
      showConfirmDialog('本当に削除しますか？この操作は取り消せません。', async () => {
        await clearAllData();
        closeSettingsModal();
        renderTasks();
        renderDateStrip();
      });
    });
  }

  // ===== Visibility Change Handler =====
  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      const newToday = getTodayString();
      checkAndPerformRollover().then(() => {
        purgeOldRecords();
        renderTasks();
        renderDateStrip();
      });
    }
  }

  // ===== Demo Data =====
  async function insertDemoData() {
    const record = await getDateRecord(selectedDate);
    if (record.tasks.length > 0) return;

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDate(yesterday);

    const demoTasks = [
      { title: '提案資料の最終チェック', priority: 3, estimateMinutes: 30, tags: ['client', 'docs'], status: 'IN_PROGRESS' },
      { title: 'Slack返信まとめ', priority: 2, estimateMinutes: 15, tags: ['comms'], status: 'IN_PROGRESS' },
      { title: 'デザインレビュー依頼中', priority: 2, estimateMinutes: null, tags: ['design'], status: 'WAITING' },
      { title: 'メール送付（請求書）', priority: 2, estimateMinutes: 15, tags: ['mail', 'finance'], status: 'WAITING', carriedFrom: yesterdayStr },
      { title: 'MTGアジェンダ作成', priority: 3, estimateMinutes: 30, tags: ['meeting'], status: 'IN_PROGRESS' },
      { title: '朝のストレッチ', priority: 1, estimateMinutes: 5, tags: ['health'], status: 'DONE' },
      { title: '読書メモ整理', priority: 1, estimateMinutes: null, tags: ['reading'], status: 'DONE' }
    ];

    const now = Date.now();
    demoTasks.forEach((task, index) => {
      record.tasks.push({
        id: generateId(),
        title: task.title,
        status: task.status,
        priority: task.priority,
        estimateMinutes: task.estimateMinutes,
        tags: task.tags,
        createdAt: now - (index * 60000),
        carriedFrom: task.carriedFrom || null,
        order: index
      });
    });

    await saveDayRecord(record);
  }

  // ===== Initialization =====
  async function init() {
    // Cache DOM elements
    elements.headerDate = document.getElementById('headerDate');
    elements.settingsBtn = document.getElementById('settingsBtn');
    elements.filterChips = document.querySelectorAll('.filter-chip');
    elements.sectionsContainer = document.getElementById('sectionsContainer');
    elements.listInProgress = document.getElementById('listInProgress');
    elements.listWaiting = document.getElementById('listWaiting');
    elements.listDone = document.getElementById('listDone');
    elements.countInProgress = document.getElementById('countInProgress');
    elements.countWaiting = document.getElementById('countWaiting');
    elements.countDone = document.getElementById('countDone');
    elements.dateStrip = document.getElementById('dateStrip');
    elements.fabAdd = document.getElementById('fabAdd');
    elements.addModal = document.getElementById('addModal');
    elements.modalClose = document.getElementById('modalClose');
    elements.taskInput = document.getElementById('taskInput');
    elements.modalCancel = document.getElementById('modalCancel');
    elements.modalAdd = document.getElementById('modalAdd');
    elements.settingsModal = document.getElementById('settingsModal');
    elements.settingsClose = document.getElementById('settingsClose');
    elements.exportBtn = document.getElementById('exportBtn');
    elements.importBtn = document.getElementById('importBtn');
    elements.importFile = document.getElementById('importFile');
    elements.panicBtn = document.getElementById('panicBtn');

    // Open database
    await openDatabase();

    // Migrate data
    await migrateData();

    // Check rollover
    await checkAndPerformRollover();

    // Purge old records
    await purgeOldRecords();

    // Insert demo data
    await insertDemoData();

    // Render
    renderDateStrip();
    await renderTasks();

    // Event listeners - FAB
    elements.fabAdd.addEventListener('click', openAddModal);

    // Event listeners - Add Modal
    elements.modalClose.addEventListener('click', closeAddModal);
    elements.modalCancel.addEventListener('click', closeAddModal);
    elements.modalAdd.addEventListener('click', handleAddTask);
    elements.taskInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAddTask();
      if (e.key === 'Escape') closeAddModal();
    });
    elements.addModal.addEventListener('click', (e) => {
      if (e.target === elements.addModal) closeAddModal();
    });

    // Event listeners - Settings
    elements.settingsBtn.addEventListener('click', openSettingsModal);
    elements.settingsClose.addEventListener('click', closeSettingsModal);
    elements.settingsModal.addEventListener('click', (e) => {
      if (e.target === elements.settingsModal) closeSettingsModal();
    });

    elements.exportBtn.addEventListener('click', () => {
      exportData();
      closeSettingsModal();
    });

    elements.importBtn.addEventListener('click', () => {
      elements.importFile.click();
    });

    elements.importFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        try {
          await importData(file);
          closeSettingsModal();
          renderTasks();
          renderDateStrip();
          elements.importFile.value = '';
        } catch (error) {
          console.error('Import error:', error);
        }
      }
    });

    elements.panicBtn.addEventListener('click', handlePanic);

    // Event listeners - Filters
    elements.filterChips.forEach(chip => {
      chip.addEventListener('click', () => setFilter(chip.dataset.filter));
    });

    // Event listeners - Section collapse
    document.querySelectorAll('.section-header').forEach(header => {
      header.addEventListener('click', (e) => {
        toggleSection(header.closest('.task-section'));
      });
    });

    // Visibility change listener
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  // Start app
  init().catch(console.error);
})();
