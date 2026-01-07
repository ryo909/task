/**
 * SideDock ToDo v2 - Static / Local-Only Task Manager
 * Status-based workflow: IN_PROGRESS → WAITING → DONE
 */

(function () {
  'use strict';

  // ===== Constants =====
  const DB_NAME = 'SideDockToDo';
  const DB_VERSION = 3; // v3: Add sessions store
  const STORE_DAYS = 'days';
  const STORE_META = 'meta';
  const STORE_SESSIONS = 'sessions';
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
  let currentScreen = 'tasks';

  // Focus state
  let focusState = {
    activeTaskId: null,
    activeTask: null,
    running: false,
    mode: 'stopwatch', // 'stopwatch' | 'countdown'
    plannedSeconds: 30 * 60, // default 30 min for countdown
    startedAt: null,
    pausedAt: null,
    accumulatedSeconds: 0
  };
  let timerInterval = null;

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

        if (!database.objectStoreNames.contains(STORE_SESSIONS)) {
          database.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
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
      const tx = db.transaction([STORE_DAYS, STORE_META, STORE_SESSIONS], 'readwrite');
      tx.objectStore(STORE_DAYS).clear();
      tx.objectStore(STORE_META).clear();
      tx.objectStore(STORE_SESSIONS).clear();

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ===== Session Functions =====
  function saveSession(session) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SESSIONS, 'readwrite');
      const store = tx.objectStore(STORE_SESSIONS);
      const request = store.put(session);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function getSessionsForDate(date) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SESSIONS, 'readonly');
      const store = tx.objectStore(STORE_SESSIONS);
      const request = store.getAll();

      request.onsuccess = () => {
        const sessions = request.result.filter(s => s.date === date);
        resolve(sessions.sort((a, b) => b.endedAt - a.endedAt));
      };
      request.onerror = () => reject(request.error);
    });
  }

  function getTodaySessions() {
    return getSessionsForDate(getTodayString());
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

  // Move task to different status and reorder
  async function moveTaskToSection(date, taskId, newStatus, insertAtIndex) {
    const record = await getDateRecord(date);
    const task = record.tasks.find(t => t.id === taskId);
    if (!task) return;

    const oldStatus = task.status;
    task.status = newStatus;

    // Get all tasks in target status and sort by order
    const targetTasks = record.tasks
      .filter(t => t.status === newStatus && t.id !== taskId)
      .sort((a, b) => a.order - b.order);

    // Insert at position
    targetTasks.splice(insertAtIndex, 0, task);

    // Reassign order for target status
    targetTasks.forEach((t, idx) => t.order = idx);

    // Reassign order for old status if different
    if (oldStatus !== newStatus) {
      const oldTasks = record.tasks
        .filter(t => t.status === oldStatus)
        .sort((a, b) => a.order - b.order);
      oldTasks.forEach((t, idx) => t.order = idx);
    }

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

    // Focus button (only for IN_PROGRESS tasks)
    if (task.status === 'IN_PROGRESS') {
      const focusBtn = document.createElement('button');
      focusBtn.className = 'focus-btn';
      focusBtn.textContent = '▶';
      focusBtn.title = 'Focus';
      focusBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        focusOnTask(task.id);
      });
      row.appendChild(focusBtn);
    }

    li.appendChild(row);

    // Meta row
    const meta = document.createElement('div');
    meta.className = 'task-meta';

    // Estimate dropdown
    const estimateSelect = document.createElement('select');
    estimateSelect.className = 'estimate-select';
    const estimateOptions = [
      { value: '', label: '—' },
      { value: '5', label: '5m' },
      { value: '15', label: '15m' },
      { value: '30', label: '30m' },
      { value: '60', label: '60m' }
    ];
    estimateOptions.forEach(opt => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      if ((task.estimateMinutes === null && opt.value === '') ||
        (task.estimateMinutes !== null && opt.value === String(task.estimateMinutes))) {
        option.selected = true;
      }
      estimateSelect.appendChild(option);
    });
    estimateSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      const newEstimate = val === '' ? null : parseInt(val, 10);
      updateTask(selectedDate, task.id, { estimateMinutes: newEstimate });
    });
    meta.appendChild(estimateSelect);

    // Tags removed - no longer displayed

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

  // ===== Drag and Drop (Cross-Column Support) =====
  let draggedElement = null;
  let draggedTaskId = null;

  function handleDragStart(e) {
    draggedElement = e.currentTarget;
    draggedTaskId = e.currentTarget.dataset.id;
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedTaskId);

    // Activate all drop zones
    document.querySelectorAll('.task-list').forEach(list => {
      list.classList.add('drop-zone-active');
    });
  }

  function handleDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    draggedElement = null;
    draggedTaskId = null;

    // Clear all highlights
    document.querySelectorAll('.task-card').forEach(el => {
      el.classList.remove('drag-over');
    });
    document.querySelectorAll('.task-list').forEach(list => {
      list.classList.remove('drop-zone-active', 'drop-zone-highlight');
    });
    document.querySelectorAll('.task-section').forEach(sec => {
      sec.classList.remove('drag-over-section');
    });
    document.querySelectorAll('.drop-placeholder').forEach(ph => ph.remove());
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const target = e.currentTarget;
    if (target !== draggedElement && target.classList.contains('task-card')) {
      target.classList.add('drag-over');
    }
  }

  function handleDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
  }

  // Handle drop on task card (reorder within or move across sections)
  function handleDrop(e) {
    e.preventDefault();
    const target = e.currentTarget;
    target.classList.remove('drag-over');

    if (!draggedElement || target === draggedElement) return;

    const targetList = target.closest('.task-list');
    const draggedList = draggedElement.closest('.task-list');
    const targetSection = targetList.closest('.task-section');
    const newStatus = targetSection.dataset.status;

    // Get insert position
    const cards = Array.from(targetList.querySelectorAll('.task-card:not(.dragging)'));
    const targetIndex = cards.indexOf(target);

    if (targetList === draggedList) {
      // Same section: simple reorder
      const draggedIndex = cards.indexOf(draggedElement);
      if (draggedIndex < targetIndex) {
        target.after(draggedElement);
      } else {
        target.before(draggedElement);
      }
      const newOrder = Array.from(targetList.querySelectorAll('.task-card')).map(el => el.dataset.id);
      reorderTasks(selectedDate, newOrder);
    } else {
      // Cross-section: move task
      moveTaskToSection(selectedDate, draggedTaskId, newStatus, targetIndex).then(() => {
        renderTasks();
      });
    }
  }

  // Handle drop on empty list area
  function handleListDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const list = e.currentTarget;
    list.classList.add('drop-zone-highlight');
    list.closest('.task-section').classList.add('drag-over-section');
  }

  function handleListDragLeave(e) {
    const list = e.currentTarget;
    list.classList.remove('drop-zone-highlight');
    list.closest('.task-section').classList.remove('drag-over-section');
  }

  function handleListDrop(e) {
    e.preventDefault();
    const list = e.currentTarget;
    list.classList.remove('drop-zone-highlight');
    list.closest('.task-section').classList.remove('drag-over-section');

    if (!draggedTaskId) return;

    const targetSection = list.closest('.task-section');
    const newStatus = targetSection.dataset.status;
    const cards = Array.from(list.querySelectorAll('.task-card:not(.dragging)'));

    // Insert at end
    moveTaskToSection(selectedDate, draggedTaskId, newStatus, cards.length).then(() => {
      renderTasks();
    });
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

  // ===== Screen Navigation =====
  function switchScreen(screenName) {
    currentScreen = screenName;
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.querySelectorAll('.screen-tab').forEach(t => t.classList.remove('active'));

    const screen = document.getElementById(screenName + 'Screen');
    const tab = document.querySelector(`.screen-tab[data-screen="${screenName}"]`);

    if (screen) screen.classList.remove('hidden');
    if (tab) tab.classList.add('active');

    if (screenName === 'focus') {
      initFocusScreen();
    }
  }

  // ===== Focus Screen =====
  async function initFocusScreen() {
    // Restore focus state from meta
    const savedState = await getMeta('focusState');
    if (savedState) {
      focusState = { ...focusState, ...savedState };

      // Restore active task
      if (focusState.activeTaskId) {
        const record = await getDateRecord(selectedDate);
        focusState.activeTask = record.tasks.find(t => t.id === focusState.activeTaskId);
      }

      // Restore timer if running
      if (focusState.running && focusState.startedAt) {
        startTimerTick();
      }
    }

    renderFocusUI();
    renderFocusSessions();

    // If no active task, show selection modal
    if (!focusState.activeTask) {
      openTaskSelectModal();
    }
  }

  function renderFocusUI() {
    const task = focusState.activeTask;

    // Update header
    const focusTaskName = document.getElementById('focusTaskName');
    focusTaskName.textContent = task ? task.title : 'タスク未選択';

    // Update task card
    const focusTaskTitle = document.getElementById('focusTaskTitle');
    focusTaskTitle.textContent = task ? task.title : 'タスクを選択してください';

    const focusPriorityDot = document.getElementById('focusPriorityDot');
    focusPriorityDot.className = 'priority-dot priority-' + (task ? task.priority : 2);

    const focusEstimate = document.getElementById('focusEstimate');
    focusEstimate.textContent = task && task.estimateMinutes ? task.estimateMinutes + 'm' : '—';

    const focusCarried = document.getElementById('focusCarried');
    if (task && task.carriedFrom) {
      focusCarried.textContent = '↪ ' + task.carriedFrom;
      focusCarried.classList.remove('hidden');
    } else {
      focusCarried.classList.add('hidden');
    }

    // Update timer display
    updateTimerDisplay();

    // Update mode buttons
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === focusState.mode);
    });

    // Show/hide countdown presets
    const countdownPresets = document.getElementById('countdownPresets');
    if (focusState.mode === 'countdown') {
      countdownPresets.classList.remove('hidden');
    } else {
      countdownPresets.classList.add('hidden');
    }

    // Update start button text
    const timerStart = document.getElementById('timerStart');
    if (focusState.running) {
      timerStart.textContent = '⏸ Pause';
      timerStart.classList.add('paused');
    } else {
      timerStart.textContent = '▶ Start';
      timerStart.classList.remove('paused');
    }

    // Add running class to timer display
    const timerDisplay = document.getElementById('timerDisplay');
    timerDisplay.classList.toggle('running', focusState.running);
  }

  function updateTimerDisplay() {
    const timerDisplay = document.getElementById('timerDisplay');
    let seconds;

    if (focusState.mode === 'stopwatch') {
      seconds = focusState.accumulatedSeconds;
      if (focusState.running && focusState.startedAt) {
        seconds += Math.floor((Date.now() - focusState.startedAt) / 1000);
      }
    } else {
      // Countdown
      let elapsed = focusState.accumulatedSeconds;
      if (focusState.running && focusState.startedAt) {
        elapsed += Math.floor((Date.now() - focusState.startedAt) / 1000);
      }
      seconds = Math.max(0, focusState.plannedSeconds - elapsed);

      // Color warnings
      timerDisplay.classList.remove('countdown-warning', 'countdown-danger');
      if (seconds <= 60) {
        timerDisplay.classList.add('countdown-danger');
      } else if (seconds <= 300) {
        timerDisplay.classList.add('countdown-warning');
      }
    }

    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    timerDisplay.textContent = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  }

  function startTimerTick() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      updateTimerDisplay();

      // Check countdown completion
      if (focusState.mode === 'countdown' && focusState.running) {
        let elapsed = focusState.accumulatedSeconds;
        if (focusState.startedAt) {
          elapsed += Math.floor((Date.now() - focusState.startedAt) / 1000);
        }
        if (elapsed >= focusState.plannedSeconds) {
          stopTimer(true);
        }
      }
    }, 1000);
  }

  function stopTimerTick() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function startTimer() {
    if (!focusState.activeTask) {
      openTaskSelectModal();
      return;
    }

    if (focusState.running) {
      // Pause
      const now = Date.now();
      focusState.accumulatedSeconds += Math.floor((now - focusState.startedAt) / 1000);
      focusState.startedAt = null;
      focusState.running = false;
      stopTimerTick();
    } else {
      // Start/Resume
      focusState.startedAt = Date.now();
      focusState.running = true;
      startTimerTick();
    }

    saveFocusState();
    renderFocusUI();
  }

  function resetTimer() {
    focusState.accumulatedSeconds = 0;
    focusState.startedAt = null;
    focusState.running = false;
    stopTimerTick();
    saveFocusState();
    renderFocusUI();
  }

  async function stopTimer(autoCompleted) {
    if (!focusState.activeTask) return;

    const now = Date.now();
    let duration = focusState.accumulatedSeconds;
    if (focusState.running && focusState.startedAt) {
      duration += Math.floor((now - focusState.startedAt) / 1000);
    }

    // Only save session if there's meaningful duration
    if (duration >= 5) {
      const session = {
        id: generateId(),
        date: getTodayString(),
        taskId: focusState.activeTask.id,
        taskTitle: focusState.activeTask.title,
        mode: focusState.mode,
        plannedMinutes: focusState.mode === 'countdown' ? focusState.plannedSeconds / 60 : null,
        startedAt: now - (duration * 1000),
        endedAt: now,
        durationSeconds: duration
      };
      await saveSession(session);
    }

    // Reset timer
    focusState.accumulatedSeconds = 0;
    focusState.startedAt = null;
    focusState.running = false;
    stopTimerTick();

    saveFocusState();
    renderFocusUI();
    renderFocusSessions();
  }

  function setTimerMode(mode) {
    if (focusState.running) return; // Don't change mode while running

    focusState.mode = mode;
    saveFocusState();
    renderFocusUI();
  }

  function setCountdownPreset(minutes) {
    if (focusState.running) return;

    focusState.plannedSeconds = minutes * 60;

    // Update preset buttons
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.minutes) === minutes);
    });
    document.getElementById('customMinutes').value = '';

    saveFocusState();
    renderFocusUI();
  }

  function setCustomCountdown(minutes) {
    if (focusState.running || !minutes || minutes < 1) return;

    focusState.plannedSeconds = Math.min(minutes, 180) * 60;

    // Clear preset selection
    document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));

    saveFocusState();
    renderFocusUI();
  }

  async function saveFocusState() {
    await setMeta('focusState', {
      activeTaskId: focusState.activeTaskId,
      running: focusState.running,
      mode: focusState.mode,
      plannedSeconds: focusState.plannedSeconds,
      startedAt: focusState.startedAt,
      accumulatedSeconds: focusState.accumulatedSeconds
    });
  }

  async function renderFocusSessions() {
    const sessions = await getTodaySessions();
    const totalSeconds = sessions.reduce((sum, s) => sum + s.durationSeconds, 0);

    // Update total time
    const todayFocusTime = document.getElementById('todayFocusTime');
    if (totalSeconds >= 3600) {
      const hours = Math.floor(totalSeconds / 3600);
      const mins = Math.floor((totalSeconds % 3600) / 60);
      todayFocusTime.textContent = hours + 'h ' + mins + 'm';
    } else {
      todayFocusTime.textContent = Math.floor(totalSeconds / 60) + 'm';
    }

    // Render recent sessions (max 3)
    const sessionHistory = document.getElementById('sessionHistory');
    while (sessionHistory.firstChild) {
      sessionHistory.removeChild(sessionHistory.firstChild);
    }

    sessions.slice(0, 3).forEach(session => {
      const li = document.createElement('li');
      li.className = 'session-item';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'session-item-title';
      titleSpan.textContent = session.taskTitle;

      const durationSpan = document.createElement('span');
      durationSpan.className = 'session-item-duration';
      const mins = Math.floor(session.durationSeconds / 60);
      durationSpan.textContent = mins + 'm (' + (session.mode === 'countdown' ? '区切り' : '経過') + ')';

      li.appendChild(titleSpan);
      li.appendChild(durationSpan);
      sessionHistory.appendChild(li);
    });
  }

  // ===== Task Selection Modal =====
  async function openTaskSelectModal() {
    const record = await getDateRecord(selectedDate);
    const inProgressTasks = record.tasks.filter(t => t.status === 'IN_PROGRESS');

    const taskSelectList = document.getElementById('taskSelectList');
    while (taskSelectList.firstChild) {
      taskSelectList.removeChild(taskSelectList.firstChild);
    }

    if (inProgressTasks.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';
      emptyDiv.textContent = '進行中のタスクがありません';
      taskSelectList.appendChild(emptyDiv);
    } else {
      inProgressTasks.forEach(task => {
        const li = document.createElement('li');
        li.className = 'task-select-item';
        li.dataset.id = task.id;

        const dot = document.createElement('span');
        dot.className = 'priority-dot priority-' + task.priority;

        const title = document.createElement('span');
        title.className = 'task-title';
        title.textContent = task.title;

        li.appendChild(dot);
        li.appendChild(title);
        li.addEventListener('click', () => selectFocusTask(task));
        taskSelectList.appendChild(li);
      });
    }

    document.getElementById('taskSelectModal').classList.remove('hidden');
  }

  function closeTaskSelectModal() {
    document.getElementById('taskSelectModal').classList.add('hidden');
  }

  async function selectFocusTask(task) {
    // If timer is running, confirm
    if (focusState.running) {
      await stopTimer(false);
    }

    focusState.activeTaskId = task.id;
    focusState.activeTask = task;
    focusState.accumulatedSeconds = 0;
    focusState.startedAt = null;
    focusState.running = false;

    saveFocusState();
    closeTaskSelectModal();
    renderFocusUI();
  }

  async function completeActiveTask() {
    if (!focusState.activeTask) return;

    // Stop timer and save session
    if (focusState.running || focusState.accumulatedSeconds > 0) {
      await stopTimer(false);
    }

    // Mark task as done
    await updateTask(selectedDate, focusState.activeTask.id, { status: 'DONE' });

    // Clear focus state
    focusState.activeTaskId = null;
    focusState.activeTask = null;
    focusState.accumulatedSeconds = 0;
    focusState.startedAt = null;
    focusState.running = false;

    saveFocusState();
    renderFocusUI();

    // Show task selection
    openTaskSelectModal();
  }

  // ===== Focus from Tasks Screen =====
  function focusOnTask(taskId) {
    getDateRecord(selectedDate).then(record => {
      const task = record.tasks.find(t => t.id === taskId);
      if (task) {
        selectFocusTask(task);
        switchScreen('focus');
      }
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

        // Refresh focus screen if active
        if (currentScreen === 'focus') {
          renderFocusUI();
          renderFocusSessions();
        }
      });
    }
  }

  // ===== Demo Data (Minimal: 1 per status) =====
  async function insertDemoData() {
    const record = await getDateRecord(selectedDate);
    // Don't insert if user already has any tasks
    if (record.tasks.length > 0) return;

    const demoTasks = [
      { title: '提案資料の最終チェック', priority: 3, estimateMinutes: 30, tags: ['client', 'docs'], status: 'IN_PROGRESS' },
      { title: 'メール送付（請求書）', priority: 2, estimateMinutes: 15, tags: ['mail', 'finance'], status: 'WAITING' },
      { title: '朝のストレッチ', priority: 1, estimateMinutes: 5, tags: ['health'], status: 'DONE' }
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
        carriedFrom: null,
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

    // Event listeners - List drop zones (for empty area drops)
    [elements.listInProgress, elements.listWaiting, elements.listDone].forEach(list => {
      list.addEventListener('dragover', handleListDragOver);
      list.addEventListener('dragleave', handleListDragLeave);
      list.addEventListener('drop', handleListDrop);
    });

    // Event listeners - Screen Navigation
    document.querySelectorAll('.screen-tab').forEach(tab => {
      tab.addEventListener('click', () => switchScreen(tab.dataset.screen));
    });

    // Event listeners - Focus Screen
    document.getElementById('timerStart').addEventListener('click', startTimer);
    document.getElementById('timerReset').addEventListener('click', resetTimer);
    document.getElementById('timerStop').addEventListener('click', () => stopTimer(false));
    document.getElementById('changeTaskBtn').addEventListener('click', openTaskSelectModal);
    document.getElementById('completeTaskBtn').addEventListener('click', completeActiveTask);

    // Timer mode
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => setTimerMode(btn.dataset.mode));
    });

    // Countdown presets
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => setCountdownPreset(parseInt(btn.dataset.minutes)));
    });
    document.getElementById('customMinutes').addEventListener('change', (e) => {
      setCustomCountdown(parseInt(e.target.value));
    });

    // Task selection modal
    document.getElementById('taskSelectClose').addEventListener('click', closeTaskSelectModal);
    document.getElementById('taskSelectModal').addEventListener('click', (e) => {
      if (e.target.id === 'taskSelectModal') closeTaskSelectModal();
    });

    // Focus settings button
    document.getElementById('focusSettingsBtn').addEventListener('click', openSettingsModal);

    // Visibility change listener
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  // Start app
  init().catch(console.error);
})();
