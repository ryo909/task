/**
 * SideDock ToDo v2 - Static / Local-Only Task Manager
 * Status-based workflow: IN_PROGRESS → WAITING → DONE
 */

(function () {
  'use strict';

  // ===== Constants =====
  const DB_NAME = 'SideDockToDo';
  const DB_VERSION = 5; // v5: Add dailyReports, settings stores + new task fields
  const STORE_DAYS = 'days';
  const STORE_META = 'meta';
  const STORE_SESSIONS = 'sessions';
  const STORE_NOTES = 'notes';
  const STORE_LOGS = 'logs';
  const STORE_PET = 'petState';
  const STORE_DAILY_REPORTS = 'dailyReports';
  const STORE_SETTINGS = 'settings';
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

  // Reminder state
  let reminderState = {
    nextTimeout: null,
    pendingReminder: null, // current task being reminded
    originalTitle: document.title,
    titleBlinkInterval: null
  };

  // Settings state
  let appSettings = {
    createdDateFormat: 'md_ampm', // 'md_ampm' | 'md' | 'md_hhmm'
    soundEnabled: false,
    soundVolume: 0.5,
    audioUnlocked: false,
    soundPattern: 'doubleBeep',
    rewardEnabled: true,
    rewardAnimationEnabled: true
  };

  // ===== Audio Context for WebAudio Beep =====
  let audioContext = null;

  function initAudioContext() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContext;
  }

  function playBeep(ctx, freq, startTime, duration, volume) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.value = freq;
    osc.type = 'sine';

    // Envelope: attack 0.005s, decay 0.04s, release 0.03s
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.005);
    gain.gain.linearRampToValueAtTime(volume * 0.7, startTime + 0.045);
    gain.gain.linearRampToValueAtTime(0, startTime + duration);

    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  async function playDoubleBeep(volume = 0.5) {
    try {
      const ctx = initAudioContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const now = ctx.currentTime;

      // First beep: 880Hz, 0.12s
      playBeep(ctx, 880, now, 0.12, volume);
      // Second beep: 988Hz, 0.12s after 0.08s gap (0.12 + 0.08 = 0.20)
      playBeep(ctx, 988, now + 0.20, 0.12, volume);

      return true;
    } catch (e) {
      console.warn('playDoubleBeep failed:', e);
      return false;
    }
  }

  async function testAndUnlockAudio() {
    const success = await playDoubleBeep(appSettings.soundVolume);
    if (success) {
      appSettings.audioUnlocked = true;
      await saveSettings();
      showToast('通知音が有効になりました');
      updateAudioStatusUI();
    }
    return success;
  }

  function updateAudioStatusUI() {
    const statusEl = document.getElementById('audioStatus');
    if (statusEl) {
      if (appSettings.audioUnlocked) {
        statusEl.textContent = '✓ Audio ready';
        statusEl.classList.add('audio-ready');
      } else {
        statusEl.textContent = '※初回はテスト再生が必要です';
        statusEl.classList.remove('audio-ready');
      }
    }
  }

  // ===== Completion Reward Animation =====
  function triggerCompletionReward(taskId) {
    if (!appSettings.rewardEnabled || !appSettings.rewardAnimationEnabled) return;

    requestAnimationFrame(() => {
      const card = document.querySelector(`.task-card[data-id="${taskId}"]`);
      if (card) {
        card.classList.add('reward-pop');
        const onAnimEnd = () => {
          card.classList.remove('reward-pop');
          card.removeEventListener('animationend', onAnimEnd);
        };
        card.addEventListener('animationend', onAnimEnd);
        // Fallback timeout
        setTimeout(() => card.classList.remove('reward-pop'), 300);
      }
    });
  }

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

        // v4: Add notes, logs, petState stores
        if (!database.objectStoreNames.contains(STORE_NOTES)) {
          database.createObjectStore(STORE_NOTES, { keyPath: 'id' });
        }

        if (!database.objectStoreNames.contains(STORE_LOGS)) {
          const logsStore = database.createObjectStore(STORE_LOGS, { keyPath: 'id' });
          logsStore.createIndex('dateKey', 'dateKey', { unique: false });
        }

        if (!database.objectStoreNames.contains(STORE_PET)) {
          database.createObjectStore(STORE_PET, { keyPath: 'id' });
        }

        // v5: Add dailyReports, settings stores
        if (!database.objectStoreNames.contains(STORE_DAILY_REPORTS)) {
          database.createObjectStore(STORE_DAILY_REPORTS, { keyPath: 'dateKey' });
        }

        if (!database.objectStoreNames.contains(STORE_SETTINGS)) {
          database.createObjectStore(STORE_SETTINGS);
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
      const tx = db.transaction([STORE_DAYS, STORE_META, STORE_SESSIONS, STORE_NOTES, STORE_LOGS, STORE_PET], 'readwrite');
      tx.objectStore(STORE_DAYS).clear();
      tx.objectStore(STORE_META).clear();
      tx.objectStore(STORE_SESSIONS).clear();
      tx.objectStore(STORE_NOTES).clear();
      tx.objectStore(STORE_LOGS).clear();
      tx.objectStore(STORE_PET).clear();

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

  // ===== Notes Functions =====
  function getAllNotes() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NOTES, 'readonly');
      const store = tx.objectStore(STORE_NOTES);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  function saveNote(note) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NOTES, 'readwrite');
      const store = tx.objectStore(STORE_NOTES);
      note.updatedAt = Date.now();
      const request = store.put(note);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function deleteNote(noteId) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NOTES, 'readwrite');
      const store = tx.objectStore(STORE_NOTES);
      const request = store.delete(noteId);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ===== Logs Functions =====
  function saveLogEntry(entry) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_LOGS, 'readwrite');
      const store = tx.objectStore(STORE_LOGS);
      const request = store.put(entry);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function getLogsForDate(dateKey) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_LOGS, 'readonly');
      const store = tx.objectStore(STORE_LOGS);
      const index = store.index('dateKey');
      const request = index.getAll(dateKey);

      request.onsuccess = () => {
        const logs = request.result || [];
        resolve(logs.sort((a, b) => b.doneAt - a.doneAt));
      };
      request.onerror = () => reject(request.error);
    });
  }

  function deleteLogEntry(logId) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_LOGS, 'readwrite');
      const store = tx.objectStore(STORE_LOGS);
      const request = store.delete(logId);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function getLogsByTaskId(taskId) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_LOGS, 'readonly');
      const store = tx.objectStore(STORE_LOGS);
      const request = store.getAll();

      request.onsuccess = () => {
        const logs = (request.result || []).filter(l => l.taskId === taskId);
        resolve(logs.sort((a, b) => b.doneAt - a.doneAt));
      };
      request.onerror = () => reject(request.error);
    });
  }

  // ===== Pet State Functions =====
  function getPetState() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PET, 'readonly');
      const store = tx.objectStore(STORE_PET);
      const request = store.get('pet');

      request.onsuccess = () => {
        if (request.result) {
          resolve(request.result);
        } else {
          // Return default pet state
          resolve({
            id: 'pet',
            name: 'ねこまんじゅう',
            level: 1,
            xp: 0,
            treats: 0,
            mood: 'normal',
            lastInteractionAt: null,
            lastRewardAt: null,
            skin: 'default'
          });
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  function savePetState(petState) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PET, 'readwrite');
      const store = tx.objectStore(STORE_PET);
      petState.id = 'pet';
      const request = store.put(petState);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ===== Settings Functions =====
  async function loadSettings() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readonly');
      const store = tx.objectStore(STORE_SETTINGS);
      const request = store.get('appSettings');

      request.onsuccess = () => {
        if (request.result) {
          appSettings = { ...appSettings, ...request.result };
        }
        resolve(appSettings);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function saveSettings() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readwrite');
      const store = tx.objectStore(STORE_SETTINGS);
      const request = store.put(appSettings, 'appSettings');

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ===== Daily Report Functions =====
  function getDailyReport(dateKey) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DAILY_REPORTS, 'readonly');
      const store = tx.objectStore(STORE_DAILY_REPORTS);
      const request = store.get(dateKey);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function saveDailyReport(report) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DAILY_REPORTS, 'readwrite');
      const store = tx.objectStore(STORE_DAILY_REPORTS);
      report.updatedAt = Date.now();
      const request = store.put(report);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ===== Helper: Get local dateKey =====
  function getLocalDateKey(timestamp = Date.now()) {
    const date = new Date(timestamp);
    return formatDate(date);
  }

  // ===== Reminder Scheduler =====
  async function scheduleNextReminder() {
    // Clear existing timeout
    if (reminderState.nextTimeout) {
      clearTimeout(reminderState.nextTimeout);
      reminderState.nextTimeout = null;
    }

    const now = Date.now();
    const allRecords = await getAllDayRecords();
    let nextReminder = null;
    let nextTask = null;
    let nextTaskDate = null;

    for (const record of allRecords) {
      for (const task of record.tasks) {
        if (task.status === 'DONE') continue;

        // Check remindAt or snoozed time
        let remindTime = task.remindAt;
        if (task.remindSnoozedUntil && task.remindSnoozedUntil > now) {
          remindTime = task.remindSnoozedUntil;
        }

        if (remindTime && remindTime > now) {
          if (!nextReminder || remindTime < nextReminder) {
            nextReminder = remindTime;
            nextTask = task;
            nextTaskDate = record.date;
          }
        } else if (remindTime && remindTime <= now) {
          // Trigger immediately
          triggerReminder(task, record.date);
          return;
        }
      }
    }

    if (nextReminder && nextTask) {
      const delay = nextReminder - now;
      reminderState.nextTimeout = setTimeout(() => {
        triggerReminder(nextTask, nextTaskDate);
      }, Math.min(delay, 2147483647)); // Max setTimeout value
    }
  }

  function triggerReminder(task, taskDate) {
    reminderState.pendingReminder = { task, taskDate };

    // Show in-app banner
    showReminderBanner(task, taskDate);

    // Start title blink
    startTitleBlink(task.title);

    // Try Web Notification
    tryWebNotification(task);

    // Play sound if enabled and unlocked
    if (appSettings.soundEnabled && appSettings.audioUnlocked) {
      playDoubleBeep(appSettings.soundVolume);
    }
  }

  function showReminderBanner(task, taskDate) {
    const banner = document.getElementById('reminderBanner');
    const text = document.getElementById('reminderText');
    if (!banner || !text) return;

    text.textContent = `🔔 ${task.title}`;
    banner.classList.remove('hidden');

    // Add audio unlock button if sound enabled but not unlocked
    const existingUnlockBtn = banner.querySelector('.reminder-unlock-audio');
    if (existingUnlockBtn) existingUnlockBtn.remove();

    if (appSettings.soundEnabled && !appSettings.audioUnlocked) {
      const unlockBtn = document.createElement('button');
      unlockBtn.className = 'reminder-btn reminder-unlock-audio';
      unlockBtn.textContent = '🔊 音を有効化';
      unlockBtn.addEventListener('click', async () => {
        await testAndUnlockAudio();
        unlockBtn.remove();
      });
      const actions = banner.querySelector('.reminder-actions');
      if (actions) actions.insertBefore(unlockBtn, actions.firstChild);
    }
  }

  function hideReminderBanner() {
    const banner = document.getElementById('reminderBanner');
    if (banner) banner.classList.add('hidden');
    stopTitleBlink();
    reminderState.pendingReminder = null;
  }

  function startTitleBlink(taskTitle) {
    stopTitleBlink();
    reminderState.originalTitle = document.title;
    let showOriginal = false;
    reminderState.titleBlinkInterval = setInterval(() => {
      document.title = showOriginal ? reminderState.originalTitle : `🔔 ${taskTitle}`;
      showOriginal = !showOriginal;
    }, 1000);
  }

  function stopTitleBlink() {
    if (reminderState.titleBlinkInterval) {
      clearInterval(reminderState.titleBlinkInterval);
      reminderState.titleBlinkInterval = null;
      document.title = reminderState.originalTitle;
    }
  }

  async function tryWebNotification(task) {
    if (!('Notification' in window)) return;

    if (Notification.permission === 'granted') {
      new Notification('SideDock ToDo', {
        body: task.title,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🔔</text></svg>'
      });
    } else if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        new Notification('SideDock ToDo', {
          body: task.title
        });
      }
    }
  }

  async function handleReminderAction(action) {
    if (!reminderState.pendingReminder) return;

    const { task, taskDate } = reminderState.pendingReminder;

    switch (action) {
      case 'open':
        hideReminderBanner();
        selectDate(taskDate);
        openTaskDetail(task.id, taskDate);
        break;
      case 'done':
        await updateTask(taskDate, task.id, { status: 'DONE', remindAt: null });
        await createDoneLog(task, taskDate);
        hideReminderBanner();
        renderTasks();
        break;
      case 'snooze5':
        await updateTask(taskDate, task.id, { remindSnoozedUntil: Date.now() + 5 * 60 * 1000 });
        hideReminderBanner();
        scheduleNextReminder();
        break;
      case 'snooze10':
        await updateTask(taskDate, task.id, { remindSnoozedUntil: Date.now() + 10 * 60 * 1000 });
        hideReminderBanner();
        scheduleNextReminder();
        break;
      case 'close':
        hideReminderBanner();
        // Clear remind for this task
        await updateTask(taskDate, task.id, { remindAt: null });
        scheduleNextReminder();
        break;
    }
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

        // v4: Add extended fields if missing
        if (!('dueDate' in task) && !('dueAt' in task)) {
          task.dueAt = null;
          needsSave = true;
        }
        if (!('note' in task)) {
          task.note = '';
          needsSave = true;
        }
        if (!('subtasks' in task)) {
          task.subtasks = [];
          needsSave = true;
        }
        if (!('updatedAt' in task)) {
          task.updatedAt = task.createdAt || Date.now();
          needsSave = true;
        }

        // v5: Migrate dueDate (YYYY-MM-DD) to dueAt (epoch ms at 18:00)
        if ('dueDate' in task && task.dueDate && !('dueAt' in task)) {
          const [y, m, d] = task.dueDate.split('-').map(Number);
          const dueDateTime = new Date(y, m - 1, d, 18, 0, 0);
          task.dueAt = dueDateTime.getTime();
          delete task.dueDate;
          needsSave = true;
        } else if ('dueDate' in task && !task.dueDate && !('dueAt' in task)) {
          task.dueAt = null;
          delete task.dueDate;
          needsSave = true;
        }

        // v5: Add new fields
        if (!('remindAt' in task)) {
          task.remindAt = null;
          needsSave = true;
        }
        if (!('remindSnoozedUntil' in task)) {
          task.remindSnoozedUntil = null;
          needsSave = true;
        }
        if (!('pinnedAt' in task)) {
          task.pinnedAt = null;
          needsSave = true;
        }
        if (!('createdAt' in task)) {
          task.createdAt = Date.now();
          needsSave = true;
        }
      }

      if (needsSave) {
        await saveDayRecord(record);
      }
    }

    // Load settings
    await loadSettings();
  }

  // ===== Data Operations =====
  async function getDateRecord(date) {
    let record = await getDayRecord(date);
    if (!record) {
      record = { date: date, tasks: [], updatedAt: Date.now() };
    }
    return record;
  }

  async function addTask(title, tags, estimate, date, dueAt = null) {
    const record = await getDateRecord(date);
    const maxOrder = record.tasks.reduce((max, t) => Math.max(max, t.order), -1);
    const now = Date.now();

    const task = {
      id: generateId(),
      title,
      status: 'IN_PROGRESS',
      priority: 1,
      estimateMinutes: estimate,
      tags,
      createdAt: now,
      carriedFrom: null,
      order: maxOrder + 1,
      // v5 extended fields
      dueAt: dueAt,
      note: '',
      subtasks: [],
      updatedAt: now,
      remindAt: null,
      remindSnoozedUntil: null,
      pinnedAt: null
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

  // Reorder tasks within a list
  async function reorderTasks(date, newOrderIds) {
    console.log('[Debug] reorderTasks', date, newOrderIds);
    const record = await getDateRecord(date);
    if (!record) return;

    const orderMap = {};
    newOrderIds.forEach((id, index) => {
      orderMap[id] = index;
    });

    record.tasks.forEach(t => {
      if (orderMap[t.id] !== undefined) {
        t.order = orderMap[t.id];
      }
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
    if (task.pinnedAt) li.classList.add('pinned');
    li.dataset.id = task.id;
    // Not directly draggable - use handle
    li.draggable = false;

    // Drag handle (left side)
    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.textContent = '≡';
    dragHandle.draggable = true;
    dragHandle.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', task.id);
      li.classList.add('dragging');
      handleDragStart(e, li, task.id);
    });
    dragHandle.addEventListener('dragend', (e) => {
      li.classList.remove('dragging');
      handleDragEnd(e);
    });
    li.appendChild(dragHandle);

    // Top row
    const row = document.createElement('div');
    row.className = 'task-row';

    // Status icon
    const statusIcon = document.createElement('span');
    statusIcon.className = `status-icon ${task.status}`;
    statusIcon.title = STATUS_LABELS[task.status];
    statusIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      cycleStatus(task.id);
    });
    row.appendChild(statusIcon);

    // Pin button
    const pinBtn = document.createElement('button');
    pinBtn.className = 'pin-btn' + (task.pinnedAt ? ' pinned' : '');
    pinBtn.textContent = '📌';
    pinBtn.title = task.pinnedAt ? 'ピン解除' : 'ピン留め';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(task.id);
    });
    row.appendChild(pinBtn);

    // Priority dot
    const priorityDot = document.createElement('span');
    priorityDot.className = `priority-dot priority-${task.priority}`;
    priorityDot.title = `優先度: ${['低', '中', '高'][task.priority - 1]}`;
    priorityDot.addEventListener('click', (e) => {
      e.stopPropagation();
      cyclePriority(task.id);
    });
    row.appendChild(priorityDot);

    // Title
    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startEditing(task.id, title);
    });
    row.appendChild(title);

    // Due badge (clickable for editing)
    if (task.dueAt) {
      row.appendChild(createDueBadge(task));
    }

    // Remind indicator
    if (task.remindAt) {
      const remindBadge = document.createElement('span');
      remindBadge.className = 'remind-badge';
      remindBadge.textContent = '🔔';
      remindBadge.title = `リマインド: ${formatDateTime(task.remindAt)}`;
      row.appendChild(remindBadge);
    }

    // Edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.textContent = '✎';
    editBtn.title = '詳細編集';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTaskDetail(task.id);
    });
    row.appendChild(editBtn);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.title = '削除';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDelete(task.id);
    });
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

    // Created date (new style)
    meta.appendChild(createCreatedBadge(task));

    // Estimate dropdown
    const estimateSelect = document.createElement('select');
    estimateSelect.className = 'estimate-select';
    estimateSelect.addEventListener('click', (e) => e.stopPropagation());
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

    // Carried from chip
    if (task.carriedFrom) {
      const carriedChip = document.createElement('span');
      carriedChip.className = 'chip carried';
      carriedChip.textContent = `↪ ${task.carriedFrom}`;
      meta.appendChild(carriedChip);
    }

    li.appendChild(meta);

    // Card dblclick opens detail - CHANGED
    li.addEventListener('dblclick', (e) => {
      const tag = e.target.tagName.toLowerCase();
      if (tag === 'button' || tag === 'select' || tag === 'input' ||
        e.target.classList.contains('drag-handle') ||
        e.target.classList.contains('status-icon') ||
        e.target.classList.contains('priority-dot') ||
        e.target.classList.contains('pin-btn') ||
        e.target.closest('.badge-due')) {
        return;
      }
      openTaskDetail(task.id);
    });

    // Enable dragging on the card itself - CHANGED
    li.draggable = true;
    li.addEventListener('dragstart', (e) => handleDragStart(e, li, task.id));

    // Drag events for card (as drop target)
    li.addEventListener('dragover', handleDragOver);
    li.addEventListener('drop', handleDrop);
    li.addEventListener('dragleave', handleDragLeave);

    return li;
  }

  // RE-INSERTED renderTasks
  async function renderTasks() {
    const record = await getDateRecord(selectedDate);
    const tasks = record.tasks || [];
    console.log('[Debug] renderTasks State:', tasks.map(t => ({ t: t.title, s: t.status, p: t.pinnedAt, o: t.order })));

    // Separate tasks by status
    const tasksInProgress = tasks.filter(t => t.status === 'IN_PROGRESS');
    const tasksWaiting = tasks.filter(t => t.status === 'WAITING');
    const tasksDone = tasks.filter(t => t.status === 'DONE');

    // Sorting function: Pinned first, then by Order
    const sortTasks = (a, b) => {
      // 1. Pinned checks
      if (a.pinnedAt && !b.pinnedAt) return -1;
      if (!a.pinnedAt && b.pinnedAt) return 1;

      // 2. If both pinned, newest pinned first
      if (a.pinnedAt && b.pinnedAt) {
        return b.pinnedAt - a.pinnedAt;
      }

      // 3. Normal order
      return (a.order || 0) - (b.order || 0);
    };

    tasksInProgress.sort(sortTasks);
    tasksWaiting.sort(sortTasks);
    tasksDone.sort(sortTasks);

    // Render lists
    renderTaskList(elements.listInProgress, tasksInProgress);
    renderTaskList(elements.listWaiting, tasksWaiting);
    renderTaskList(elements.listDone, tasksDone);

    // Update headers
    if (elements.countInProgress) elements.countInProgress.textContent = tasksInProgress.length;
    if (elements.countWaiting) elements.countWaiting.textContent = tasksWaiting.length;
    if (elements.countDone) elements.countDone.textContent = tasksDone.length;

    updateHeaderDate();
    scheduleNextReminder();
  }

  function renderTaskList(container, tasks) {
    while (container.firstChild) container.removeChild(container.firstChild);
    tasks.forEach(task => {
      container.appendChild(createTaskElement(task));
    });
  }

  // Fix formatDueAt signature
  function formatDueAt(dueAt) {
    if (!dueAt) return null;
    const dueDate = new Date(dueAt);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    const dueDay = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());

    const timeStr = formatTime(dueAt);

    if (dueDay.getTime() < today.getTime()) {
      return { text: `期限切れ ${timeStr}`, class: 'overdue' };
    } else if (dueDay.getTime() === today.getTime()) {
      return { text: `今日 ${timeStr}`, class: 'today' };
    } else if (dueDay.getTime() === tomorrow.getTime()) {
      return { text: `明日 ${timeStr}`, class: 'tomorrow' };
    } else {
      const m = dueDate.getMonth() + 1;
      const d = dueDate.getDate();
      return { text: `${m}/${d} ${timeStr}`, class: '' };
    }
  }

  // Create due badge element
  function createDueBadge(task) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-due clickable';

    const icon = document.createElement('span');
    icon.className = 'badge-icon';
    icon.textContent = '⏰';
    badge.appendChild(icon);

    const dueInfo = formatDueAt(task.dueAt);
    const text = document.createElement('span');
    if (dueInfo) {
      text.textContent = dueInfo.text;
      if (dueInfo.class) badge.classList.add(dueInfo.class);
    } else {
      text.textContent = '期限なし';
    }
    badge.appendChild(text);

    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      openDuePopover(task, badge);
    });
    return badge;
  }

  function createCreatedBadge(task) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-created';

    const icon = document.createElement('span');
    icon.className = 'badge-icon';
    icon.textContent = '🌱';
    badge.appendChild(icon);

    const createdInfo = formatCreatedDate(task.createdAt);
    const text = document.createElement('span');
    text.textContent = createdInfo.text;
    badge.appendChild(text);

    if (createdInfo.staleClass) {
      badge.classList.add(createdInfo.staleClass);
    }
    return badge;
  }

  // Format datetime for display
  function formatDateTime(timestamp) {
    const date = new Date(timestamp);
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${m}/${d} ${h}:${min}`;
  }

  // Format created date based on settings
  function formatCreatedDate(createdAt) {
    if (!createdAt) return { text: '', staleClass: null };
    const date = new Date(createdAt);
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const h = date.getHours();

    let dateText = '';
    if (appSettings.createdDateFormat === 'md_ampm') {
      const ampm = h < 12 ? '午前' : '午後';
      dateText = `${m}/${d} ${ampm}`;
    } else if (appSettings.createdDateFormat === 'md') {
      dateText = `${m}/${d}`;
    } else if (appSettings.createdDateFormat === 'md_hhmm') {
      const hStr = String(h).padStart(2, '0');
      const minStr = String(date.getMinutes()).padStart(2, '0');
      dateText = `${m}/${d} ${hStr}:${minStr}`;
    } else {
      const ampm = h < 12 ? '午前' : '午後';
      dateText = `${m}/${d} ${ampm}`;
    }

    // Calculate days ago
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const createdStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const daysAgo = Math.floor((todayStart - createdStart) / (24 * 60 * 60 * 1000));

    if (daysAgo > 0) {
      dateText += ` (${daysAgo}d)`;
    }

    let staleClass = null;
    if (daysAgo >= 7) {
      staleClass = 'stale-7d';
    } else if (daysAgo >= 3) {
      staleClass = 'stale-3d';
    }

    return { text: dateText, staleClass };
  }



  function updateHeaderDate() {
    if (!elements.headerDate) return;
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
      const oldStatus = task.status;
      const currentIndex = STATUS_VALUES.indexOf(task.status);
      const nextIndex = (currentIndex + 1) % STATUS_VALUES.length;
      const newStatus = STATUS_VALUES[nextIndex];

      await updateTask(selectedDate, taskId, { status: newStatus, updatedAt: Date.now() });

      // Log handling
      if (newStatus === 'DONE' && oldStatus !== 'DONE') {
        await createDoneLog(task, selectedDate);
      } else if (oldStatus === 'DONE' && newStatus !== 'DONE') {
        await revertDoneLog(taskId);
      }

      await renderTasks();

      // Trigger completion animation if becoming DONE
      if (newStatus === 'DONE' && oldStatus !== 'DONE') {
        triggerCompletionReward(taskId);
      }
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

  // Pin/Unpin task (max 3 pinned)
  async function togglePin(taskId) {
    const record = await getDateRecord(selectedDate);
    const task = record.tasks.find(t => t.id === taskId);
    if (!task) return;

    if (task.pinnedAt) {
      // Unpin
      await updateTask(selectedDate, taskId, { pinnedAt: null });
      showToast('ピンを解除しました');
    } else {
      // Check max pinned count (across all dates)
      const allRecords = await getAllDayRecords();
      let pinnedCount = 0;
      for (const rec of allRecords) {
        pinnedCount += rec.tasks.filter(t => t.pinnedAt && t.id !== taskId).length;
      }

      if (pinnedCount >= 3) {
        showToast('Pinnedは最大3件です。どれか解除してください');
        return;
      }

      await updateTask(selectedDate, taskId, { pinnedAt: Date.now() });
      showToast('ピン留めしました');
    }
    renderTasks();
  }

  // Open due date/time popover
  let activeDuePopover = null;

  function openDuePopover(task, anchorElement) {
    // Close existing popover
    if (activeDuePopover) {
      activeDuePopover.remove();
      activeDuePopover = null;
    }

    const popover = document.createElement('div');
    popover.className = 'due-popover';

    // Date input
    const dateLabel = document.createElement('label');
    dateLabel.textContent = '日付';
    dateLabel.className = 'popover-label';
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'popover-date-input';
    if (task.dueAt) {
      const d = new Date(task.dueAt);
      dateInput.value = formatDate(d);
    }

    // Time select
    const timeLabel = document.createElement('label');
    timeLabel.textContent = '時刻';
    timeLabel.className = 'popover-label';
    const timeSelect = document.createElement('select');
    timeSelect.className = 'popover-time-select';

    // Generate 15-min intervals
    const timeOptions = [{ value: '', label: '(時刻なし)' }];
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 15) {
        const hStr = String(h).padStart(2, '0');
        const mStr = String(m).padStart(2, '0');
        timeOptions.push({ value: `${hStr}:${mStr}`, label: `${hStr}:${mStr}` });
      }
    }

    let currentTimeValue = '';
    if (task.dueAt) {
      const d = new Date(task.dueAt);
      currentTimeValue = formatTime(task.dueAt);
    }

    timeOptions.forEach(opt => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.value === currentTimeValue) option.selected = true;
      timeSelect.appendChild(option);
    });

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.className = 'popover-buttons';

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'クリア';
    clearBtn.className = 'btn btn-secondary btn-sm';
    clearBtn.addEventListener('click', () => {
      updateTask(selectedDate, task.id, { dueAt: null }).then(() => {
        popover.remove();
        activeDuePopover = null;
        renderTasks();
      });
    });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存';
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.addEventListener('click', () => {
      const dateVal = dateInput.value;
      const timeVal = timeSelect.value;

      let dueAt = null;
      if (dateVal) {
        const [y, mo, d] = dateVal.split('-').map(Number);
        if (timeVal) {
          const [h, m] = timeVal.split(':').map(Number);
          dueAt = new Date(y, mo - 1, d, h, m).getTime();
        } else {
          dueAt = new Date(y, mo - 1, d, 18, 0).getTime(); // Default 18:00
        }
      }

      updateTask(selectedDate, task.id, { dueAt }).then(() => {
        popover.remove();
        activeDuePopover = null;
        renderTasks();
      });
    });

    btnRow.appendChild(clearBtn);
    btnRow.appendChild(saveBtn);

    popover.appendChild(dateLabel);
    popover.appendChild(dateInput);
    popover.appendChild(timeLabel);
    popover.appendChild(timeSelect);
    popover.appendChild(btnRow);

    // Position popover
    document.body.appendChild(popover);
    const anchorRect = anchorElement.getBoundingClientRect();
    popover.style.position = 'fixed';
    popover.style.top = (anchorRect.bottom + 4) + 'px';
    popover.style.left = anchorRect.left + 'px';

    // Adjust if off screen
    const popoverRect = popover.getBoundingClientRect();
    if (popoverRect.right > window.innerWidth) {
      popover.style.left = (window.innerWidth - popoverRect.width - 10) + 'px';
    }

    activeDuePopover = popover;

    // Close on outside click
    const closeHandler = (e) => {
      if (!popover.contains(e.target) && e.target !== anchorElement) {
        popover.remove();
        activeDuePopover = null;
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 10);
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

  // ===== Drag and Drop (Cross-Column Support with Handle) =====
  let draggedElement = null;
  let draggedTaskId = null;

  function handleDragStart(e, cardElement, taskId) {
    draggedElement = cardElement;
    draggedTaskId = taskId;

    // Activate all drop zones
    document.querySelectorAll('.task-list').forEach(list => {
      list.classList.add('drop-zone-active');
    });

    // Create drag image if needed (optional)
    e.dataTransfer.effectAllowed = 'move';
    // Firefox requires data set
    e.dataTransfer.setData('text/plain', taskId);

    // Minor delay to add dragging class for visual effect
    setTimeout(() => {
      if (draggedElement) draggedElement.classList.add('dragging');
    }, 0);
  }

  function handleDragEnd(e) {
    if (draggedElement) {
      draggedElement.classList.remove('dragging');
    }
    draggedElement = null;
    draggedTaskId = null;

    // Clear all highlights and placeholders
    document.querySelectorAll('.task-list').forEach(list => {
      list.classList.remove('drop-zone-active', 'drop-zone-highlight');
    });
    document.querySelectorAll('.task-section').forEach(sec => {
      sec.classList.remove('drag-over-section');
    });
    document.querySelectorAll('.drop-placeholder').forEach(ph => ph.remove());
  }

  // Handle Drag Over (Container level)
  function handleListDragOver(e) {
    e.preventDefault();
    if (!draggedElement) return;

    const list = e.currentTarget;
    const afterElement = getDragAfterElement(list, e.clientY);

    // Add visual cues
    list.classList.add('drop-zone-highlight');
    list.closest('.task-section').classList.add('drag-over-section');

    // Create or move placeholder
    let placeholder = list.querySelector('.drop-placeholder');
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.className = 'drop-placeholder';
      // Match height of dragged element roughly
      placeholder.style.height = draggedElement.offsetHeight + 'px';
    }

    if (afterElement == null) {
      list.appendChild(placeholder);
    } else {
      list.insertBefore(placeholder, afterElement);
    }
  }

  // Helper to determine insertion point
  function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.task-card:not(.dragging)')];

    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;

      // We want the element that is immediately AFTER the cursor (offset is negative but closest to 0)
      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      } else {
        return closest;
      }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  function handleListDragLeave(e) {
    // Only remove if leaving the list entirely (not entering a child)
    // Checking relatedTarget helps distinguish leaving to child vs leaving container
    if (!e.currentTarget.contains(e.relatedTarget)) {
      e.currentTarget.classList.remove('drop-zone-highlight');
      e.currentTarget.closest('.task-section').classList.remove('drag-over-section');

      const placeholder = e.currentTarget.querySelector('.drop-placeholder');
      if (placeholder) placeholder.remove();
    }
  }

  async function handleListDrop(e) {
    e.preventDefault();
    const list = e.currentTarget;
    list.classList.remove('drop-zone-highlight');
    list.closest('.task-section').classList.remove('drag-over-section');

    const placeholder = list.querySelector('.drop-placeholder');
    const placeholderIndex = placeholder ? [...list.children].indexOf(placeholder) : -1;

    // Cleanup placeholder
    if (placeholder) placeholder.remove();

    if (!draggedTaskId || !draggedElement) return;

    const targetSection = list.closest('.task-section');
    const newStatus = targetSection.dataset.status;
    const isDoneDrop = newStatus === 'DONE';

    // Calculate new index
    // Note: getDragAfterElement logic puts placeholder BEFORE the element.
    // So the index is correct for insertion.
    // However, if we are in the SAME list and moving down, the index might need adjustment
    // because the dragged element is removed from earlier position.

    // Get current cards to check relative position
    const cards = [...list.querySelectorAll('.task-card:not(.dragging)')];

    // If placeholderIndex was -1 (append), targetIndex is length
    // Adjust placeholderIndex because the placeholder itself takes up an index during calculation
    // But since we removed it, we can use the logic 'insert at this index'

    // Because 'cards' excludes the dragging element, valid indices are 0 to cards.length.
    // If placeholder was at end, placeholderIndex (in children list) might be largest.
    // Simple approach:
    // If same list: Reorder array based on where placeholder was.
    // If placeholder was before Card A, we insert before Card A.

    const draggedList = draggedElement.closest('.task-list');
    const isSameList = (list === draggedList);

    if (isSameList) {
      // DOM move
      if (placeholderIndex >= 0) {
        // Re-insert dragged element at proper position
        // We need to find the element that WAS at placeholderIndex (ignoring placeholder)
        // But since we removed placeholder, we can just use :nth-child or similar?
        // Safer: insert before the element that was after placeholder

        const children = [...list.children]; // now placeholder is gone, dragged is still there (hidden?) or here
        // Actually draggedElement is still in DOM at old spot until we move it.

        // Let's use the 'cards' array which excludes dragged element to map indices.
        // If placeholder was at index P among children (incl placeholder, excl dragged if display:none?)
        // Actually dragged element has class .dragging.

        // Simpler logic:
        // The `getDragAfterElement` returns the element to insert BEFORE.
        // Let's re-run that logic or rely on where placeholder was?
        // Relying on placeholder position is best visually.

        // We need to know which element the placeholder was before.
        // But we removed it.

        // Alternative: Move dragged element to placeholder position BEFORE removing placeholder.
        if (placeholder) { // Wait, removed above.
          // Refactor: don't remove placeholder yet?
        }
      }
    }
    // ... wait, the previous implementation was cleaner with moveTaskToSection
    // Let's stick to using moveTaskToSection logic but using the calculated index.

    // Correct lifecycle:
    // 1. Determine index from placeholder
    // 2. Remove placeholder
    // 3. Call reorder/move API

    // Limitation: I already removed placeholder above. Let's fix that in next steps or just re-calculate
    // But actually, `placeholderIndex` captured the index among children (including unrelated items?).
    // The children include task-cards and the placeholder.

    // Let's refine the drop handler below to be fully robust.

    // RE-IMPLEMENTATION of logic inside this block for safety:
  }

  // Clean up obsolete individual card handlers
  // (We now handle everything at the list level)


  // Main Drop Handler
  async function handleListDrop(e) {
    e.preventDefault();
    const list = e.currentTarget;
    const targetSection = list.closest('.task-section');

    // Cleanup visual cues
    list.classList.remove('drop-zone-highlight');
    targetSection.classList.remove('drag-over-section');

    const placeholder = list.querySelector('.drop-placeholder');

    if (!draggedTaskId || !draggedElement) {
      if (placeholder) placeholder.remove();
      return;
    }

    // Determine target index
    let targetIndex = 0;
    if (placeholder) {
      // Get all task cards in this list (excluding the one being dragged, and placeholder)
      // Actually we want to know where the placeholder is relative to other cards.
      // The DOM is: [Card1, Card2, Placeholder, Card3...] (Dragged is elsewhere or hidden)
      const siblings = [...list.children].filter(c => c !== placeholder && c !== draggedElement && c.classList.contains('task-card'));
      const placeholderIndex = [...list.children].indexOf(placeholder);

      // Count how many 'valid' cards are before the placeholder
      // We iterate children until we hit placeholder
      let count = 0;
      for (const child of list.children) {
        if (child === placeholder) break;
        if (child !== draggedElement && child.classList.contains('task-card')) {
          count++;
        }
      }
      targetIndex = count;

      placeholder.remove();
    } else {
      // Append if no placeholder (shouldn't happen with correct dragover, but fallback)
      targetIndex = list.querySelectorAll('.task-card:not(.dragging)').length;
    }

    const newStatus = targetSection.dataset.status;
    const draggedList = draggedElement.closest('.task-list');
    const isSameList = (list === draggedList);
    const savedTaskId = draggedTaskId;
    const isDoneDrop = newStatus === 'DONE';

    if (isSameList) {
      // Calculate adjustment if moving down
      // The index is based on the list WITHOUT the dragged element.
      // So 'moveTaskToSection' should handle "insert at index X" treating X as the index in the destination array (which is same as source).
      // However, our backend helper moveTaskToSection might be simpler if we just reorder locally then save order.

      // Let's use the robust moveTaskToSection, assuming it handles "remove then insert".
      // If I move item 0 to index 2:
      // Logic: remove 0 -> array shrinks -> insert at 2.
      // Our calculation of targetIndex above is "how many non-dragged cards are before placeholder".
      // This is exactly the index we want to insert at (shifted).
      await moveTaskToSection(selectedDate, draggedTaskId, newStatus, targetIndex);
      await renderTasks();
    } else {
      // Cross-column
      await moveTaskToSection(selectedDate, draggedTaskId, newStatus, targetIndex);
      await renderTasks();
      if (isDoneDrop) {
        triggerCompletionReward(savedTaskId);
      }
    }
  }

  // Obsolete handlers (replaced by list-level handlers)
  function handleDragOver(e) { e.preventDefault(); }
  function handleDragLeave(e) { }
  function handleDrop(e) { }



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

  // ===== Task Detail Modal =====
  async function openTaskDetail(taskId, date = selectedDate) {
    console.log('[Debug] openTaskDetail', taskId, date);
    const record = await getDateRecord(date);
    const task = record.tasks.find(t => t.id === taskId);
    if (!task) return;

    // Populate Modal
    const modal = elements.taskDetailModal;
    modal.dataset.taskId = taskId;
    modal.dataset.date = date;

    document.getElementById('taskDetailTitle').value = task.title;
    document.getElementById('taskDetailNote').value = task.note || '';

    // Due Date/Time
    const dDate = document.getElementById('detailDueDate');
    const dTime = document.getElementById('detailDueTime');
    if (dDate && dTime) {
      if (task.dueAt) {
        const d = new Date(task.dueAt);
        dDate.value = formatDate(d);
        dTime.value = formatTime(d) || '';
      } else {
        dDate.value = '';
        dTime.value = '';
      }
    }

    // Remind Date/Time
    const rDate = document.getElementById('detailRemindDate');
    const rTime = document.getElementById('detailRemindTime');
    if (rDate && rTime) {
      if (task.remindAt) {
        const r = new Date(task.remindAt);
        rDate.value = formatDate(r);
        rTime.value = formatTime(r) || '';
      } else {
        rDate.value = '';
        rTime.value = '';
      }
    }

    renderSubtasks(task.subtasks || []);

    modal.classList.remove('hidden');
  }

  function closeTaskDetail() {
    elements.taskDetailModal.classList.add('hidden');
  }

  async function saveTaskDetail() {
    const modal = elements.taskDetailModal;
    const taskId = modal.dataset.taskId;
    const date = modal.dataset.date;

    const title = document.getElementById('taskDetailTitle').value.trim();
    if (!title) return;

    const note = document.getElementById('taskDetailNote').value;

    const update = { title, note, updatedAt: Date.now() };

    // Handle Due
    const dDateVal = document.getElementById('detailDueDate').value;
    const dTimeVal = document.getElementById('detailDueTime').value;
    if (dDateVal) {
      const [y, m, d] = dDateVal.split('-').map(Number);
      if (dTimeVal) {
        const [h, min] = dTimeVal.split(':').map(Number);
        update.dueAt = new Date(y, m - 1, d, h, min).getTime();
      } else {
        update.dueAt = new Date(y, m - 1, d, 18, 0).getTime();
      }
    } else {
      update.dueAt = null;
    }

    // Handle Remind
    const rDateVal = document.getElementById('detailRemindDate').value;
    const rTimeVal = document.getElementById('detailRemindTime').value;
    if (rDateVal && rTimeVal) {
      const [y, m, d] = rDateVal.split('-').map(Number);
      const [h, min] = rTimeVal.split(':').map(Number);
      update.remindAt = new Date(y, m - 1, d, h, min).getTime();
    } else {
      update.remindAt = null;
    }

    const subs = [];
    document.querySelectorAll('#subtaskList li').forEach(li => {
      const text = li.querySelector('span').textContent;
      const done = li.classList.contains('done');
      subs.push({ text, done });
    });
    update.subtasks = subs;

    await updateTask(date, taskId, update);
    renderTasks();
    if (currentScreen === 'calendar') {
      await buildDueDateCache();
      renderCalendar();
    }
    closeTaskDetail();
  }

  async function deleteTaskFromDetail() {
    if (!confirm('削除しますか？')) return;
    const modal = elements.taskDetailModal;
    const taskId = modal.dataset.taskId;
    const date = modal.dataset.date;

    await deleteTask(date, taskId);
    renderTasks();
    if (currentScreen === 'calendar') {
      await buildDueDateCache();
      renderCalendar();
    }
    closeTaskDetail();
  }

  function renderSubtasks(subtasks) {
    const list = document.getElementById('subtaskList');
    list.innerHTML = '';
    subtasks.forEach(sub => {
      const li = document.createElement('li');
      if (sub.done) li.classList.add('done');

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = sub.done;
      check.addEventListener('change', () => {
        li.classList.toggle('done', check.checked);
      });

      const span = document.createElement('span');
      span.textContent = sub.text;

      const del = document.createElement('button');
      del.textContent = '×';
      del.addEventListener('click', () => li.remove());

      li.appendChild(check);
      li.appendChild(span);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  function addSubtask() {
    const input = document.getElementById('subtaskInput');
    const val = input.value.trim();
    if (!val) return;

    const list = document.getElementById('subtaskList');
    const li = document.createElement('li');

    const check = document.createElement('input');
    check.type = 'checkbox';

    const span = document.createElement('span');
    span.textContent = val;

    const del = document.createElement('button');
    del.textContent = '×';
    del.addEventListener('click', () => li.remove());

    li.appendChild(check);
    li.appendChild(span);
    li.appendChild(del);
    list.appendChild(li);

    input.value = '';
    input.focus();
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

    // Initialize screens
    if (screenName === 'timer') {
      initFocusScreen();
    } else if (screenName === 'calendar') {
      initCalendarScreen();
    } else if (screenName === 'notes') {
      initNotesScreen();
    } else if (screenName === 'count') {
      initCountScreen();
    } else if (screenName === 'logs') {
      initLogsScreen();
    } else if (screenName === 'break') {
      initBreakScreen();
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

    // No longer auto-open task select modal - allow task-less timer
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
    // Allow timer to start even without a task selected

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
        taskId: focusState.activeTask ? focusState.activeTask.id : null,
        taskTitle: focusState.activeTask ? focusState.activeTask.title : '(タスクなし)',
        linkedTaskId: focusState.activeTask ? focusState.activeTask.id : null,
        linkedTaskTitleSnapshot: focusState.activeTask ? focusState.activeTask.title : null,
        mode: focusState.mode,
        plannedMinutes: focusState.mode === 'countdown' ? focusState.plannedSeconds / 60 : null,
        startedAt: now - (duration * 1000),
        endedAt: now,
        durationSeconds: duration
      };
      await saveSession(session);

      // Award pet rewards (even without task)
      const durationMinutes = Math.floor(duration / 60);
      if (durationMinutes > 0) {
        await awardFocusReward(durationMinutes);
      }
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
        switchScreen('timer');
      }
    });
  }

  // Unlink task from focus (keep timer running)
  function unlinkActiveTask() {
    focusState.activeTaskId = null;
    focusState.activeTask = null;
    saveFocusState();
    renderFocusUI();
    showToast('タスクを解除しました');
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

  // ===== Task Detail Modal =====
  let detailTaskId = null;
  let detailTaskDate = null;
  let detailSubtasks = [];

  function openTaskDetail(taskId, date = selectedDate) {
    detailTaskId = taskId;
    detailTaskDate = date;

    getDateRecord(date).then(record => {
      const task = record.tasks.find(t => t.id === taskId);
      if (!task) return;

      document.getElementById('detailTitle').value = task.title;

      // Due date and time
      if (task.dueAt) {
        const dueDate = new Date(task.dueAt);
        document.getElementById('detailDueDate').value = formatDate(dueDate);
        document.getElementById('detailDueTime').value = formatTime(task.dueAt);
      } else {
        document.getElementById('detailDueDate').value = '';
        document.getElementById('detailDueTime').value = '';
      }

      // Remind date and time
      if (task.remindAt) {
        const remindDate = new Date(task.remindAt);
        document.getElementById('detailRemindDate').value = formatDate(remindDate);
        document.getElementById('detailRemindTime').value = formatTime(task.remindAt);
      } else {
        document.getElementById('detailRemindDate').value = '';
        document.getElementById('detailRemindTime').value = '';
      }

      document.getElementById('detailEstimate').value = task.estimateMinutes || '';
      document.getElementById('detailNote').value = task.note || '';
      detailSubtasks = [...(task.subtasks || [])];
      renderSubtaskList();

      document.getElementById('taskDetailModal').classList.remove('hidden');
      document.getElementById('detailTitle').focus();
    });
  }

  function closeTaskDetail() {
    document.getElementById('taskDetailModal').classList.add('hidden');
    detailTaskId = null;
    detailTaskDate = null;
    detailSubtasks = [];
  }

  function renderSubtaskList() {
    const list = document.getElementById('subtaskList');
    while (list.firstChild) list.removeChild(list.firstChild);

    detailSubtasks.sort((a, b) => a.order - b.order).forEach(st => {
      const li = document.createElement('li');
      li.className = 'subtask-item' + (st.done ? ' done' : '');
      li.dataset.id = st.id;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'subtask-checkbox';
      checkbox.checked = st.done;
      checkbox.addEventListener('change', () => {
        st.done = checkbox.checked;
        li.classList.toggle('done', st.done);
      });

      const text = document.createElement('span');
      text.className = 'subtask-text';
      text.textContent = st.text;

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'subtask-delete';
      deleteBtn.textContent = '×';
      deleteBtn.addEventListener('click', () => {
        detailSubtasks = detailSubtasks.filter(s => s.id !== st.id);
        renderSubtaskList();
      });

      li.appendChild(checkbox);
      li.appendChild(text);
      li.appendChild(deleteBtn);
      list.appendChild(li);
    });
  }

  function addSubtask() {
    const input = document.getElementById('subtaskInput');
    const text = input.value.trim();
    if (!text) return;

    const maxOrder = detailSubtasks.reduce((max, s) => Math.max(max, s.order), -1);
    detailSubtasks.push({
      id: generateId(),
      text,
      done: false,
      order: maxOrder + 1
    });
    input.value = '';
    renderSubtaskList();
  }

  async function saveTaskDetail() {
    if (!detailTaskId) return;

    // Build dueAt from date and time
    let dueAt = null;
    const dueDateVal = document.getElementById('detailDueDate').value;
    const dueTimeVal = document.getElementById('detailDueTime').value;
    if (dueDateVal) {
      const [y, m, d] = dueDateVal.split('-').map(Number);
      if (dueTimeVal) {
        const [h, min] = dueTimeVal.split(':').map(Number);
        dueAt = new Date(y, m - 1, d, h, min).getTime();
      } else {
        dueAt = new Date(y, m - 1, d, 18, 0).getTime(); // Default 18:00
      }
    }

    // Build remindAt from date and time
    let remindAt = null;
    const remindDateVal = document.getElementById('detailRemindDate').value;
    const remindTimeVal = document.getElementById('detailRemindTime').value;
    if (remindDateVal) {
      const [y, m, d] = remindDateVal.split('-').map(Number);
      if (remindTimeVal) {
        const [h, min] = remindTimeVal.split(':').map(Number);
        remindAt = new Date(y, m - 1, d, h, min).getTime();
      } else {
        remindAt = new Date(y, m - 1, d, 9, 0).getTime(); // Default 9:00
      }
    }

    const updates = {
      title: document.getElementById('detailTitle').value.trim() || '（無題）',
      dueAt: dueAt,
      remindAt: remindAt,
      remindSnoozedUntil: null, // Reset snooze on manual edit
      estimateMinutes: document.getElementById('detailEstimate').value ? parseInt(document.getElementById('detailEstimate').value) : null,
      note: document.getElementById('detailNote').value,
      subtasks: detailSubtasks,
      updatedAt: Date.now()
    };

    await updateTask(detailTaskDate, detailTaskId, updates);
    closeTaskDetail();
    renderTasks();
  }

  async function deleteTaskFromDetail() {
    if (!detailTaskId) return;
    await deleteTask(detailTaskDate, detailTaskId);
    closeTaskDetail();
    renderTasks();
  }

  // ===== Toast Notifications =====
  let undoAction = null;

  function showToast(message, canUndo = false) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';

    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-message';
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    if (canUndo && undoAction) {
      const undoBtn = document.createElement('button');
      undoBtn.className = 'toast-undo';
      undoBtn.textContent = '元に戻す';
      undoBtn.addEventListener('click', async () => {
        if (undoAction) {
          await undoAction();
          undoAction = null;
          toast.remove();
          renderTasks();
          if (currentScreen === 'calendar') renderCalendar();
        }
      });
      toast.appendChild(undoBtn);
    }

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ===== Search =====
  function openSearchModal() {
    document.getElementById('searchModal').classList.remove('hidden');
    document.getElementById('searchInput').value = '';
    document.getElementById('searchInput').focus();
    clearSearchResults();
  }

  function closeSearchModal() {
    document.getElementById('searchModal').classList.add('hidden');
    clearSearchResults();
  }

  function clearSearchResults() {
    const list = document.getElementById('searchResults');
    while (list.firstChild) list.removeChild(list.firstChild);
  }

  async function performSearch(query) {
    if (!query || query.length < 2) {
      clearSearchResults();
      return;
    }

    const queryLower = query.toLowerCase();
    const allRecords = await getAllDayRecords();
    const results = [];

    for (const record of allRecords) {
      for (const task of record.tasks) {
        let matchType = null;
        if (task.title.toLowerCase().includes(queryLower)) {
          matchType = 'タイトル';
        } else if (task.note && task.note.toLowerCase().includes(queryLower)) {
          matchType = 'メモ';
        } else if (task.subtasks && task.subtasks.some(s => s.text.toLowerCase().includes(queryLower))) {
          matchType = 'サブタスク';
        }

        if (matchType) {
          results.push({
            date: record.date,
            taskId: task.id,
            title: task.title,
            matchType
          });
        }
      }
    }

    // Sort by date (newest first)
    results.sort((a, b) => b.date.localeCompare(a.date));

    renderSearchResults(results);
  }

  function renderSearchResults(results) {
    const list = document.getElementById('searchResults');
    while (list.firstChild) list.removeChild(list.firstChild);

    if (results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '結果が見つかりませんでした';
      list.appendChild(empty);
      return;
    }

    results.slice(0, 20).forEach(r => {
      const li = document.createElement('li');
      li.className = 'search-result-item';
      li.addEventListener('click', () => {
        closeSearchModal();
        selectDate(r.date);
        setTimeout(() => openTaskDetail(r.taskId, r.date), 100);
      });

      const dateSpan = document.createElement('span');
      dateSpan.className = 'search-result-date';
      dateSpan.textContent = r.date;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'search-result-title';
      titleSpan.textContent = r.title;

      const matchSpan = document.createElement('span');
      matchSpan.className = 'search-result-match';
      matchSpan.textContent = r.matchType;

      li.appendChild(dateSpan);
      li.appendChild(titleSpan);
      li.appendChild(matchSpan);
      list.appendChild(li);
    });
  }

  // ===== Calendar =====
  let calendarYear = new Date().getFullYear();
  let calendarMonth = new Date().getMonth();
  let dueDateCache = {};
  let calendarSelectedDate = null;
  let draggedCalendarTask = null;

  async function initCalendarScreen() {
    await buildDueDateCache();
    renderCalendar();
  }

  async function buildDueDateCache() {
    dueDateCache = {};
    const allRecords = await getAllDayRecords();
    for (const record of allRecords) {
      for (const task of record.tasks) {
        if (task.dueAt && task.status !== 'DONE') {
          // Convert dueAt epoch to date string
          const dueDate = new Date(task.dueAt);
          const dueDateKey = formatDate(dueDate);
          if (!dueDateCache[dueDateKey]) {
            dueDateCache[dueDateKey] = [];
          }
          dueDateCache[dueDateKey].push({ ...task, sourceDate: record.date });
        }
      }
    }
  }

  function renderCalendar() {
    const title = document.getElementById('calendarTitle');
    title.textContent = `${calendarYear}年${calendarMonth + 1}月`;

    const daysContainer = document.getElementById('calendarDays');
    while (daysContainer.firstChild) daysContainer.removeChild(daysContainer.firstChild);

    const firstDay = new Date(calendarYear, calendarMonth, 1);
    const lastDay = new Date(calendarYear, calendarMonth + 1, 0);
    // Monday start: getDay() returns 0=Sun, so convert to Mon=0
    const startDayOfWeek = (firstDay.getDay() + 6) % 7;
    const today = getTodayString();

    // Previous month fill
    const prevMonthEnd = new Date(calendarYear, calendarMonth, 0);
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
      const day = prevMonthEnd.getDate() - i;
      const dateKey = formatDate(new Date(calendarYear, calendarMonth - 1, day));
      createCalendarDay(daysContainer, day, dateKey, true, today);
    }

    // Current month
    for (let day = 1; day <= lastDay.getDate(); day++) {
      const dateKey = formatDate(new Date(calendarYear, calendarMonth, day));
      createCalendarDay(daysContainer, day, dateKey, false, today);
    }

    // Next month fill
    const remaining = 42 - daysContainer.children.length;
    for (let day = 1; day <= remaining; day++) {
      const dateKey = formatDate(new Date(calendarYear, calendarMonth + 1, day));
      createCalendarDay(daysContainer, day, dateKey, true, today);
    }
  }

  function createCalendarDay(container, dayNum, dateKey, otherMonth, today) {
    const div = document.createElement('div');
    div.className = 'calendar-day';
    div.dataset.dateKey = dateKey;
    if (otherMonth) div.classList.add('other-month');
    if (dateKey === today) div.classList.add('today');

    const numSpan = document.createElement('span');
    numSpan.className = 'calendar-day-num';
    numSpan.textContent = dayNum;
    div.appendChild(numSpan);

    const dueTasks = dueDateCache[dateKey] || [];
    if (dueTasks.length > 0) {
      div.classList.add('has-due');

      // Calculate total estimate
      const totalEstimate = dueTasks.reduce((sum, t) => sum + (t.estimateMinutes || 0), 0);

      const countSpan = document.createElement('span');
      countSpan.className = 'due-count';
      if (totalEstimate > 0) {
        countSpan.textContent = `${dueTasks.length}件 / ${totalEstimate}m`;
      } else {
        countSpan.textContent = `${dueTasks.length}件`;
      }
      div.appendChild(countSpan);
    }

    // Drag & Drop target
    div.addEventListener('dragover', handleCalendarDragOver);
    div.addEventListener('dragleave', handleCalendarDragLeave);
    div.addEventListener('drop', handleCalendarDrop);

    div.addEventListener('click', () => openDayPopup(dateKey, dueTasks));
    container.appendChild(div);
  }

  function openDayPopup(dateKey, tasks) {
    const popup = document.getElementById('dayPopup');
    const dateSpan = document.getElementById('dayPopupDate');
    const tasksList = document.getElementById('dayPopupTasks');

    dateSpan.textContent = dateKey;
    calendarSelectedDate = dateKey;
    while (tasksList.firstChild) tasksList.removeChild(tasksList.firstChild);

    if (tasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '期限のタスクはありません';
      tasksList.appendChild(empty);
    } else {
      tasks.forEach(task => {
        const li = document.createElement('li');
        li.className = 'day-popup-task';

        // Make draggable (except DONE tasks)
        if (task.status !== 'DONE') {
          li.draggable = true;
          li.dataset.taskId = task.id;
          li.dataset.sourceDate = task.sourceDate;
          li.dataset.dueAt = task.dueAt;
          li.addEventListener('dragstart', handleCalendarTaskDragStart);
          li.addEventListener('dragend', handleCalendarTaskDragEnd);
        }

        // Task info row
        const infoRow = document.createElement('div');
        infoRow.className = 'day-popup-task-info';

        // Status badge
        const statusBadge = document.createElement('span');
        statusBadge.className = `status-badge status-${task.status.toLowerCase().replace('_', '-')}`;
        const statusLabels = { 'IN_PROGRESS': '進行中', 'WAITING': '待ち', 'DONE': '完了' };
        statusBadge.textContent = statusLabels[task.status] || task.status;
        infoRow.appendChild(statusBadge);

        // Title
        const titleSpan = document.createElement('span');
        titleSpan.className = 'day-popup-task-title';
        titleSpan.textContent = task.title;
        titleSpan.addEventListener('click', () => {
          closeDayPopup();
          selectDate(task.sourceDate);
          setTimeout(() => openTaskDetail(task.id, task.sourceDate), 100);
        });
        infoRow.appendChild(titleSpan);

        // Estimate
        if (task.estimateMinutes) {
          const estSpan = document.createElement('span');
          estSpan.className = 'day-popup-task-est';
          estSpan.textContent = `${task.estimateMinutes}m`;
          infoRow.appendChild(estSpan);
        }

        li.appendChild(infoRow);

        // Quick reschedule buttons (only for non-DONE)
        if (task.status !== 'DONE') {
          const actions = document.createElement('div');
          actions.className = 'day-popup-task-actions';

          // Today button
          const todayBtn = document.createElement('button');
          todayBtn.className = 'move-btn';
          todayBtn.textContent = 'Today';
          todayBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            moveTaskToDate(task, getTodayString());
          });
          actions.appendChild(todayBtn);

          // Tomorrow button
          const tomorrowBtn = document.createElement('button');
          tomorrowBtn.className = 'move-btn';
          tomorrowBtn.textContent = 'Tmrw';
          tomorrowBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            moveTaskToDate(task, formatDate(tomorrow));
          });
          actions.appendChild(tomorrowBtn);

          // Next Monday button
          const nextMonBtn = document.createElement('button');
          nextMonBtn.className = 'move-btn';
          nextMonBtn.textContent = 'Mon';
          nextMonBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            postponeToNextMonday(task);
          });
          actions.appendChild(nextMonBtn);

          // Next Biz (skip weekends)
          const nextBizBtn = document.createElement('button');
          nextBizBtn.className = 'move-btn';
          nextBizBtn.textContent = 'Biz';
          nextBizBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            moveToNextBizDay(task);
          });
          actions.appendChild(nextBizBtn);

          li.appendChild(actions);
        }

        tasksList.appendChild(li);
      });
    }

    popup.dataset.dateKey = dateKey;
    popup.classList.remove('hidden');
  }

  function closeDayPopup() {
    document.getElementById('dayPopup').classList.add('hidden');
  }

  async function postponeTask(task, days) {
    const oldDueAt = task.dueAt;
    const oldDate = new Date(task.dueAt);
    oldDate.setDate(oldDate.getDate() + days);
    const newDueAt = oldDate.getTime();

    undoAction = async () => {
      await updateTask(task.sourceDate, task.id, { dueAt: oldDueAt, updatedAt: Date.now() });
    };

    await updateTask(task.sourceDate, task.id, { dueAt: newDueAt, updatedAt: Date.now() });
    await buildDueDateCache();
    renderCalendar();
    closeDayPopup();
    showToast(`期限を ${formatDate(oldDate)} に変更しました`, true);
  }

  async function postponeToNextMonday(task) {
    const oldDueAt = task.dueAt;
    const current = new Date(task.dueAt);
    const dayOfWeek = current.getDay();
    const daysUntilMonday = (8 - dayOfWeek) % 7 || 7;
    current.setDate(current.getDate() + daysUntilMonday);
    const newDueAt = current.getTime();

    undoAction = async () => {
      await updateTask(task.sourceDate, task.id, { dueAt: oldDueAt, updatedAt: Date.now() });
    };

    await updateTask(task.sourceDate, task.id, { dueAt: newDueAt, updatedAt: Date.now() });
    await buildDueDateCache();
    renderCalendar();
    closeDayPopup();
    showToast(`期限を ${formatDate(current)} に変更しました`, true);
  }

  async function addTaskFromCalendar() {
    const dateKey = document.getElementById('dayPopup').dataset.dateKey;
    if (!dateKey) return;

    const title = prompt('タスク名を入力:');
    if (!title || !title.trim()) return;

    // Convert dateKey to dueAt (default 18:00)
    const [y, m, d] = dateKey.split('-').map(Number);
    const dueAt = new Date(y, m - 1, d, 18, 0).getTime();

    await addTask(title.trim(), [], null, selectedDate, dueAt);
    await buildDueDateCache();
    renderCalendar();

    // Refresh the day popup with updated tasks
    const dueTasks = dueDateCache[dateKey] || [];
    openDayPopup(dateKey, dueTasks);
    showToast('タスクを追加しました');
  }

  // Move task to specific date (targetDate is YYYY-MM-DD string)
  async function moveTaskToDate(task, targetDate) {
    const oldDueAt = task.dueAt;
    const oldDueDate = oldDueAt ? new Date(oldDueAt) : null;

    // Preserve time from old dueAt, or default to 18:00
    const [y, m, d] = targetDate.split('-').map(Number);
    const hours = oldDueDate ? oldDueDate.getHours() : 18;
    const mins = oldDueDate ? oldDueDate.getMinutes() : 0;
    const newDueAt = new Date(y, m - 1, d, hours, mins).getTime();

    if (oldDueAt === newDueAt) return;

    undoAction = async () => {
      await updateTask(task.sourceDate, task.id, { dueAt: oldDueAt, updatedAt: Date.now() });
      await buildDueDateCache();
      renderCalendar();
    };

    await updateTask(task.sourceDate, task.id, { dueAt: newDueAt, updatedAt: Date.now() });
    await buildDueDateCache();
    renderCalendar();
    closeDayPopup();
    showToast(`→ ${targetDate}`, true);
  }

  // Move to next business day (skip weekends)
  async function moveToNextBizDay(task) {
    const oldDueAt = task.dueAt;
    const oldDueDate = oldDueAt ? new Date(oldDueAt) : null;
    const current = new Date();
    current.setDate(current.getDate() + 1);

    // Skip Saturday (6) and Sunday (0)
    while (current.getDay() === 0 || current.getDay() === 6) {
      current.setDate(current.getDate() + 1);
    }

    // Preserve time or default to 18:00
    const hours = oldDueDate ? oldDueDate.getHours() : 18;
    const mins = oldDueDate ? oldDueDate.getMinutes() : 0;
    current.setHours(hours, mins, 0, 0);
    const newDueAt = current.getTime();

    undoAction = async () => {
      await updateTask(task.sourceDate, task.id, { dueAt: oldDueAt, updatedAt: Date.now() });
      await buildDueDateCache();
      renderCalendar();
    };

    await updateTask(task.sourceDate, task.id, { dueAt: newDueAt, updatedAt: Date.now() });
    await buildDueDateCache();
    renderCalendar();
    closeDayPopup();
    showToast(`→ ${formatDate(current)} (Biz)`, true);
  }

  // Drag & Drop handlers for calendar
  function handleCalendarTaskDragStart(e) {
    draggedCalendarTask = {
      taskId: e.target.dataset.taskId,
      sourceDate: e.target.dataset.sourceDate,
      dueAt: parseInt(e.target.dataset.dueAt)
    };
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedCalendarTask.taskId);
  }

  function handleCalendarTaskDragEnd(e) {
    e.target.classList.remove('dragging');
    draggedCalendarTask = null;

    // Remove drag-over class from all cells
    document.querySelectorAll('.calendar-day.drag-over').forEach(cell => {
      cell.classList.remove('drag-over');
    });
  }

  function handleCalendarDragOver(e) {
    if (!draggedCalendarTask) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
  }

  function handleCalendarDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
  }

  async function handleCalendarDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');

    if (!draggedCalendarTask) return;

    const targetDateKey = e.currentTarget.dataset.dateKey;
    const oldDueAt = draggedCalendarTask.dueAt;
    const oldDueDate = oldDueAt ? new Date(oldDueAt) : null;

    // Convert targetDateKey to dueAt, preserving time or defaulting to 18:00
    const [y, m, d] = targetDateKey.split('-').map(Number);
    const hours = oldDueDate ? oldDueDate.getHours() : 18;
    const mins = oldDueDate ? oldDueDate.getMinutes() : 0;
    const newDueAt = new Date(y, m - 1, d, hours, mins).getTime();

    if (oldDueAt === newDueAt) {
      draggedCalendarTask = null;
      return;
    }

    const sourceDate = draggedCalendarTask.sourceDate;
    const taskId = draggedCalendarTask.taskId;

    undoAction = async () => {
      await updateTask(sourceDate, taskId, { dueAt: oldDueAt, updatedAt: Date.now() });
      await buildDueDateCache();
      renderCalendar();
    };

    await updateTask(sourceDate, taskId, { dueAt: newDueAt, updatedAt: Date.now() });
    await buildDueDateCache();
    renderCalendar();
    closeDayPopup();
    showToast(`→ ${targetDateKey}`, true);

    draggedCalendarTask = null;
  }


  // ===== Notes =====
  let noteSaveTimers = {};

  async function initNotesScreen() {
    await renderNotes();
  }

  async function renderNotes() {
    const notes = await getAllNotes();
    notes.sort((a, b) => a.createdAt - b.createdAt);

    const container = document.getElementById('notesContainer');
    while (container.firstChild) container.removeChild(container.firstChild);

    if (notes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'メモがありません';
      container.appendChild(empty);
      return;
    }

    notes.forEach(note => {
      container.appendChild(createNoteCard(note));
    });
  }

  function createNoteCard(note) {
    const card = document.createElement('div');
    card.className = 'note-card' + (note.collapsed ? ' collapsed' : '');
    card.dataset.id = note.id;

    const header = document.createElement('div');
    header.className = 'note-header';

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'note-collapse-btn';
    collapseBtn.textContent = note.collapsed ? '▸' : '▾';
    collapseBtn.addEventListener('click', () => toggleNoteCollapse(note.id, card, collapseBtn));

    const titleInput = document.createElement('input');
    titleInput.className = 'note-title-input';
    titleInput.type = 'text';
    titleInput.value = note.title;
    titleInput.placeholder = '無題のメモ';
    titleInput.addEventListener('input', () => debounceSaveNote(note.id));
    titleInput.addEventListener('blur', () => saveNoteNow(note.id));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'note-delete-btn';
    deleteBtn.textContent = '🗑';
    deleteBtn.addEventListener('click', () => confirmDeleteNote(note.id));

    header.appendChild(collapseBtn);
    header.appendChild(titleInput);
    header.appendChild(deleteBtn);

    const body = document.createElement('div');
    body.className = 'note-body';

    const textarea = document.createElement('textarea');
    textarea.className = 'note-textarea';
    textarea.value = note.body;
    textarea.placeholder = 'メモを入力...';
    textarea.addEventListener('input', () => debounceSaveNote(note.id));
    textarea.addEventListener('blur', () => saveNoteNow(note.id));

    body.appendChild(textarea);
    card.appendChild(header);
    card.appendChild(body);

    return card;
  }

  async function addNewNote() {
    const note = {
      id: generateId(),
      title: '',
      body: '',
      collapsed: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await saveNote(note);
    await renderNotes();

    // Focus new note's title
    const lastCard = document.querySelector('.notes-container .note-card:last-child');
    if (lastCard) {
      const titleInput = lastCard.querySelector('.note-title-input');
      if (titleInput) titleInput.focus();
    }
  }

  function debounceSaveNote(noteId) {
    if (noteSaveTimers[noteId]) clearTimeout(noteSaveTimers[noteId]);
    noteSaveTimers[noteId] = setTimeout(() => saveNoteNow(noteId), 500);
  }

  async function saveNoteNow(noteId) {
    if (noteSaveTimers[noteId]) {
      clearTimeout(noteSaveTimers[noteId]);
      delete noteSaveTimers[noteId];
    }

    const card = document.querySelector(`.note-card[data-id="${noteId}"]`);
    if (!card) return;

    const titleInput = card.querySelector('.note-title-input');
    const textarea = card.querySelector('.note-textarea');
    const isCollapsed = card.classList.contains('collapsed');

    const notes = await getAllNotes();
    const note = notes.find(n => n.id === noteId);
    if (!note) return;

    note.title = titleInput.value;
    note.body = textarea.value;
    note.collapsed = isCollapsed;

    await saveNote(note);
  }

  async function toggleNoteCollapse(noteId, card, btn) {
    const isCollapsed = card.classList.toggle('collapsed');
    btn.textContent = isCollapsed ? '▸' : '▾';

    const notes = await getAllNotes();
    const note = notes.find(n => n.id === noteId);
    if (note) {
      note.collapsed = isCollapsed;
      await saveNote(note);
    }
  }

  async function confirmDeleteNote(noteId) {
    if (confirm('このメモを削除しますか？')) {
      await deleteNote(noteId);
      await renderNotes();
    }
  }

  // ===== Logs =====
  let logsDateKey = getTodayString();
  let reportSaveTimer = null;

  async function initLogsScreen() {
    logsDateKey = getTodayString();
    await renderLogs();
    await loadDailyReport();
    setupLogsTabSwitching();
  }

  function setupLogsTabSwitching() {
    document.querySelectorAll('.logs-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        setLogsTab(tabName);
      });
    });
  }

  function setLogsTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.logs-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    // Show/hide panels
    const leftPanel = document.getElementById('logsLeftPanel');
    const rightPanel = document.getElementById('logsRightPanel');

    if (tabName === 'logs') {
      leftPanel.classList.remove('hidden');
      rightPanel.classList.add('hidden');
    } else {
      leftPanel.classList.add('hidden');
      rightPanel.classList.remove('hidden');
    }
  }

  async function renderLogs() {
    const dateDisplay = document.getElementById('logsDate');
    dateDisplay.textContent = logsDateKey === getTodayString() ? '今日' : logsDateKey;

    const logs = await getLogsForDate(logsDateKey);
    const validLogs = logs.filter(l => l.type === 'taskDone');

    // Get focus sessions for the date
    const sessions = await getSessionsForDate(logsDateKey);
    const totalFocus = sessions.reduce((sum, s) => sum + s.durationSeconds, 0);

    // Summary
    document.getElementById('logsCompletedCount').textContent = validLogs.length;
    const totalEstimate = validLogs.reduce((sum, l) => sum + (l.estimateMinutesSnapshot || 0), 0);
    document.getElementById('logsEstimateTotal').textContent = totalEstimate;
    document.getElementById('logsFocusTotal').textContent = Math.floor(totalFocus / 60);

    // List
    const list = document.getElementById('logsList');
    while (list.firstChild) list.removeChild(list.firstChild);

    if (validLogs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '完了したタスクはありません';
      list.appendChild(empty);
      return;
    }

    validLogs.forEach(log => {
      const li = document.createElement('li');
      li.className = 'log-item';
      li.addEventListener('click', () => tryOpenLogTask(log));

      const timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      timeSpan.textContent = formatTime(log.doneAt);

      const titleSpan = document.createElement('span');
      titleSpan.className = 'log-title';
      titleSpan.textContent = log.titleSnapshot;

      li.appendChild(timeSpan);
      li.appendChild(titleSpan);

      if (log.estimateMinutesSnapshot) {
        const estSpan = document.createElement('span');
        estSpan.className = 'log-estimate';
        estSpan.textContent = log.estimateMinutesSnapshot + 'm';
        li.appendChild(estSpan);
      }

      list.appendChild(li);
    });

    // Load daily report for this date
    await loadDailyReport();
  }

  async function tryOpenLogTask(log) {
    // Try to find the task
    const allRecords = await getAllDayRecords();
    for (const record of allRecords) {
      const task = record.tasks.find(t => t.id === log.taskId);
      if (task) {
        openTaskDetail(task.id, record.date);
        return;
      }
    }
    showToast('このタスクは削除されています');
  }

  function changeLogsDate(delta) {
    const current = new Date(logsDateKey);
    current.setDate(current.getDate() + delta);
    logsDateKey = formatDate(current);
    renderLogs();
  }

  async function copyTodayLogs() {
    const logs = await getLogsForDate(logsDateKey);
    const validLogs = logs.filter(l => l.type === 'taskDone');

    if (validLogs.length === 0) {
      showToast('コピーするログがありません');
      return;
    }

    const lines = validLogs.map(l => {
      const time = formatTime(l.doneAt);
      const est = l.estimateMinutesSnapshot ? ` (${l.estimateMinutesSnapshot}m)` : '';
      return `${time} ${l.titleSnapshot}${est}`;
    });

    const text = `${logsDateKey} 完了ログ\n` + lines.join('\n');

    try {
      await navigator.clipboard.writeText(text);
      showToast('ログをクリップボードにコピーしました');
    } catch {
      showToast('コピーに失敗しました');
    }
  }

  // ===== Daily Report Functions =====
  async function loadDailyReport() {
    const report = await getDailyReport(logsDateKey);

    document.getElementById('reportDoneTasks').value = report?.doneTasks || '';
    document.getElementById('reportMemo').value = report?.memo || '';
    document.getElementById('reportTomorrow').value = report?.tomorrow || '';

    updateReportStatus('');
  }

  function debounceSaveReport() {
    if (reportSaveTimer) clearTimeout(reportSaveTimer);
    updateReportStatus('保存中...');
    reportSaveTimer = setTimeout(saveReportNow, 800);
  }

  async function saveReportNow() {
    const report = {
      dateKey: logsDateKey,
      doneTasks: document.getElementById('reportDoneTasks').value,
      memo: document.getElementById('reportMemo').value,
      tomorrow: document.getElementById('reportTomorrow').value
    };

    await saveDailyReport(report);
    updateReportStatus('保存済み');

    setTimeout(() => updateReportStatus(''), 2000);
  }

  function updateReportStatus(text) {
    const status = document.getElementById('reportSaveStatus');
    status.textContent = text;
    status.classList.toggle('saved', text === '保存済み');
  }

  async function copyDailyReport() {
    const doneTasks = document.getElementById('reportDoneTasks').value;
    const memo = document.getElementById('reportMemo').value;
    const tomorrow = document.getElementById('reportTomorrow').value;

    const lines = [`# ${logsDateKey} 日報`];

    if (doneTasks) {
      lines.push('\n## 進捗・完了タスク');
      lines.push(doneTasks);
    }

    if (memo) {
      lines.push('\n## 作業メモ');
      lines.push(memo);
    }

    if (tomorrow) {
      lines.push('\n## 明日やること');
      lines.push(tomorrow);
    }

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      showToast('日報をクリップボードにコピーしました');
    } catch {
      showToast('コピーに失敗しました');
    }
  }

  async function insertLogsToReport() {
    const logs = await getLogsForDate(logsDateKey);
    const validLogs = logs.filter(l => l.type === 'taskDone');

    if (validLogs.length === 0) {
      showToast('挿入するログがありません');
      return;
    }

    const lines = validLogs.map(l => {
      const est = l.estimateMinutesSnapshot ? ` (${l.estimateMinutesSnapshot}m)` : '';
      return `- ${l.titleSnapshot}${est}`;
    });

    const textarea = document.getElementById('reportDoneTasks');
    const current = textarea.value;
    textarea.value = current + (current ? '\n' : '') + lines.join('\n');

    debounceSaveReport();
    showToast('ログを挿入しました');
  }

  async function getSessionsForDate(dateKey) {
    const allSessions = await getAllSessions();
    return allSessions.filter(s => s.date === dateKey);
  }

  async function getAllSessions() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SESSIONS, 'readonly');
      const store = tx.objectStore(STORE_SESSIONS);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  // ===== Log Entry Creation (hook into status change) =====
  async function createDoneLog(task, date) {
    const now = Date.now();
    const entry = {
      id: generateId(),
      dateKey: getLocalDateKey(now),
      type: 'taskDone',
      taskId: task.id,
      titleSnapshot: task.title,
      estimateMinutesSnapshot: task.estimateMinutes,
      doneAt: now
    };
    await saveLogEntry(entry);

    // Award pet XP
    const petState = await getPetState();
    petState.xp += 2;
    await savePetState(petState);
  }

  async function revertDoneLog(taskId) {
    const logs = await getLogsByTaskId(taskId);
    const latestDone = logs.find(l => l.type === 'taskDone');
    if (latestDone) {
      await deleteLogEntry(latestDone.id);
    }
  }

  // ===== Break / Pet (Timer Core) =====
  let petState = null;

  const PET_MESSAGES = {
    normal: ['...', 'ティック', 'トック', '時を刻む...'],
    happy: ['キラッ！', 'やった！', 'うれしい♪', 'ありがとう！'],
    sleepy: ['zzz...', '休憩中...', '充電中...']
  };

  // Timer Core SVG - clock spirit mascot
  const PET_SVG = `<svg class="pet-svg" viewBox="0 0 100 100">
    <defs>
      <radialGradient id="coreGrad" cx="50%" cy="35%" r="55%">
        <stop offset="0%" stop-color="#e8f4f8"/>
        <stop offset="50%" stop-color="#a8d4e6"/>
        <stop offset="100%" stop-color="#6bb3d0"/>
      </radialGradient>
      <radialGradient id="ringGrad" cx="50%" cy="50%" r="50%">
        <stop offset="70%" stop-color="#4a9ab8"/>
        <stop offset="100%" stop-color="#2d7a98"/>
      </radialGradient>
      <filter id="coreShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#2d7a98" flood-opacity="0.3"/>
      </filter>
      <filter id="groundShadow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="2"/>
      </filter>
    </defs>
    <!-- Ground shadow -->
    <ellipse cx="50" cy="92" rx="25" ry="5" fill="#1a1a1a" opacity="0.3" filter="url(#groundShadow)"/>
    <!-- Outer ring -->
    <circle class="outer-ring" cx="50" cy="50" r="42" fill="none" stroke="url(#ringGrad)" stroke-width="4" opacity="0.6"/>
    <!-- Main body (clock core) -->
    <g class="body" filter="url(#coreShadow)">
      <circle cx="50" cy="50" r="35" fill="url(#coreGrad)" stroke="#5a9ab0" stroke-width="1.5"/>
    </g>
    <!-- Clock face decorations -->
    <g class="clock-marks" opacity="0.3">
      <line x1="50" y1="18" x2="50" y2="22" stroke="#3a6a7a" stroke-width="2" stroke-linecap="round"/>
      <line x1="50" y1="78" x2="50" y2="82" stroke="#3a6a7a" stroke-width="2" stroke-linecap="round"/>
      <line x1="18" y1="50" x2="22" y2="50" stroke="#3a6a7a" stroke-width="2" stroke-linecap="round"/>
      <line x1="78" y1="50" x2="82" y2="50" stroke="#3a6a7a" stroke-width="2" stroke-linecap="round"/>
    </g>
    <!-- Hour hand -->
    <line class="hour-hand" x1="50" y1="50" x2="50" y2="32" stroke="#3a5a6a" stroke-width="3" stroke-linecap="round"/>
    <!-- Minute hand -->
    <line class="minute-hand" x1="50" y1="50" x2="62" y2="38" stroke="#4a7a8a" stroke-width="2" stroke-linecap="round"/>
    <!-- Center dot -->
    <circle cx="50" cy="50" r="4" fill="#3a5a6a"/>
    <circle cx="50" cy="50" r="2" fill="#e8f4f8"/>
    <!-- Face -->
    <g class="face">
      <!-- Eyes -->
      <g class="eyes">
        <ellipse class="eye-left" cx="40" cy="48" rx="4" ry="5" fill="#2a3a3a"/>
        <ellipse class="eye-right" cx="60" cy="48" rx="4" ry="5" fill="#2a3a3a"/>
        <!-- Highlights -->
        <circle cx="39" cy="46" r="1.5" fill="white"/>
        <circle cx="59" cy="46" r="1.5" fill="white"/>
      </g>
      <!-- Mouth -->
      <path class="mouth" d="M46,60 Q50,63 54,60" fill="none" stroke="#3a5a6a" stroke-width="1.5" stroke-linecap="round"/>
      <text class="mouth-omega" x="50" y="63" text-anchor="middle" font-size="7" fill="#3a5a6a" style="display:none">ω</text>
    </g>
  </svg>`;

  async function initBreakScreen() {
    petState = await getPetState();
    renderPet();
    renderPetStats();
    await renderPetTodayStats();
  }

  function renderPet() {
    const container = document.getElementById('petLargeContainer');
    // Preserve the bubble element
    const bubble = document.getElementById('petBubble');
    const bubbleHTML = bubble ? bubble.outerHTML : '';

    container.innerHTML = PET_SVG + bubbleHTML;

    // Apply mood
    if (petState) {
      applyPetMood(container, petState.mood);
    }

    // Make clickable
    const svg = container.querySelector('.pet-svg');
    if (svg) {
      svg.style.cursor = 'pointer';
      svg.addEventListener('click', handlePetClick);
    }
  }

  function applyPetMood(container, mood) {
    const eyes = container.querySelectorAll('.eye-left, .eye-right');
    const mouth = container.querySelector('.mouth');
    const mouthOmega = container.querySelector('.mouth-omega');
    const ring = container.querySelector('.outer-ring');
    const hourHand = container.querySelector('.hour-hand');
    const minuteHand = container.querySelector('.minute-hand');

    if (mood === 'happy') {
      // Happy: squint eyes, omega mouth, brighter ring
      eyes.forEach(e => e.setAttribute('ry', '2'));
      if (mouth) mouth.style.display = 'none';
      if (mouthOmega) mouthOmega.style.display = 'block';
      if (ring) {
        ring.setAttribute('stroke-width', '5');
        ring.setAttribute('opacity', '0.8');
      }
      if (hourHand) hourHand.setAttribute('transform', 'rotate(-10 50 50)');
      if (minuteHand) minuteHand.setAttribute('transform', 'rotate(5 50 50)');
    } else if (mood === 'sleepy') {
      // Sleepy: half-closed eyes, flat mouth, dim ring
      eyes.forEach(e => e.setAttribute('ry', '1.5'));
      if (mouth) mouth.setAttribute('d', 'M46,60 Q50,59 54,60');
      if (mouthOmega) mouthOmega.style.display = 'none';
      if (ring) {
        ring.setAttribute('stroke-width', '3');
        ring.setAttribute('opacity', '0.4');
      }
      if (hourHand) hourHand.setAttribute('transform', 'rotate(15 50 50)');
      if (minuteHand) minuteHand.setAttribute('transform', 'rotate(20 50 50)');
    } else {
      // Normal: round eyes, small smile
      eyes.forEach(e => e.setAttribute('ry', '5'));
      if (mouth) {
        mouth.style.display = 'block';
        mouth.setAttribute('d', 'M46,60 Q50,63 54,60');
      }
      if (mouthOmega) mouthOmega.style.display = 'none';
      if (ring) {
        ring.setAttribute('stroke-width', '4');
        ring.setAttribute('opacity', '0.6');
      }
      if (hourHand) hourHand.removeAttribute('transform');
      if (minuteHand) minuteHand.removeAttribute('transform');
    }
  }

  function renderPetStats() {
    if (!petState) return;
    document.getElementById('petLevel').textContent = petState.level;
    document.getElementById('petXP').textContent = petState.xp;
    document.getElementById('petTreats').textContent = petState.treats;

    const moodLabels = { normal: 'ふつう', happy: 'うれしい', sleepy: 'ねむい' };
    document.getElementById('petMood').textContent = moodLabels[petState.mood] || 'ふつう';
  }

  async function renderPetTodayStats() {
    const sessions = await getTodaySessions();
    const totalMinutes = Math.floor(sessions.reduce((sum, s) => sum + s.durationSeconds, 0) / 60);
    document.getElementById('petTodayFocus').textContent = totalMinutes;

    const logs = await getLogsForDate(getTodayString());
    const doneCount = logs.filter(l => l.type === 'taskDone').length;
    document.getElementById('petTodayDone').textContent = doneCount;
  }

  async function handlePetClick() {
    if (!petState) petState = await getPetState();
    bouncePet(document.getElementById('petLargeContainer'));
    showPetBubble();
  }

  async function petThePet() {
    if (!petState) petState = await getPetState();

    petState.mood = 'happy';
    petState.lastInteractionAt = Date.now();
    await savePetState(petState);

    renderPet();
    renderPetStats();
    bouncePet(document.getElementById('petLargeContainer'));
    showPetBubble();

    // Reset mood after a while
    setTimeout(async () => {
      if (petState.mood === 'happy') {
        petState.mood = 'normal';
        await savePetState(petState);
        if (currentScreen === 'break') {
          renderPet();
          renderPetStats();
        }
      }
    }, 5000);
  }

  async function giveTreat() {
    if (!petState) petState = await getPetState();

    if (petState.treats <= 0) {
      showToast('おやつがありません！');
      return;
    }

    petState.treats -= 1;
    petState.mood = 'happy';
    petState.lastInteractionAt = Date.now();
    await savePetState(petState);

    renderPet();
    renderPetStats();
    bouncePet(document.getElementById('petLargeContainer'));
    showPetBubble();
  }

  function bouncePet(container) {
    const svg = container.querySelector('.pet-svg');
    if (svg) {
      svg.classList.remove('bounce');
      void svg.offsetWidth; // reflow
      svg.classList.add('bounce');
    }
  }

  function showPetBubble() {
    const bubble = document.getElementById('petBubble');
    if (!bubble) return;

    const messages = PET_MESSAGES[petState?.mood || 'normal'];
    bubble.textContent = messages[Math.floor(Math.random() * messages.length)];
    bubble.classList.remove('hidden');

    // Clone to restart animation
    const newBubble = bubble.cloneNode(true);
    bubble.parentNode.replaceChild(newBubble, bubble);
    newBubble.classList.remove('hidden');

    setTimeout(() => newBubble.classList.add('hidden'), 2000);
  }

  // ===== Award pet rewards from Focus =====
  async function awardFocusReward(durationMinutes) {
    if (!petState) petState = await getPetState();

    const today = getTodayString();
    const lastRewardDate = petState.lastRewardAt ? getLocalDateKey(petState.lastRewardAt) : null;

    petState.xp += durationMinutes;

    // Award treat once per session (check if already awarded today with at least 1 session)
    if (lastRewardDate !== today && petState.treats < 10) {
      petState.treats += 1;
    }

    petState.lastRewardAt = Date.now();

    // Level up check (every 100 XP)
    while (petState.xp >= petState.level * 100) {
      petState.xp -= petState.level * 100;
      petState.level += 1;
    }

    await savePetState(petState);
  }

  // ===== Count Screen =====
  let countDebounceTimer = null;

  function initCountScreen() {
    // Just update the results when screen is shown
    updateCountResults();
  }

  function updateCountResults() {
    const textarea = document.getElementById('countTextarea');
    if (!textarea) return;

    const text = textarea.value.replace(/\r\n/g, '\n'); // Normalize newlines

    // Characters including newlines
    const charsIncl = text.length;

    // Characters excluding newlines
    const charsExcl = text.replace(/\n/g, '').length;

    // Characters excluding spaces (half-width, full-width, tabs, newlines)
    const charsNoSpace = text.replace(/[\s　\t\n]/g, '').length;

    // Lines (empty = 0, otherwise split by \n)
    const lines = text === '' ? 0 : text.split('\n').length;

    // Words (split by whitespace, filter empty)
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;

    // Update UI
    document.getElementById('countCharsIncl').textContent = charsIncl;
    document.getElementById('countCharsExcl').textContent = charsExcl;
    document.getElementById('countCharsNoSpace').textContent = charsNoSpace;
    document.getElementById('countLines').textContent = lines;
    document.getElementById('countWords').textContent = words;
  }

  function debounceCountUpdate() {
    if (countDebounceTimer) clearTimeout(countDebounceTimer);
    countDebounceTimer = setTimeout(updateCountResults, 150);
  }

  function clearCountText() {
    const textarea = document.getElementById('countTextarea');
    if (textarea) {
      textarea.value = '';
      updateCountResults();
    }
  }

  function copyCountText() {
    const textarea = document.getElementById('countTextarea');
    if (textarea && textarea.value) {
      navigator.clipboard.writeText(textarea.value).then(() => {
        showToast('コピーしました');
      }).catch(() => {
        showToast('コピーに失敗しました');
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

    // Event listeners - Sound/Reward Settings
    const soundEnabledCheckbox = document.getElementById('settingsSoundEnabled');
    const soundVolumeSlider = document.getElementById('settingsSoundVolume');
    const volumeLabel = document.getElementById('settingsVolumeLabel');
    const testSoundBtn = document.getElementById('settingsTestSound');
    const rewardEnabledCheckbox = document.getElementById('settingsRewardEnabled');

    if (soundEnabledCheckbox) {
      soundEnabledCheckbox.checked = appSettings.soundEnabled;
      soundEnabledCheckbox.addEventListener('change', async (e) => {
        appSettings.soundEnabled = e.target.checked;
        await saveSettings();
      });
    }

    if (soundVolumeSlider && volumeLabel) {
      soundVolumeSlider.value = appSettings.soundVolume * 100;
      volumeLabel.textContent = Math.round(appSettings.soundVolume * 100) + '%';
      soundVolumeSlider.addEventListener('input', (e) => {
        const vol = parseInt(e.target.value) / 100;
        volumeLabel.textContent = e.target.value + '%';
        appSettings.soundVolume = vol;
      });
      soundVolumeSlider.addEventListener('change', async () => {
        await saveSettings();
      });
    }

    if (testSoundBtn) {
      testSoundBtn.addEventListener('click', async () => {
        await testAndUnlockAudio();
      });
    }

    if (rewardEnabledCheckbox) {
      rewardEnabledCheckbox.checked = appSettings.rewardEnabled;
      rewardEnabledCheckbox.addEventListener('change', async (e) => {
        appSettings.rewardEnabled = e.target.checked;
        appSettings.rewardAnimationEnabled = e.target.checked;
        await saveSettings();
      });
    }

    // Update audio status on page load
    updateAudioStatusUI();

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
    document.getElementById('unlinkTaskBtn').addEventListener('click', unlinkActiveTask);
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

    // Event listeners - Search
    document.getElementById('searchBtn').addEventListener('click', openSearchModal);
    document.getElementById('searchClose').addEventListener('click', closeSearchModal);
    document.getElementById('searchModal').addEventListener('click', (e) => {
      if (e.target.id === 'searchModal') closeSearchModal();
    });
    document.getElementById('searchInput').addEventListener('input', (e) => {
      performSearch(e.target.value);
    });

    // Event listeners - Task Detail Modal
    document.getElementById('taskDetailClose').addEventListener('click', closeTaskDetail);
    document.getElementById('taskDetailModal').addEventListener('click', (e) => {
      if (e.target.id === 'taskDetailModal') closeTaskDetail();
    });
    document.getElementById('taskDetailSave').addEventListener('click', saveTaskDetail);
    document.getElementById('taskDetailDelete').addEventListener('click', deleteTaskFromDetail);
    document.getElementById('detailDueDateClear').addEventListener('click', () => {
      document.getElementById('detailDueDate').value = '';
    });
    document.getElementById('subtaskAddBtn').addEventListener('click', addSubtask);
    document.getElementById('subtaskInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSubtask();
      }
    });

    // Event listeners - Calendar
    document.getElementById('calendarPrev').addEventListener('click', () => {
      calendarMonth--;
      if (calendarMonth < 0) {
        calendarMonth = 11;
        calendarYear--;
      }
      renderCalendar();
    });
    document.getElementById('calendarNext').addEventListener('click', () => {
      calendarMonth++;
      if (calendarMonth > 11) {
        calendarMonth = 0;
        calendarYear++;
      }
      renderCalendar();
    });
    document.getElementById('calendarToday').addEventListener('click', () => {
      const today = new Date();
      calendarYear = today.getFullYear();
      calendarMonth = today.getMonth();
      renderCalendar();
    });
    document.getElementById('dayPopupClose').addEventListener('click', closeDayPopup);
    document.getElementById('dayPopupAddTask').addEventListener('click', addTaskFromCalendar);

    // Event listeners - Notes
    document.getElementById('addNoteBtn').addEventListener('click', addNewNote);

    // Event listeners - Logs
    document.getElementById('logsPrev').addEventListener('click', () => changeLogsDate(-1));
    document.getElementById('logsNext').addEventListener('click', () => changeLogsDate(1));
    document.getElementById('logsToday').addEventListener('click', () => {
      logsDateKey = getTodayString();
      renderLogs();
    });
    document.getElementById('logsCopyBtn').addEventListener('click', copyTodayLogs);

    // Event listeners - Daily Report
    document.getElementById('reportDoneTasks').addEventListener('input', debounceSaveReport);
    document.getElementById('reportMemo').addEventListener('input', debounceSaveReport);
    document.getElementById('reportTomorrow').addEventListener('input', debounceSaveReport);
    document.getElementById('reportCopyBtn').addEventListener('click', copyDailyReport);
    document.getElementById('reportInsertLogsBtn').addEventListener('click', insertLogsToReport);

    // Event listeners - Break / Pet
    document.getElementById('petPetBtn').addEventListener('click', petThePet);
    document.getElementById('petTreatBtn').addEventListener('click', giveTreat);

    // Event listeners - Count Screen
    const countTextarea = document.getElementById('countTextarea');
    if (countTextarea) {
      countTextarea.addEventListener('input', debounceCountUpdate);
    }
    const countClearBtn = document.getElementById('countClearBtn');
    if (countClearBtn) {
      countClearBtn.addEventListener('click', clearCountText);
    }
    const countCopyBtn = document.getElementById('countCopyBtn');
    if (countCopyBtn) {
      countCopyBtn.addEventListener('click', copyCountText);
    }

    // Event listeners - Reminder Banner
    document.getElementById('reminderOpen').addEventListener('click', () => handleReminderAction('open'));
    document.getElementById('reminderDone').addEventListener('click', () => handleReminderAction('done'));
    document.getElementById('reminderSnooze5').addEventListener('click', () => handleReminderAction('snooze5'));
    document.getElementById('reminderSnooze10').addEventListener('click', () => handleReminderAction('snooze10'));
    document.getElementById('reminderClose').addEventListener('click', () => handleReminderAction('close'));

    // Event listeners - Settings (created date format)
    const settingsFormatSelect = document.getElementById('settingsCreatedDateFormat');
    if (settingsFormatSelect) {
      settingsFormatSelect.value = appSettings.createdDateFormat;
      settingsFormatSelect.addEventListener('change', (e) => {
        appSettings.createdDateFormat = e.target.value;
        saveSettings();
        renderTasks();
      });
    }

    // Event listeners - Task Detail: Due Time and Remind
    const detailDueTime = document.getElementById('detailDueTime');
    const detailRemindTime = document.getElementById('detailRemindTime');
    if (detailDueTime) populateTimeSelect(detailDueTime);
    if (detailRemindTime) populateTimeSelect(detailRemindTime);

    const remindClearBtn = document.getElementById('detailRemindClear');
    if (remindClearBtn) {
      remindClearBtn.addEventListener('click', () => {
        document.getElementById('detailRemindDate').value = '';
        document.getElementById('detailRemindTime').value = '';
      });
    }

    // Visibility change listener
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  // Populate time select with 15-min intervals
  function populateTimeSelect(selectElement) {
    // Already has empty option
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 15) {
        const hStr = String(h).padStart(2, '0');
        const mStr = String(m).padStart(2, '0');
        const option = document.createElement('option');
        option.value = `${hStr}:${mStr}`;
        option.textContent = `${hStr}:${mStr}`;
        selectElement.appendChild(option);
      }
    }
  }



  // Start app
  init().catch(console.error);
})();
