/**
 * Onsite — Popup controller
 * ======================================
 * Renders the current settings into the control panel and persists any change
 * back to chrome.storage.local under the single `settings` key. The content
 * script listens to storage changes and re-applies live, so the popup never
 * needs to message tabs directly.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'settings';
  const THEME_KEY = 'leetcodeTheme';

  /** Reduced-scope settings, mirroring the content script defaults. */
  const DEFAULT_SETTINGS = {
    modeEnabled: true,
    hideDifficulty: true,
    hideAcceptance: true,
    hideSocialMetrics: true,
    hideTopics: true,
    interviewTimer: {
      enabled: false,
      durationMinutes: 45
    },
    runLimit: {
      enabled: false,
      maxRuns: 3
    }
  };

  /** Boolean settings mapped to their checkbox element ids. */
  const BOOLEAN_FIELDS = [
    'modeEnabled',
    'hideDifficulty',
    'hideAcceptance',
    'hideSocialMetrics',
    'hideTopics'
  ];

  // Cached element references.
  const els = {};
  let statusTimer = null;

  /* ---------------------------------------------------------------------- */

  /** Merge a stored object onto defaults with defensive type coercion. */
  function mergeSettings(stored) {
    const result = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (!stored || typeof stored !== 'object') return result;

    for (const key of BOOLEAN_FIELDS) {
      if (typeof stored[key] === 'boolean') result[key] = stored[key];
    }
    const t = stored.interviewTimer;
    if (t && typeof t === 'object') {
      result.interviewTimer.enabled = !!t.enabled;
      const minutes = Number(t.durationMinutes);
      result.interviewTimer.durationMinutes =
        Number.isFinite(minutes) && minutes > 0
          ? Math.min(240, Math.round(minutes))
          : DEFAULT_SETTINGS.interviewTimer.durationMinutes;
    }
    const r = stored.runLimit;
    if (r && typeof r === 'object') {
      result.runLimit.enabled = !!r.enabled;
      const maxRuns = Number(r.maxRuns);
      result.runLimit.maxRuns = Number.isFinite(maxRuns)
        ? Math.min(10, Math.max(1, Math.round(maxRuns)))
        : DEFAULT_SETTINGS.runLimit.maxRuns;
    }
    return result;
  }

  /** Load settings, returning defaults on any error. */
  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_KEY, (res) => {
          resolve(mergeSettings(res && res[STORAGE_KEY]));
        });
      } catch (_err) {
        resolve(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
      }
    });
  }

  /** Persist settings and flash a brief "Saved" confirmation. */
  function saveSettings(settings) {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: settings }, () => {
        flashStatus('Saved');
      });
    } catch (_err) {
      flashStatus('Save failed');
    }
  }

  function flashStatus(text) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.classList.add('is-visible');
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      els.status.classList.remove('is-visible');
    }, 1200);
  }

  /* ---------------------------------------------------------------------- */

  /** Read the current UI state into a settings object. */
  function readUi() {
    const settings = { interviewTimer: {} };
    for (const key of BOOLEAN_FIELDS) {
      settings[key] = !!els[key].checked;
    }
    settings.interviewTimer.enabled = !!els.timerEnabled.checked;

    let minutes = parseInt(els.timerDuration.value, 10);
    if (!Number.isFinite(minutes) || minutes < 1) minutes = 1;
    if (minutes > 240) minutes = 240;
    settings.interviewTimer.durationMinutes = minutes;

    settings.runLimit = {};
    settings.runLimit.enabled = !!els.runLimitEnabled.checked;
    let maxRuns = parseInt(els.runLimitMax.value, 10);
    if (!Number.isFinite(maxRuns) || maxRuns < 1) maxRuns = 1;
    if (maxRuns > 10) maxRuns = 10;
    settings.runLimit.maxRuns = maxRuns;

    return settings;
  }

  /** Paint a settings object onto the UI controls. */
  function renderUi(settings) {
    for (const key of BOOLEAN_FIELDS) {
      els[key].checked = !!settings[key];
    }
    els.timerEnabled.checked = !!settings.interviewTimer.enabled;
    els.timerDuration.value = settings.interviewTimer.durationMinutes;
    els.runLimitEnabled.checked = !!settings.runLimit.enabled;
    els.runLimitMax.value = settings.runLimit.maxRuns;
    reflectDerivedState();
  }

  /** Update purely-visual states that depend on other controls. */
  function reflectDerivedState() {
    // Dim feature cards when the master switch is off.
    els.app.classList.toggle('is-disabled', !els.modeEnabled.checked);
    // Hide the duration row when the timer is off.
    els.timerDurationRow.classList.toggle('is-hidden', !els.timerEnabled.checked);
    // Hide the max-runs row when the run limit is off.
    els.runLimitMaxRow.classList.toggle('is-hidden', !els.runLimitEnabled.checked);
  }

  /** Persist the current UI and update derived visuals. */
  function commit() {
    reflectDerivedState();
    saveSettings(readUi());
  }

  /* ---------------------------------------------------------------------- */

  function cacheElements() {
    els.app = document.querySelector('.app');
    els.status = document.getElementById('status');
    els.timerEnabled = document.getElementById('timerEnabled');
    els.timerDuration = document.getElementById('timerDuration');
    els.timerDurationRow = document.getElementById('timerDurationRow');
    els.runLimitEnabled = document.getElementById('runLimitEnabled');
    els.runLimitMax = document.getElementById('runLimitMax');
    els.runLimitMaxRow = document.getElementById('runLimitMaxRow');
    for (const key of BOOLEAN_FIELDS) {
      els[key] = document.getElementById(key);
    }
  }

  function bindEvents() {
    for (const key of BOOLEAN_FIELDS) {
      els[key].addEventListener('change', commit);
    }
    els.timerEnabled.addEventListener('change', commit);
    // Persist on input for instant feedback, and clamp on blur.
    els.timerDuration.addEventListener('change', commit);
    els.timerDuration.addEventListener('blur', () => {
      let minutes = parseInt(els.timerDuration.value, 10);
      if (!Number.isFinite(minutes) || minutes < 1) minutes = 1;
      if (minutes > 240) minutes = 240;
      els.timerDuration.value = minutes;
    });
    els.runLimitEnabled.addEventListener('change', commit);
    els.runLimitMax.addEventListener('change', commit);
    els.runLimitMax.addEventListener('blur', () => {
      let maxRuns = parseInt(els.runLimitMax.value, 10);
      if (!Number.isFinite(maxRuns) || maxRuns < 1) maxRuns = 1;
      if (maxRuns > 10) maxRuns = 10;
      els.runLimitMax.value = maxRuns;
    });
  }

  /** Apply a light/dark theme to the popup to mirror LeetCode. */
  function applyTheme(theme) {
    const resolved =
      theme === 'dark' || theme === 'light'
        ? theme
        : window.matchMedia &&
            window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    document.documentElement.setAttribute('data-theme', resolved);
  }

  /** Read the LeetCode theme the content script last detected, and watch it. */
  function initTheme() {
    try {
      chrome.storage.local.get(THEME_KEY, (res) => {
        applyTheme(res && res[THEME_KEY]);
      });
      if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes[THEME_KEY]) {
            applyTheme(changes[THEME_KEY].newValue);
          }
        });
      }
    } catch (_err) {
      applyTheme();
    }
  }

  async function init() {
    cacheElements();
    initTheme();
    const settings = await loadSettings();
    renderUi(settings);
    bindEvents();
    els.app.setAttribute('aria-busy', 'false');
  }

  document.addEventListener('DOMContentLoaded', init, { once: true });
})();
