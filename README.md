<div align="center">

<img src="assets/onsite.png" alt="Onsite logo" width="128" height="128" />

# Onsite

### Practice LeetCode the way a real on-site interview feels

_A Chrome (Manifest V3) extension that strips the gamified meta-indicators from
LeetCode — difficulty badges, acceptance stats, topic tags, and social metrics —
so all that's left is the problem, the constraints, and your reasoning._

<p>
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-FFA116?style=flat-square" />
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Chromium-FF8A00?style=flat-square" />
  <img alt="Permissions" src="https://img.shields.io/badge/Permissions-storage%20only-00B8A3?style=flat-square" />
  <img alt="Version" src="https://img.shields.io/badge/Version-1.0.0-FF375F?style=flat-square" />
</p>

</div>

---

Onsite blindfolds difficulty badges, acceptance/submission statistics, topic
tags, and social metrics, while optionally capping how many times you can run
your code before submitting and running a draggable interview countdown timer.

---

## Features

| ID | Feature | What it does |
| --- | --- | --- |
| FE-01 | **Difficulty Blindfold** | Hides Easy / Medium / Hard badges and their color coding. |
| FE-02 | **Acceptance & Stats** | Hides the Accepted / Submissions / Acceptance Rate block. |
| FE-04 | **Social Cleanse** | Hides solution counts, upvotes/downvotes, and discussion replies. |
| FE-05 | **Topics Blindfold** | Hides the Topics section/accordion and topic-tag filter chips. |
| — | **Run Limit** | Caps how many times you can Run before you must Submit. |
| — | **Interview Timer** | Optional countdown overlay with manual Start / Pause / Reset. |

All features toggle independently from the popup, with a master on/off switch.

**Works everywhere on LeetCode** — the individual problem page, the `/problemset`
table, the in-problem sidebar list, contest problem lists, and favorites. List
rows are detected via their `/problems/<slug>` link, so difficulty and acceptance
are blindfolded per row while the difficulty **filter dropdown stays usable**.

### Run Limit

Enable **Code runs allowed** in the popup and set a maximum (1–10, default 3).
Each press of the editor's **Run** button — and the `Ctrl/Cmd + '` keyboard
shortcut — counts against that cap. Once the cap is reached the Run button is
greyed out and unclickable, with a hover tooltip explaining why; the count is
persisted per problem so a page reload can't bypass it. Pressing **Submit**
(button or `Ctrl/Cmd + Enter`) clears the counter so the next attempt starts
fresh.

---

## Install (unpacked / developer mode)

1. Open `chrome://extensions` in a Chromium browser (Chrome, Edge, Brave…).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `leetcode-cleanslate/` folder.
4. Visit a LeetCode problem — the workspace loads pre-cleansed.
5. Click the extension icon to adjust settings; changes apply live, no reload.

---

## How it works

The engine follows a strict lifecycle (PRD §4) designed to eliminate any flash of
unblindfolded content:

1. **`document_start`** — inject a FOUC boot blocker that hides the page body
   until the first blindfold pass completes.
2. **Config resolve** — read `chrome.storage.local.settings` with safe defaults.
3. **Scan & blindfold** — tag matched elements and toggle a reversible inline
   `display:none !important` on them.
4. **MutationObserver guard** — continuously blindfold asynchronously rendered
   React nodes and re-scan on SPA route changes (Next/Previous problem).
5. **Unveil** — drop the boot blocker.

### Resilience guardrails

- **Text-node first detection.** Targets are found by scanning text content with a
  `TreeWalker` (e.g. the literal words `Easy`/`Medium`/`Hard`, `Acceptance Rate`).
  This survives LeetCode's frequent Tailwind utility-class revisions; class /
  attribute selectors are only secondary fallbacks.
- **React-safe & reliable hiding.** The extension never calls `element.remove()` or
  alters the structural tree. It only toggles a reversible inline
  `display:none !important` (tagged via `data-cs-hidden`), which beats any Tailwind
  rule regardless of stylesheet load order and never desyncs React's reconciler.
- **Bounded climbing.** When hiding a badge or stat block, the code climbs only as
  far as an ancestor that still wraps that specific content, so surrounding layout
  is never collateral.

---

## Project structure

```
leetcode-cleanslate/
├── manifest.json        # MV3 manifest (content script @ document_start)
├── popup.html           # Control panel markup
├── popup.css            # Control panel styling
├── popup.js             # Loads/saves settings to chrome.storage.local
├── assets/
│   └── onsite.png       # Extension logo
├── scripts/
│   ├── content.js       # The Interview Mode Engine
│   └── styles.css       # Static styles: FOUC blocker + timer overlay
├── LICENSE
└── README.md
```

## Settings schema (`chrome.storage.local`)

```json
{
  "settings": {
    "modeEnabled": true,
    "hideDifficulty": true,
    "hideAcceptance": true,
    "hideSocialMetrics": true,
    "hideTopics": true,
    "interviewTimer": { "enabled": false, "durationMinutes": 45 },
    "runLimit": { "enabled": false, "maxRuns": 3 }
  },
  "runCounts": { "two-sum": 2 }
}
```

`runCounts` is maintained automatically by the Run Limit feature — one entry per
problem slug — and is reset for a problem when you submit it.

---

## Privacy

The extension requests only the `storage` permission and runs solely on LeetCode
hosts. It makes **no network requests** and collects **no data** — all settings
live locally in your browser.

---

## License

Proprietary and source-available for evaluation only. All rights reserved. See
[LICENSE](LICENSE) for the full terms — no use, copying, modification, or
distribution is permitted without prior written permission from the copyright
holder.

**Version:** 1.0.0
