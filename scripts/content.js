/**
 * Onsite — Content Script (Interview Mode Engine)
 * =============================================================
 *
 * Scope (reduced): four features only —
 *   - Difficulty Blindfold        (hideDifficulty)
 *   - Acceptance & Stats Blindfold (hideAcceptance)
 *   - Social Metrics Cleanse      (hideSocialMetrics)
 *   - Interview Timer overlay      (interviewTimer)
 *
 * Lifecycle (PRD §4):
 *   1. document_start: inject a FOUC boot blocker so difficulty/stats never
 *      flash before they are blindfolded.
 *   2. Resolve configuration from chrome.storage.local (with safe defaults).
 *   3. Scan + blindfold matched elements.
 *   4. Guard async React renders with a resilient MutationObserver + SPA
 *      route-change detection, re-scanning as new nodes appear.
 *   5. Unveil the cleansed workspace once the first scan completes.
 *
 * Guardrails (PRD §6):
 *   - We NEVER call element.remove() or restructure the tree (that desyncs
 *     React's reconciler). We only TOGGLE an inline `display:none !important`
 *     on matched elements and tag them with a data-attribute so the action is
 *     fully reversible when a setting is switched off.
 *   - Inline `!important` styles beat any LeetCode/Tailwind rule regardless of
 *     stylesheet load order, so hiding is reliable.
 *   - Detection is TEXT-NODE first (the literal words "Easy"/"Medium"/"Hard",
 *     "Acceptance Rate", etc.) so it survives Tailwind class churn; class /
 *     attribute selectors are only secondary fallbacks.
 */

(function () {
  'use strict';

  /* -------------------------------------------------------------------------
   * Constants & default configuration
   * ---------------------------------------------------------------------- */

  const STORAGE_KEY = 'settings';
  /** Stores the detected LeetCode theme so the popup can match it. */
  const THEME_KEY = 'leetcodeTheme';

  /** Default operational values (reduced scope). */
  const DEFAULT_SETTINGS = Object.freeze({
    modeEnabled: true,
    hideDifficulty: true,
    hideAcceptance: true,
    hideSocialMetrics: true,
    hideTopics: true,
    interviewTimer: Object.freeze({
      enabled: false,
      durationMinutes: 45
    }),
    runLimit: Object.freeze({
      enabled: false,
      maxRuns: 3
    })
  });

  /** Feature identifiers used to tag hidden elements (data-cs-hidden). */
  const FEATURE = Object.freeze({
    difficulty: 'difficulty',
    stat: 'stat',
    social: 'social',
    topic: 'topic'
  });

  const HIDDEN_ATTR = 'data-cs-hidden';
  const BOOT_CLASS = 'cleanslate-booting';
  const TIMER_ID = 'cleanslate-timer';
  const SAFETY_UNVEIL_MS = 3000;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SVG', 'PATH', 'CANVAS'
  ]);

  /** Matches numeric badge counters such as "12", "1.2k", "3,400", "1.1M". */
  const NUMERIC_BADGE_RE = /^[\d.,]+\s*[kKmM]?$/;

  /** Matches a standalone acceptance percentage such as "51.2%" or "45%". */
  const PERCENT_RE = /^\d{1,3}(?:\.\d+)?\s*%$/;

  /** Run-limit storage key + DOM hooks. */
  const RUN_COUNTS_KEY = 'runCounts';
  const RUN_TOOLTIP_ID = 'cleanslate-run-tooltip';
  const RUN_BLOCK_CLASS = 'cleanslate-run-blocked';

  /* -------------------------------------------------------------------------
   * Runtime state
   * ---------------------------------------------------------------------- */

  let currentSettings = clone(DEFAULT_SETTINGS);
  let observer = null;
  let lastHref = location.href;
  let rescanScheduled = false;
  /** Last detected LeetCode theme ('light' | 'dark'), to avoid redundant writes. */
  let lastTheme = null;
  /** Per-problem run counts, keyed by problem slug (persisted to storage). */
  let runCounts = {};
  /** Last on-screen position of the draggable timer ({left, top} in px). */
  let timerPosition = null;
  const timerState = {
    intervalId: null,
    endTimestamp: null,
    remainingMs: 0,
    running: false
  };

  /* -------------------------------------------------------------------------
   * Settings helpers
   * ---------------------------------------------------------------------- */

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /** Merge a possibly partial/corrupt stored object onto the defaults. */
  function mergeSettings(stored) {
    const result = clone(DEFAULT_SETTINGS);
    if (!stored || typeof stored !== 'object') return result;

    for (const key of ['modeEnabled', 'hideDifficulty', 'hideAcceptance', 'hideSocialMetrics', 'hideTopics']) {
      if (typeof stored[key] === 'boolean') result[key] = stored[key];
    }
    const t = stored.interviewTimer;
    if (t && typeof t === 'object') {
      result.interviewTimer.enabled = !!t.enabled;
      const minutes = Number(t.durationMinutes);
      result.interviewTimer.durationMinutes =
        Number.isFinite(minutes) && minutes > 0
          ? minutes
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

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_KEY, (res) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(clone(DEFAULT_SETTINGS));
            return;
          }
          resolve(mergeSettings(res && res[STORAGE_KEY]));
        });
      } catch (_err) {
        resolve(clone(DEFAULT_SETTINGS));
      }
    });
  }

  /* -------------------------------------------------------------------------
   * Step 1 / Step 5 — FOUC boot blocker
   * ---------------------------------------------------------------------- */

  function injectBootBlocker() {
    try {
      document.documentElement.classList.add(BOOT_CLASS);
    } catch (_err) {
      /* documentElement always exists at document_start */
    }
    window.setTimeout(unveil, SAFETY_UNVEIL_MS); // safety net
  }

  function unveil() {
    try {
      document.documentElement.classList.remove(BOOT_CLASS);
    } catch (_err) {
      /* no-op */
    }
  }

  /* -------------------------------------------------------------------------
   * Reversible hide / unhide primitives (React-safe, inline !important)
   * ---------------------------------------------------------------------- */

  /** Hide an element for a feature; idempotent and reversible. */
  function hideElement(el, feature) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (el.getAttribute(HIDDEN_ATTR) === feature) return; // already hidden
    el.setAttribute(HIDDEN_ATTR, feature);
    el.style.setProperty('display', 'none', 'important');
  }

  /** Restore every element hidden for a given feature. */
  function unhideFeature(feature) {
    const selector = '[' + HIDDEN_ATTR + '="' + feature + '"]';
    document.querySelectorAll(selector).forEach((el) => {
      el.style.removeProperty('display');
      el.removeAttribute(HIDDEN_ATTR);
    });
  }

  /** Restore everything we ever hid. */
  function unhideAll() {
    Object.values(FEATURE).forEach(unhideFeature);
  }

  /* -------------------------------------------------------------------------
   * Text-node scanning core (resilient to Tailwind churn)
   * ---------------------------------------------------------------------- */

  function elementScope(root) {
    if (!root) return document;
    if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE) {
      return root;
    }
    return root.parentElement || document;
  }

  /** Walk every meaningful text node under `root`, calling `callback(node)`. */
  function forEachTextNode(root, callback) {
    const walkerRoot = elementScope(root);
    if (
      !walkerRoot ||
      (walkerRoot.nodeType !== Node.ELEMENT_NODE &&
        walkerRoot.nodeType !== Node.DOCUMENT_NODE)
    ) {
      return;
    }

    const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node = walker.nextNode();
    while (node) {
      callback(node);
      node = walker.nextNode();
    }
  }

  /** Climb upward while each parent's trimmed text equals `text`. */
  function climbWhileTextEquals(el, text) {
    let target = el;
    while (
      target.parentElement &&
      target.parentElement !== document.body &&
      target.parentElement.textContent.trim() === text
    ) {
      target = target.parentElement;
    }
    return target;
  }

  /* -------------------------------------------------------------------------
   * Feature: Difficulty Blindfold
   *
   * Works across every LeetCode surface (problem-page pill, problemset table,
   * sidebar / contest / favorite lists). To avoid breaking the difficulty
   * FILTER dropdown, badge detection requires a genuine "badge" signal (a
   * difficulty / color class) and skips interactive menu/listbox controls.
   * Problem-list rows are handled separately by scanProblemRows().
   * ---------------------------------------------------------------------- */

  /** Canonicalize difficulty text ("Med." -> "Medium"); '' if not difficulty. */
  function normalizeDifficulty(text) {
    const t = (text || '').trim().replace(/\.+$/, '');
    if (/^easy$/i.test(t)) return 'Easy';
    if (/^med(ium)?$/i.test(t)) return 'Medium';
    if (/^hard$/i.test(t)) return 'Hard';
    return '';
  }

  /** True when `el` sits inside an interactive menu/filter control. */
  function inInteractiveMenu(el) {
    return !!(
      el.closest &&
      el.closest(
        '[role="menu"],[role="listbox"],[role="menuitem"],[role="option"],' +
          '[role="combobox"],select,' +
          '[aria-haspopup="menu"],[aria-haspopup="listbox"]'
      )
    );
  }

  /** True when `el` (or a near ancestor) carries a difficulty/color class hint. */
  function hasDifficultyClassHint(el) {
    let cur = el;
    for (let i = 0; i < 3 && cur && cur.getAttribute; i += 1) {
      const cls = cur.getAttribute('class') || '';
      if (/difficulty|text-olive|text-yellow|text-pink/i.test(cls)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function scanDifficultyBadges(root) {
    // Strategy A — difficulty text on elements that look like real badges.
    forEachTextNode(root, (node) => {
      if (!normalizeDifficulty(node.nodeValue)) return;
      const el = node.parentElement;
      if (!el || inInteractiveMenu(el) || !hasDifficultyClassHint(el)) return;
      hideElement(climbWhileTextEquals(el, node.nodeValue.trim()), FEATURE.difficulty);
    });

    // Strategy B — class-based fallback for badges with a "difficulty" hook.
    const scope = elementScope(root);
    if (scope && scope.querySelectorAll) {
      let badges;
      try {
        badges = scope.querySelectorAll('[class*="difficulty" i]');
      } catch (_err) {
        badges = scope.querySelectorAll('[class*="difficulty"]');
      }
      badges.forEach((el) => {
        if (inInteractiveMenu(el)) return;
        if (normalizeDifficulty(el.textContent)) hideElement(el, FEATURE.difficulty);
      });
    }
  }

  /* -------------------------------------------------------------------------
   * Problem-list rows (problemset, sidebars, contest lists, favorites)
   *
   * Every list row contains a link to /problems/<slug>; the difficulty word
   * and the acceptance percentage live in sibling cells of that link. We
   * blindfold both, scoped to the row, so unrelated UI is never touched and
   * the difficulty filter dropdown stays usable.
   * ---------------------------------------------------------------------- */

  /** Climb from a problem link to the bounded row that holds its stats. */
  function findProblemRow(anchor) {
    let cur = anchor.parentElement;
    let best = null;
    for (let i = 0; i < 8 && cur; i += 1) {
      const text = cur.textContent || '';
      if (text.length > 600) break; // a whole table/list is far larger than a row
      if (/%/.test(text)) best = cur; // the row carries the acceptance percentage
      cur = cur.parentElement;
    }
    return best || anchor.parentElement;
  }

  function scanProblemRows(root) {
    const scope = elementScope(root);
    if (!scope || !scope.querySelectorAll) return;
    const wantDiff = currentSettings.hideDifficulty;
    const wantAcc = currentSettings.hideAcceptance;
    if (!wantDiff && !wantAcc) return;

    scope.querySelectorAll('a[href*="/problems/"]').forEach((anchor) => {
      const row = findProblemRow(anchor);
      if (!row) return;
      forEachTextNode(row, (node) => {
        const value = node.nodeValue.trim();
        const el = node.parentElement;
        if (!el) return;
        if (wantDiff && normalizeDifficulty(value) && !inInteractiveMenu(el)) {
          hideElement(climbWhileTextEquals(el, value), FEATURE.difficulty);
        } else if (wantAcc && PERCENT_RE.test(value)) {
          hideElement(el, FEATURE.stat);
        }
      });
    });
  }

  /* -------------------------------------------------------------------------
   * Feature: Acceptance & Stats Blindfold (problem page)
   * ---------------------------------------------------------------------- */

  /**
   * Anchor on the unambiguous "Acceptance Rate" label, then climb to the
   * stats group that also contains "Accepted"/"Submissions" so the whole
   * Accepted / Submissions / Acceptance Rate block disappears in one shot.
   * Anchoring on "Acceptance Rate" (never the bare word "Accepted") avoids
   * accidentally hiding the green "Accepted" submission verdict.
   */
  function scanStatsBlock(root) {
    forEachTextNode(root, (node) => {
      const value = node.nodeValue.trim();
      if (value !== 'Acceptance Rate' && !/^Acceptance Rate\b/.test(value)) return;
      const el = node.parentElement;
      if (!el) return;
      hideElement(findStatsGroup(el), FEATURE.stat);
    });
  }

  function findStatsGroup(labelEl) {
    let cur = labelEl;
    let best = labelEl;
    for (let i = 0; i < 6 && cur; i += 1) {
      const text = cur.textContent || '';
      if (text.length > 400) break; // stay bounded — never hide the whole pane
      if (/Submissions/.test(text) || /Accepted/.test(text)) best = cur;
      cur = cur.parentElement;
    }
    return best;
  }

  /* -------------------------------------------------------------------------
   * Feature: Acceptance everywhere — global bare-percentage sweep
   *
   * The problem page's "Acceptance Rate" block is handled by scanStatsBlock and
   * list rows by scanProblemRows, but acceptance also surfaces as a bare
   * percentage in the problemset table, sidebars and tooltips. To guarantee it
   * is hidden EVERYWHERE we sweep every standalone percentage text node,
   * skipping only the code editor (where a percentage may be legitimate input).
   * ---------------------------------------------------------------------- */

  /** True when `el` lives inside the code editor / an editable surface. */
  function inEditor(el) {
    return !!(
      el.closest &&
      el.closest(
        '.monaco-editor,[class*="monaco" i],[class*="codemirror" i],' +
          'textarea,[contenteditable="true"],[role="textbox"]'
      )
    );
  }

  function scanAcceptance(root) {
    forEachTextNode(root, (node) => {
      const value = node.nodeValue.trim();
      if (!PERCENT_RE.test(value)) return;
      const el = node.parentElement;
      if (!el || inEditor(el)) return;
      hideElement(el, FEATURE.stat);
    });
  }

  /* -------------------------------------------------------------------------
   * Feature: Social Metrics Cleanse
   *
   * Social counters (up/down votes, comments, solution counts, favorites) are
   * rendered as small "icon + number" controls. We hide the numeric portion of
   * any button/link that pairs an SVG icon with a numeric badge, plus explicit
   * vote/like/solutions hooks. This is class-agnostic and survives Tailwind
   * churn.
   * ---------------------------------------------------------------------- */

  /** Hide every numeric-badge text node inside `el`. */
  function hideNumbersIn(el) {
    forEachTextNode(el, (node) => {
      if (NUMERIC_BADGE_RE.test(node.nodeValue.trim()) && node.parentElement) {
        hideElement(node.parentElement, FEATURE.social);
      }
    });
  }

  function scanSocial(root) {
    const scope = elementScope(root);
    if (!scope || !scope.querySelectorAll) return;

    // (a) Icon + count controls (votes, comments, favorites, solution counts).
    scope.querySelectorAll('button,a,[role="button"]').forEach((ctrl) => {
      if (ctrl.querySelector && ctrl.querySelector('svg')) hideNumbersIn(ctrl);
    });

    // (b) Explicit hooks — solutions/discussion links and vote/like containers.
    const hooks =
      'a[href*="/solutions/"],a[href*="/discuss"],' +
      '[aria-label*="upvote" i],[aria-label*="downvote" i],' +
      '[aria-label*="vote" i],[aria-label*="like" i],' +
      '[class*="vote" i],[class*="like" i]';
    let hookEls;
    try {
      hookEls = scope.querySelectorAll(hooks);
    } catch (_err) {
      hookEls = [];
    }
    hookEls.forEach(hideNumbersIn);
  }

  /* -------------------------------------------------------------------------
   * Feature: Topics Blindfold
   *
   * Hides the "Topics" section everywhere it appears — the collapsible Topics
   * accordion on a problem page and the topic-tag filter bar / tag chips on the
   * problemset and elsewhere. We anchor on the literal "Topics" (or "Related
   * Topics") label, then climb to the self-contained block that leads with that
   * label so the whole section disappears in one shot, without swallowing
   * neighbouring sections (Companies, Hint, Similar Questions, etc.).
   * ---------------------------------------------------------------------- */

  /** Sibling section labels we must never climb into when hiding Topics. */
  const TOPIC_NEIGHBOUR_RE =
    /Companies|Similar Questions|Hint|Discussion|Submissions|Solution/;

  /** Climb to the bounded block that leads with the "Topics" label. */
  function topicContainer(headerEl) {
    let best = climbWhileTextEquals(headerEl, headerEl.textContent.trim());
    let cur = best;
    for (let i = 0; i < 5 && cur && cur.parentElement; i += 1) {
      const parent = cur.parentElement;
      if (parent === document.body) break;
      const text = (parent.textContent || '').trim();
      if (text.length > 800) break;
      if (
        (/^Topics\b/.test(text) || /^Related Topics\b/.test(text)) &&
        !TOPIC_NEIGHBOUR_RE.test(text)
      ) {
        best = parent;
        cur = parent;
      } else {
        break;
      }
    }
    return best;
  }

  function scanTopics(root) {
    forEachTextNode(root, (node) => {
      const value = node.nodeValue.trim();
      if (value !== 'Topics' && value !== 'Related Topics') return;
      const el = node.parentElement;
      if (!el || inInteractiveMenu(el) || inEditor(el)) return;
      hideElement(topicContainer(el), FEATURE.topic);
    });
  }

  /* -------------------------------------------------------------------------
   * Feature: Run Limit (problem page)
   *
   * Caps how many times the user may press the editor's "Run" button before
   * they must Submit. Each run increments a per-problem counter (persisted to
   * storage so a page reload can't bypass the cap); once the counter reaches
   * the configured maximum the Run button is made unclickable and a hover
   * tooltip explains why. Pressing Submit clears the counter so the next
   * attempt cycle starts fresh.
   * ---------------------------------------------------------------------- */

  /** The current problem slug, or null when not on a problem page. */
  function problemSlug() {
    const m = location.pathname.match(/\/problems\/([^/]+)/);
    return m ? m[1] : null;
  }

  /** True when the run-limit guard should be enforcing right now. */
  function runLimitActive() {
    return !!(
      currentSettings.modeEnabled &&
      currentSettings.runLimit.enabled &&
      problemSlug()
    );
  }

  function getRunCount(slug) {
    const n = parseInt(runCounts[slug], 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function setRunCount(slug, value) {
    runCounts[slug] = Math.max(0, value);
    persistRunCounts();
  }

  function resetRunCount(slug) {
    if (runCounts[slug]) {
      delete runCounts[slug];
      persistRunCounts();
    }
  }

  function loadRunCounts() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(RUN_COUNTS_KEY, (res) => {
          const stored = res && res[RUN_COUNTS_KEY];
          resolve(stored && typeof stored === 'object' ? stored : {});
        });
      } catch (_err) {
        resolve({});
      }
    });
  }

  function persistRunCounts() {
    try {
      chrome.storage.local.set({ [RUN_COUNTS_KEY]: runCounts });
    } catch (_err) {
      /* no-op */
    }
  }

  /** Locate LeetCode's editor "Run" button (locale-agnostic fallbacks). */
  function findRunButton() {
    const direct = document.querySelector('[data-e2e-locator="console-run-button"]');
    if (direct) return direct;
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text === 'Run' || text === 'Run Code' || text === '\u8fd0\u884c') return btn;
    }
    return null;
  }

  /** Locate LeetCode's "Submit" button. */
  function findSubmitButton() {
    const direct = document.querySelector(
      '[data-e2e-locator="console-submit-button"]'
    );
    if (direct) return direct;
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text === 'Submit' || text === '\u63d0\u4ea4') return btn;
    }
    return null;
  }

  function runTooltipText() {
    const max = currentSettings.runLimit.maxRuns;
    return (
      'Maximum of ' + max + ' code run' + (max === 1 ? '' : 's') +
      ' reached. Submit to continue.'
    );
  }

  function ensureRunTooltip() {
    let tip = document.getElementById(RUN_TOOLTIP_ID);
    if (!tip) {
      tip = document.createElement('div');
      tip.id = RUN_TOOLTIP_ID;
      tip.className = 'cleanslate-run-tooltip';
      (document.body || document.documentElement).appendChild(tip);
    }
    return tip;
  }

  function showRunTooltip(btn) {
    if (!btn) return;
    const tip = ensureRunTooltip();
    tip.textContent = runTooltipText();
    const rect = btn.getBoundingClientRect();
    tip.style.left = rect.left + rect.width / 2 + 'px';
    tip.style.top = rect.bottom + 8 + 'px';
    tip.classList.add('is-visible');
  }

  function hideRunTooltip() {
    const tip = document.getElementById(RUN_TOOLTIP_ID);
    if (tip) tip.classList.remove('is-visible');
  }

  /** Reflect the blocked/allowed state onto the Run button. */
  function applyRunButtonState(runBtn) {
    const btn = runBtn || findRunButton();
    if (!btn) return;
    const blocked =
      runLimitActive() &&
      getRunCount(problemSlug()) >= currentSettings.runLimit.maxRuns;
    if (blocked) {
      btn.classList.add(RUN_BLOCK_CLASS);
      btn.setAttribute('aria-disabled', 'true');
    } else {
      btn.classList.remove(RUN_BLOCK_CLASS);
      btn.removeAttribute('aria-disabled');
      hideRunTooltip();
    }
  }

  /** Run-button click guard: count an allowed run, or block once at the cap. */
  function onRunButtonClick(e) {
    if (!runLimitActive()) return;
    const slug = problemSlug();
    if (getRunCount(slug) >= currentSettings.runLimit.maxRuns) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showRunTooltip(e.currentTarget);
      return;
    }
    setRunCount(slug, getRunCount(slug) + 1);
    applyRunButtonState(e.currentTarget);
  }

  function onRunButtonEnter(e) {
    if (e.currentTarget.classList.contains(RUN_BLOCK_CLASS)) {
      showRunTooltip(e.currentTarget);
    }
  }

  /** Submitting clears the run counter so the next attempt cycle is fresh. */
  function onSubmitButtonClick() {
    if (!runLimitActive()) return;
    resetRunCount(problemSlug());
    applyRunButtonState();
  }

  /** Keep keyboard shortcuts (Ctrl/Cmd+' run, Ctrl/Cmd+Enter submit) honest. */
  function onRunLimitKeydown(e) {
    if (!runLimitActive()) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const slug = problemSlug();
    if (e.key === 'Enter') {
      resetRunCount(slug);
      applyRunButtonState();
      return;
    }
    if (e.key === "'" || e.code === 'Quote') {
      if (getRunCount(slug) >= currentSettings.runLimit.maxRuns) {
        e.preventDefault();
        e.stopImmediatePropagation();
        showRunTooltip(findRunButton());
      } else {
        setRunCount(slug, getRunCount(slug) + 1);
        applyRunButtonState();
      }
    }
  }

  /** Bind guards to the Run/Submit buttons (idempotent) and paint state. */
  function enforceRunLimit() {
    if (!runLimitActive()) return;
    const runBtn = findRunButton();
    if (runBtn && runBtn.getAttribute('data-cs-run-bound') !== '1') {
      runBtn.setAttribute('data-cs-run-bound', '1');
      runBtn.addEventListener('click', onRunButtonClick, true);
      runBtn.addEventListener('mouseenter', onRunButtonEnter);
      runBtn.addEventListener('mouseleave', hideRunTooltip);
    }
    const submitBtn = findSubmitButton();
    if (submitBtn && submitBtn.getAttribute('data-cs-submit-bound') !== '1') {
      submitBtn.setAttribute('data-cs-submit-bound', '1');
      submitBtn.addEventListener('click', onSubmitButtonClick, true);
    }
    applyRunButtonState(runBtn);
  }

  /** Remove all run-limit visuals (feature disabled / master switch off). */
  function clearRunLimit() {
    const runBtn = findRunButton();
    if (runBtn) {
      runBtn.classList.remove(RUN_BLOCK_CLASS);
      runBtn.removeAttribute('aria-disabled');
    }
    hideRunTooltip();
  }

  /* -------------------------------------------------------------------------
   * Orchestration — scan only the features that are currently enabled
   * ---------------------------------------------------------------------- */

  function scan(root) {
    if (!currentSettings.modeEnabled) return;
    const run = (fn) => {
      try {
        fn(root);
      } catch (_err) {
        /* one brittle feature must never break the others */
      }
    };
    if (currentSettings.hideDifficulty) run(scanDifficultyBadges);
    if (currentSettings.hideAcceptance) {
      run(scanStatsBlock);
      run(scanAcceptance);
    }
    if (currentSettings.hideDifficulty || currentSettings.hideAcceptance) {
      run(scanProblemRows);
    }
    if (currentSettings.hideSocialMetrics) run(scanSocial);
    if (currentSettings.hideTopics) run(scanTopics);
    if (currentSettings.runLimit.enabled) run(enforceRunLimit);
  }

  /* -------------------------------------------------------------------------
   * Step 4 — MutationObserver guard + SPA route detection
   * ---------------------------------------------------------------------- */

  function setupObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        scheduleFullRescan();
        return;
      }
      for (const mutation of mutations) {
        const added = mutation.addedNodes;
        if (!added || !added.length) continue;
        added.forEach((n) => {
          if (n.nodeType === Node.ELEMENT_NODE) scan(n);
        });
      }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function scheduleFullRescan() {
    if (rescanScheduled) return;
    rescanScheduled = true;
    const run = () => {
      rescanScheduled = false;
      scan(document.body || document.documentElement);
      // The timer is only valid on a problem page, so re-evaluate on every
      // SPA route change (e.g. leaving a problem for /problemset).
      renderTimer();
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 500 });
    } else {
      window.setTimeout(run, 150);
    }
  }

  function watchUrlChanges() {
    const fire = () => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        scheduleFullRescan();
      }
    };
    ['pushState', 'replaceState'].forEach((method) => {
      const original = history[method];
      if (typeof original === 'function') {
        history[method] = function patched() {
          const result = original.apply(this, arguments);
          try {
            fire();
          } catch (_err) {
            /* no-op */
          }
          return result;
        };
      }
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
  }

  /* -------------------------------------------------------------------------
   * Interview timer overlay — manual Start / Pause / Reset (never auto-starts)
   * ---------------------------------------------------------------------- */

  function durationMs() {
    return currentSettings.interviewTimer.durationMinutes * 60 * 1000;
  }

  function renderTimer() {
    const wantTimer =
      currentSettings.modeEnabled &&
      currentSettings.interviewTimer.enabled &&
      !!problemSlug();
    let panel = document.getElementById(TIMER_ID);

    if (!wantTimer) {
      teardownTimer();
      if (panel) panel.remove();
      return;
    }

    if (!panel) {
      panel = document.createElement('div');
      panel.id = TIMER_ID;
      panel.className = 'cleanslate-timer';
      panel.innerHTML =
        '<span class="cleanslate-timer__dot" aria-hidden="true"></span>' +
        '<span class="cleanslate-timer__time" data-role="time">--:--</span>' +
        '<button class="cleanslate-timer__btn cleanslate-timer__btn--primary" ' +
        'data-role="toggle" type="button">Start</button>' +
        '<button class="cleanslate-timer__btn" data-role="reset" type="button" ' +
        'title="Reset timer">Reset</button>';
      (document.body || document.documentElement).appendChild(panel);
      panel.querySelector('[data-role="toggle"]').addEventListener('click', toggleTimer);
      panel.querySelector('[data-role="reset"]').addEventListener('click', resetTimer);
      makeTimerDraggable(panel);

      // Restore the last dragged position (if the user moved it before).
      if (timerPosition) {
        panel.style.right = 'auto';
        panel.style.left = timerPosition.left + 'px';
        panel.style.top = timerPosition.top + 'px';
      }

      // Initialize idle — the countdown only begins when the user hits Start.
      timerState.running = false;
      timerState.endTimestamp = null;
      timerState.remainingMs = durationMs();
    }

    paintTimer();
  }

  /** Make the timer panel draggable by its body (buttons stay clickable). */
  function makeTimerDraggable(panel) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
      const left = Math.min(Math.max(0, e.clientX - offsetX), maxLeft);
      const top = Math.min(Math.max(0, e.clientY - offsetY), maxTop);
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      timerPosition = { left: left, top: top };
    };

    const onUp = () => {
      dragging = false;
      panel.classList.remove('cleanslate-timer--dragging');
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    };

    panel.addEventListener('mousedown', (e) => {
      // Left button only, and never start a drag from the control buttons.
      if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) {
        return;
      }
      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      dragging = true;
      panel.classList.add('cleanslate-timer--dragging');
      // Switch from the default top/right anchoring to absolute left/top.
      panel.style.right = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      e.preventDefault();
    });
  }

  /** Start ⇄ Pause from the primary button; restarts when already expired. */
  function toggleTimer() {
    if (timerState.running) {
      pauseTimer();
      return;
    }
    if (timerState.remainingMs <= 0) timerState.remainingMs = durationMs();
    startTimer();
  }

  function startTimer() {
    timerState.running = true;
    timerState.endTimestamp = Date.now() + timerState.remainingMs;
    if (timerState.intervalId) clearInterval(timerState.intervalId);
    timerState.intervalId = window.setInterval(onTick, 250);
    onTick();
  }

  function pauseTimer() {
    if (timerState.endTimestamp) {
      timerState.remainingMs = Math.max(0, timerState.endTimestamp - Date.now());
    }
    timerState.running = false;
    timerState.endTimestamp = null;
    if (timerState.intervalId) {
      clearInterval(timerState.intervalId);
      timerState.intervalId = null;
    }
    paintTimer();
  }

  function resetTimer() {
    timerState.running = false;
    timerState.endTimestamp = null;
    timerState.remainingMs = durationMs();
    if (timerState.intervalId) {
      clearInterval(timerState.intervalId);
      timerState.intervalId = null;
    }
    paintTimer();
  }

  function teardownTimer() {
    timerState.running = false;
    timerState.endTimestamp = null;
    timerState.remainingMs = 0;
    if (timerState.intervalId) {
      clearInterval(timerState.intervalId);
      timerState.intervalId = null;
    }
  }

  function onTick() {
    if (timerState.running && timerState.endTimestamp) {
      timerState.remainingMs = Math.max(0, timerState.endTimestamp - Date.now());
      if (timerState.remainingMs <= 0) {
        timerState.running = false;
        timerState.endTimestamp = null;
        if (timerState.intervalId) {
          clearInterval(timerState.intervalId);
          timerState.intervalId = null;
        }
      }
    }
    paintTimer();
  }

  /** Render the current timer state onto the panel (time, button, dot). */
  function paintTimer() {
    const panel = document.getElementById(TIMER_ID);
    if (!panel) return;
    const timeEl = panel.querySelector('[data-role="time"]');
    const toggleBtn = panel.querySelector('[data-role="toggle"]');

    const remaining = Math.max(0, timerState.remainingMs);
    const expired = remaining <= 0;
    const totalSeconds = Math.floor(remaining / 1000);
    const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const ss = String(totalSeconds % 60).padStart(2, '0');

    if (timeEl) timeEl.textContent = expired ? "Time's up" : mm + ':' + ss;
    if (toggleBtn) {
      toggleBtn.textContent = timerState.running
        ? 'Pause'
        : expired
          ? 'Restart'
          : 'Start';
    }

    panel.classList.toggle('cleanslate-timer--running', timerState.running);
    panel.classList.toggle('cleanslate-timer--expired', expired);
  }

  /* -------------------------------------------------------------------------
   * Live settings sync — react to popup changes without a reload
   * ---------------------------------------------------------------------- */

  function watchSettingsChanges() {
    if (!chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      // Keep run counts in sync across tabs of the same problem.
      if (changes[RUN_COUNTS_KEY]) {
        const nv = changes[RUN_COUNTS_KEY].newValue;
        runCounts = nv && typeof nv === 'object' ? nv : {};
        applyRunButtonState();
      }

      if (!changes[STORAGE_KEY]) return;

      const prev = currentSettings;
      currentSettings = mergeSettings(changes[STORAGE_KEY].newValue);

      if (!currentSettings.modeEnabled) {
        unhideAll();
      } else {
        // Reveal features that were just switched off.
        if (prev.hideDifficulty && !currentSettings.hideDifficulty) {
          unhideFeature(FEATURE.difficulty);
        }
        if (prev.hideAcceptance && !currentSettings.hideAcceptance) {
          unhideFeature(FEATURE.stat);
        }
        if (prev.hideSocialMetrics && !currentSettings.hideSocialMetrics) {
          unhideFeature(FEATURE.social);
        }
        if (prev.hideTopics && !currentSettings.hideTopics) {
          unhideFeature(FEATURE.topic);
        }
        // Hide features that were just switched on (or refreshed).
        scan(document.body || document.documentElement);
      }

      if (
        prev.interviewTimer.durationMinutes !==
        currentSettings.interviewTimer.durationMinutes
      ) {
        resetTimer();
      }
      renderTimer();

      // Apply or tear down the run-limit guard after the change.
      if (runLimitActive()) {
        enforceRunLimit();
      } else {
        clearRunLimit();
      }
    });
  }

  /* -------------------------------------------------------------------------
   * Theme detection — mirror LeetCode's light/dark mode into storage so the
   * popup (which can't see the page) can match it.
   * ---------------------------------------------------------------------- */

  function detectTheme() {
    const el = document.documentElement;
    if (el.classList.contains('dark')) return 'dark';
    if (el.classList.contains('light')) return 'light';
    const dataTheme = (
      el.getAttribute('data-theme') ||
      (document.body && document.body.getAttribute('data-theme')) ||
      ''
    ).toLowerCase();
    if (dataTheme === 'dark') return 'dark';
    if (dataTheme === 'light') return 'light';
    try {
      const stored = (localStorage.getItem('theme') || '').toLowerCase();
      if (stored === 'dark') return 'dark';
      if (stored === 'light') return 'light';
    } catch (_err) {
      /* localStorage may be unavailable */
    }
    return 'light';
  }

  function syncTheme() {
    const theme = detectTheme();
    if (theme === lastTheme) return;
    lastTheme = theme;
    try {
      chrome.storage.local.set({ [THEME_KEY]: theme });
    } catch (_err) {
      /* no-op */
    }
  }

  function watchTheme() {
    syncTheme();
    try {
      const themeObserver = new MutationObserver(syncTheme);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme']
      });
      if (document.body) {
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'data-theme']
        });
      }
    } catch (_err) {
      /* no-op */
    }
  }

  /* -------------------------------------------------------------------------
   * Bootstrap
   * ---------------------------------------------------------------------- */

  async function init() {
    currentSettings = await loadSettings();
    runCounts = await loadRunCounts();
    document.addEventListener('keydown', onRunLimitKeydown, true);

    const doInitialScan = () => {
      scan(document.body || document.documentElement);
      setupObserver();
      watchUrlChanges();
      watchTheme();
      renderTimer();
      unveil();
      // A couple of delayed sweeps catch late client-side renders without a
      // permanent polling loop.
      window.setTimeout(() => scan(document.body || document.documentElement), 600);
      window.setTimeout(() => scan(document.body || document.documentElement), 1500);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', doInitialScan, { once: true });
    } else {
      doInitialScan();
    }

    watchSettingsChanges();
  }

  injectBootBlocker();
  init();
})();
