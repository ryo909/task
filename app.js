/**
 * SideDock ToDo - Static / Local-Only Task Manager
 * No external network requests, all data stored in IndexedDB
 */

(function() {
  'use strict';

  // ===== Constants =====
  const DB_NAME = 'SideDockToDo';
  const DB_VERSION = 1;
  const STORE_DAYS = 'days';
  const STORE_META = 'meta';
  const ARCHIVE_DAYS = 7;
  
  const ESTIMATE_VALUES = [null, 5, 15, 30, 60];
  const PRIORITY_VALUES = [1, 2, 3];

  // ===== State =====
  let db = null;
  let currentTab = 'today';
  let selectedArchiveDate = null;
  let todayDate = getTodayString();

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
    // Fallback for older browsers
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
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
    // Snap to nearest valid value
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
    
    // Remove tags and estimate from title
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
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(formatDate(d));
    }
    return dates;
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

  // ===== Data Operations =====
  async function getTodayRecord() {
    let record = await getDayRecord(todayDate);
    if (!record) {
      record = { date: todayDate, tasks: [], updatedAt: Date.now() };
    }
    return record;
  }

  async function addTask(title, tags, estimate) {
    const record = await getTodayRecord();
    const maxOrder = record.tasks.reduce((max, t) => Math.max(max, t.order), -1);
    
    const task = {
      id: generateId(),
      title,
      done: false,
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

  async function updateTask(taskId, updates) {
    const record = await getTodayRecord();
    const task = record.tasks.find(t => t.id === taskId);
    if (task) {
      Object.assign(task, updates);
      await saveDayRecord(record);
    }
    return task;
  }

  async function deleteTask(taskId) {
    const record = await getTodayRecord();
    record.tasks = record.tasks.filter(t => t.id !== taskId);
    await saveDayRecord(record);
  }

  async function reorderTasks(taskIds) {
    const record = await getTodayRecord();
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
      // Date has changed, perform rollover
      await performRollover(lastOpened, today);
    }
    
    await setMeta('lastOpenedDate', today);
    todayDate = today;
  }

  async function performRollover(fromDate, toDate) {
    // Get yesterday's record
    const yesterdayRecord = await getDayRecord(fromDate);
    if (!yesterdayRecord) return;
    
    // Get incomplete tasks
    const incompleteTasks = yesterdayRecord.tasks.filter(t => !t.done);
    if (incompleteTasks.length === 0) return;
    
    // Get or create today's record
    let todayRecord = await getDayRecord(toDate);
    if (!todayRecord) {
      todayRecord = { date: toDate, tasks: [], updatedAt: Date.now() };
    }
    
    const maxOrder = todayRecord.tasks.reduce((max, t) => Math.max(max, t.order), -1);
    
    // Copy incomplete tasks to today
    incompleteTasks.forEach((task, index) => {
      const newTask = {
        id: generateId(),
        title: task.title,
        done: false,
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
    const recentDates = new Set(getRecentDates(ARCHIVE_DAYS));
    const allRecords = await getAllDayRecords();
    
    for (const record of allRecords) {
      if (!recentDates.has(record.date)) {
        await deleteDayRecord(record.date);
      }
    }
  }

  async function restoreIncompleteTasks(fromDate) {
    const archiveRecord = await getDayRecord(fromDate);
    if (!archiveRecord) return;
    
    const incompleteTasks = archiveRecord.tasks.filter(t => !t.done);
    if (incompleteTasks.length === 0) return;
    
    const todayRecord = await getTodayRecord();
    const maxOrder = todayRecord.tasks.reduce((max, t) => Math.max(max, t.order), -1);
    
    incompleteTasks.forEach((task, index) => {
      const newTask = {
        id: generateId(),
        title: task.title,
        done: false,
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
    await renderTodayView();
  }

  // ===== Export/Import =====
  async function exportData() {
    const days = await getAllDayRecords();
    const lastOpenedDate = await getMeta('lastOpenedDate');
    
    const data = {
      version: 1,
      exportedAt: Date.now(),
      days,
      meta: { lastOpenedDate }
    };
    
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `sidedock-todo-${todayDate}.json`;
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
          
          // Clear existing data
          await clearAllData();
          
          // Import days
          for (const day of data.days) {
            await saveDayRecord(day);
          }
          
          // Import meta
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
  function createTaskElement(task, isArchive = false) {
    const li = document.createElement('li');
    li.className = 'task-card' + (task.done ? ' done' : '');
    li.dataset.id = task.id;
    
    if (!isArchive) {
      li.draggable = true;
    }
    
    // Top row
    const row = document.createElement('div');
    row.className = 'task-row';
    
    // Priority dot
    const priorityDot = document.createElement('span');
    priorityDot.className = `priority-dot priority-${task.priority}`;
    priorityDot.title = `優先度: ${['低', '中', '高'][task.priority - 1]}`;
    if (!isArchive) {
      priorityDot.addEventListener('click', () => cyclePriority(task.id));
    }
    row.appendChild(priorityDot);
    
    // Checkbox
    const checkbox = document.createElement('span');
    checkbox.className = 'task-checkbox' + (task.done ? ' checked' : '');
    if (!isArchive) {
      checkbox.addEventListener('click', () => toggleDone(task.id));
    }
    row.appendChild(checkbox);
    
    // Title
    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;
    if (!isArchive) {
      title.addEventListener('dblclick', () => startEditing(task.id, title));
    }
    row.appendChild(title);
    
    // Time badge
    const timeBadge = document.createElement('span');
    timeBadge.className = 'time-badge';
    timeBadge.textContent = formatTime(task.createdAt);
    row.appendChild(timeBadge);
    
    // Delete button
    if (!isArchive) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-btn';
      deleteBtn.textContent = '×';
      deleteBtn.title = '削除';
      deleteBtn.addEventListener('click', () => handleDelete(task.id));
      row.appendChild(deleteBtn);
    }
    
    li.appendChild(row);
    
    // Meta row
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    
    // Estimate chip
    const estimateChip = document.createElement('span');
    estimateChip.className = 'chip estimate';
    estimateChip.textContent = formatEstimate(task.estimateMinutes);
    if (!isArchive) {
      estimateChip.addEventListener('click', () => cycleEstimate(task.id));
    }
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
    if (!isArchive) {
      li.addEventListener('dragstart', handleDragStart);
      li.addEventListener('dragend', handleDragEnd);
      li.addEventListener('dragover', handleDragOver);
      li.addEventListener('drop', handleDrop);
      li.addEventListener('dragleave', handleDragLeave);
    }
    
    return li;
  }

  async function renderTodayView() {
    const record = await getTodayRecord();
    const tasks = [...record.tasks].sort((a, b) => a.order - b.order);
    
    elements.taskList.innerHTML = '';
    
    if (tasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<div class="empty-state-icon">📝</div><p>タスクがありません</p>';
      elements.taskList.appendChild(empty);
    } else {
      tasks.forEach(task => {
        elements.taskList.appendChild(createTaskElement(task));
      });
    }
    
    updateSummary(tasks);
  }

  async function renderArchiveView() {
    const recentDates = getRecentDates(ARCHIVE_DAYS);
    
    // Render date chips
    elements.dateChips.innerHTML = '';
    for (const date of recentDates) {
      if (date === todayDate) continue; // Skip today
      
      const chip = document.createElement('button');
      chip.className = 'date-chip' + (date === selectedArchiveDate ? ' active' : '');
      chip.textContent = date;
      chip.addEventListener('click', () => selectArchiveDate(date));
      elements.dateChips.appendChild(chip);
    }
    
    // Render tasks for selected date
    elements.archiveTaskList.innerHTML = '';
    
    if (!selectedArchiveDate) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<div class="empty-state-icon">📅</div><p>日付を選択してください</p>';
      elements.archiveTaskList.appendChild(empty);
      return;
    }
    
    const record = await getDayRecord(selectedArchiveDate);
    if (!record || record.tasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<div class="empty-state-icon">📭</div><p>この日のタスクはありません</p>';
      elements.archiveTaskList.appendChild(empty);
      return;
    }
    
    const tasks = [...record.tasks].sort((a, b) => a.order - b.order);
    tasks.forEach(task => {
      elements.archiveTaskList.appendChild(createTaskElement(task, true));
    });
  }

  function updateSummary(tasks) {
    const incomplete = tasks.filter(t => !t.done);
    const incompleteCount = incomplete.length;
    
    const remainingMinutes = incomplete.reduce((sum, t) => sum + (t.estimateMinutes || 0), 0);
    const totalMinutes = tasks.reduce((sum, t) => sum + (t.estimateMinutes || 0), 0);
    
    elements.incompleteCount.textContent = `${incompleteCount}件`;
    elements.remainingTime.textContent = remainingMinutes > 0 ? `${remainingMinutes}m` : '—';
    elements.totalTime.textContent = totalMinutes > 0 ? `${totalMinutes}m` : '—';
  }

  function selectArchiveDate(date) {
    selectedArchiveDate = date;
    renderArchiveView();
  }

  // ===== Event Handlers =====
  function handleAddTask() {
    const input = elements.taskInput.value.trim();
    if (!input) return;
    
    const { title, tags, estimate } = parseInput(input);
    addTask(title, tags, estimate).then(() => {
      elements.taskInput.value = '';
      renderTodayView();
    });
  }

  async function toggleDone(taskId) {
    const record = await getTodayRecord();
    const task = record.tasks.find(t => t.id === taskId);
    if (task) {
      await updateTask(taskId, { done: !task.done });
      renderTodayView();
    }
  }

  async function cyclePriority(taskId) {
    const record = await getTodayRecord();
    const task = record.tasks.find(t => t.id === taskId);
    if (task) {
      const nextPriority = (task.priority % 3) + 1;
      await updateTask(taskId, { priority: nextPriority });
      renderTodayView();
    }
  }

  async function cycleEstimate(taskId) {
    const record = await getTodayRecord();
    const task = record.tasks.find(t => t.id === taskId);
    if (task) {
      const currentIndex = ESTIMATE_VALUES.indexOf(task.estimateMinutes);
      const nextIndex = (currentIndex + 1) % ESTIMATE_VALUES.length;
      await updateTask(taskId, { estimateMinutes: ESTIMATE_VALUES[nextIndex] });
      renderTodayView();
    }
  }

  async function handleDelete(taskId) {
    await deleteTask(taskId);
    renderTodayView();
  }

  function startEditing(taskId, titleElement) {
    const currentText = titleElement.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-title-input';
    input.value = currentText;
    
    const finishEditing = async (save) => {
      if (save && input.value.trim()) {
        await updateTask(taskId, { title: input.value.trim() });
      }
      renderTodayView();
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
    
    const taskList = elements.taskList;
    const cards = Array.from(taskList.querySelectorAll('.task-card'));
    const draggedIndex = cards.indexOf(draggedElement);
    const targetIndex = cards.indexOf(target);
    
    if (draggedIndex < targetIndex) {
      target.after(draggedElement);
    } else {
      target.before(draggedElement);
    }
    
    // Save new order
    const newOrder = Array.from(taskList.querySelectorAll('.task-card')).map(el => el.dataset.id);
    reorderTasks(newOrder);
  }

  // ===== Tab Switching =====
  function switchTab(tab) {
    currentTab = tab;
    
    elements.tabs.forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    
    elements.todayView.classList.toggle('hidden', tab !== 'today');
    elements.archiveView.classList.toggle('hidden', tab !== 'archive');
    
    if (tab === 'today') {
      renderTodayView();
    } else {
      renderArchiveView();
    }
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
        renderTodayView();
        renderArchiveView();
      });
    });
  }

  // ===== Visibility Change Handler =====
  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      const newToday = getTodayString();
      if (newToday !== todayDate) {
        checkAndPerformRollover().then(() => {
          purgeOldRecords();
          if (currentTab === 'today') {
            renderTodayView();
          } else {
            renderArchiveView();
          }
        });
      }
    }
  }

  // ===== Demo Data (for development) =====
  async function insertDemoData() {
    const record = await getTodayRecord();
    if (record.tasks.length > 0) return; // Don't insert if data exists
    
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDate(yesterday);
    
    const demoTasks = [
      { title: '提案資料の最終チェック', priority: 3, estimateMinutes: 30, tags: ['client', 'docs'], done: false },
      { title: 'Slack返信まとめ', priority: 2, estimateMinutes: 15, tags: ['comms'], done: false },
      { title: '朝のストレッチ', priority: 1, estimateMinutes: 5, tags: ['health'], done: true },
      { title: 'メール送付（請求書）', priority: 2, estimateMinutes: 15, tags: ['mail', 'finance'], done: false, carriedFrom: yesterdayStr },
      { title: 'MTGアジェンダ作成', priority: 3, estimateMinutes: 30, tags: ['meeting'], done: false },
      { title: '読書メモ整理', priority: 1, estimateMinutes: null, tags: ['reading'], done: false }
    ];
    
    demoTasks.forEach((task, index) => {
      const now = Date.now();
      record.tasks.push({
        id: generateId(),
        title: task.title,
        done: task.done,
        priority: task.priority,
        estimateMinutes: task.estimateMinutes,
        tags: task.tags,
        createdAt: now - (index * 60000), // Stagger times
        carriedFrom: task.carriedFrom || null,
        order: index
      });
    });
    
    await saveDayRecord(record);
  }

  // ===== Initialization =====
  async function init() {
    // Cache DOM elements
    elements.currentDate = document.getElementById('currentDate');
    elements.tabs = document.querySelectorAll('.tab');
    elements.todayView = document.getElementById('todayView');
    elements.archiveView = document.getElementById('archiveView');
    elements.taskInput = document.getElementById('taskInput');
    elements.addBtn = document.getElementById('addBtn');
    elements.taskList = document.getElementById('taskList');
    elements.incompleteCount = document.getElementById('incompleteCount');
    elements.remainingTime = document.getElementById('remainingTime');
    elements.totalTime = document.getElementById('totalTime');
    elements.dateChips = document.getElementById('dateChips');
    elements.archiveTaskList = document.getElementById('archiveTaskList');
    elements.restoreBtn = document.getElementById('restoreBtn');
    elements.exportBtn = document.getElementById('exportBtn');
    elements.importBtn = document.getElementById('importBtn');
    elements.importFile = document.getElementById('importFile');
    elements.panicBtn = document.getElementById('panicBtn');
    
    // Set current date
    elements.currentDate.textContent = todayDate;
    
    // Open database
    await openDatabase();
    
    // Check rollover
    await checkAndPerformRollover();
    
    // Purge old records
    await purgeOldRecords();
    
    // Insert demo data if empty (for development)
    // Comment out this line in production
    await insertDemoData();
    
    // Render initial view
    await renderTodayView();
    
    // Event listeners
    elements.addBtn.addEventListener('click', handleAddTask);
    elements.taskInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAddTask();
    });
    
    elements.tabs.forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
    
    elements.restoreBtn.addEventListener('click', async () => {
      if (selectedArchiveDate) {
        await restoreIncompleteTasks(selectedArchiveDate);
        switchTab('today');
      }
    });
    
    elements.exportBtn.addEventListener('click', exportData);
    
    elements.importBtn.addEventListener('click', () => {
      elements.importFile.click();
    });
    
    elements.importFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        try {
          await importData(file);
          renderTodayView();
          elements.importFile.value = '';
        } catch (error) {
          console.error('Import error:', error);
        }
      }
    });
    
    elements.panicBtn.addEventListener('click', handlePanic);
    
    // Visibility change listener
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  // Start app
  init().catch(console.error);
})();
