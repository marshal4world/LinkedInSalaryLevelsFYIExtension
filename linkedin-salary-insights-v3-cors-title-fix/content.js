// ─── LinkedIn Salary Insights — content.js (v3) ──────────────────────────────
const WIDGET_ID = "lvl-salary-widget";
console.log("[LvlSalary] v3 loaded on", location.href);

// ── Extract job title + company ───────────────────────────────────────────────
function extractJobInfo() {
  // ── Method 1: parse document.title ──────────────────────────────────────
  // LinkedIn sets: "Job Title at Company | LinkedIn"
  // or "(1) Job Title at Company | LinkedIn"
  const rawPageTitle = document.title || "";
  const cleanTitle = rawPageTitle.replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*LinkedIn\s*$/, "").trim();
  const atMatch = cleanTitle.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) {
    const rawTitle = atMatch[1].trim();
    const company  = atMatch[2].trim();
    console.log("[LvlSalary] Method 1 (document.title):", { rawTitle, company });
    return { rawTitle, company };
  }

  // ── Method 2: h1, h2, h3 anywhere ───────────────────────────────────────
  for (const tag of ["h1", "h2", "h3"]) {
    const el = document.querySelector(tag);
    if (el?.textContent?.trim()) {
      const rawTitle = el.textContent.trim();
      // Find company via a[href*="/company/"]
      const companyLink = document.querySelector('a[href*="/company/"]');
      const company = companyLink?.textContent?.split("\n")[0].trim();
      if (company) {
        console.log("[LvlSalary] Method 2 (" + tag + "):", { rawTitle, company });
        return { rawTitle, company };
      }
    }
  }

  // ── Method 3: job ID in URL -> ask the background worker for LinkedIn HTML
  const jobIdMatch = location.pathname.match(/\/jobs\/view\/(\d+)/);
  if (jobIdMatch) {
    console.log("[LvlSalary] Method 3: have job ID", jobIdMatch[1], "— will ask background worker");
    return "NEED_ASYNC"; // signal to caller
  }

  console.log("[LvlSalary] All extraction methods failed");
  return null;
}

async function extractJobInfoAsync(jobId) {
  try {
    const { html } = await sendToBackground({ type: "FETCH_LINKEDIN_JOB", jobId });
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const rawTitle = tmp.querySelector("h2")?.textContent?.trim() ||
                     tmp.querySelector("h1")?.textContent?.trim();
    const company  = tmp.querySelector(".topcard__org-name-link, .topcard__flavor--black-link")
                        ?.textContent?.trim();
    if (rawTitle && company) {
      console.log("[LvlSalary] Method 3 (job API):", { rawTitle, company });
      return { rawTitle, company };
    }
  } catch (e) {
    console.log("[LvlSalary] Job API request failed:", e.message);
  }
  return null;
}

function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Background request failed"));
        return;
      }
      resolve(response);
    });
  });
}

// ── Find where to insert the widget ──────────────────────────────────────────
function findInsertionPoint() {
  // Try headings first
  for (const tag of ["h1", "h2", "h3"]) {
    const el = document.querySelector(tag);
    if (el?.textContent?.trim()) {
      // Walk up to find a meaningful container
      let node = el.parentElement;
      for (let i = 0; i < 6 && node; i++) {
        if (node.parentElement && node.children.length <= 6) return node;
        node = node.parentElement;
      }
      return el.parentElement;
    }
  }
  // Fallback: after the first <main> child
  const main = document.querySelector("main");
  if (main?.firstElementChild) return main.firstElementChild;
  return document.body.firstElementChild;
}

// ── Levels.fyi data request ──────────────────────────────────────────────────
async function loadSalaries(company, title) {
  try {
    const result = await sendToBackground({ type: "FETCH_LEVELS_SALARIES", company, title });
    logSalaryDiagnostics(result);
    return result;
  } catch (e) {
    const result = { entries: null, error: e.message, diagnostics: [] };
    logSalaryDiagnostics(result);
    return result;
  }
}

function logSalaryDiagnostics(result) {
  const diagnostics = result?.diagnostics || [];
  const rows = diagnostics.map(item => ({
    kind: item.kind,
    status: item.status || "",
    ok: item.ok === undefined ? "" : item.ok,
    entries: item.entries === undefined ? "" : item.entries,
    error: item.error || "",
    url: item.url,
  }));

  console.groupCollapsed("[LvlSalary] levels.fyi request diagnostics");
  if (rows.length) console.table(rows);
  if (result?.source) console.log("[LvlSalary] Salary data source:", result.source);
  if (result?.error) console.error("[LvlSalary] Salary request failed:", result.error);
  for (const item of diagnostics) {
    if (item.preview) console.log("[LvlSalary] Response preview:", item.preview);
  }
  console.groupEnd();
}

// Keep seniority/level words, but drop team/domain qualifiers and normalize casing.
function normalizeTitle(title) {
  return titleCaseTitle(getCoreTitle(title));
}

function getCoreTitle(title) {
  const withoutSuffix = String(title || "")
    .split(/\s+[-–—]\s+|:/)[0]
    .trim();
  const commaParts = withoutSuffix.split(",").map(part => part.trim()).filter(Boolean);
  if (commaParts.length >= 2 && isSeniorityOnly(commaParts[0]) && looksLikeRole(commaParts[1])) {
    return `${commaParts[0]} ${commaParts[1]}`;
  }
  return commaParts[0] || withoutSuffix;
}

function titleCaseTitle(title) {
  return String(title || "")
    .replace(/[|/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map(normalizeTitleWord)
    .join(" ");
}

function isSeniorityOnly(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .every(word => SENIORITY_WORDS.has(word.toLowerCase()));
}

function looksLikeRole(text) {
  return /\b(engineer|developer|manager|scientist|analyst|designer|recruiter|sales|marketing|finance|architect|consultant|specialist|lead)\b/i.test(text);
}

const SENIORITY_WORDS = new Set([
  "associate",
  "entry",
  "junior",
  "mid",
  "senior",
  "sr",
  "staff",
  "principal",
  "lead",
  "distinguished",
  "fellow",
  "chief",
  "head",
  "director",
  "vp",
  "vice",
  "president",
  "executive",
]);

function normalizeTitleWord(word) {
  const lower = word.toLowerCase();
  const acronyms = {
    ai: "AI",
    api: "API",
    devops: "DevOps",
    ml: "ML",
    qa: "QA",
    sd: "SD",
    sde: "SDE",
    sre: "SRE",
    swe: "SWE",
    ui: "UI",
    ux: "UX",
    ios: "iOS",
  };
  const romanLevels = new Set(["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"]);

  if (acronyms[lower]) return acronyms[lower];
  if (romanLevels.has(lower)) return lower.toUpperCase();
  if (/^[a-z]\d+$/i.test(word)) return word.toUpperCase();

  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function summarise(entries) {
  if (!entries?.length) return null;
  const totals = entries.map(e => {
    const total = moneyValue(e, "totalyearlycompensation", "totalYearlyCompensation", "totalCompensation", "totalcompensation", "totalPay", "total");
    if (total) return total;

    const base = moneyValue(e, "baseSalary", "basesalary", "base");
    const bonus = moneyValue(e, "annualBonus", "bonus");
    const equity = moneyValue(e, "stockGrantValue", "stockgrantvalue", "equityValue", "equity") / (numberValue(e, "vestingYears", "years") || 4);
    return base + bonus + equity;
  }).filter(v => v > 10000).sort((a, b) => a - b);
  if (!totals.length) return null;
  const p = f => totals[Math.floor(totals.length * f)];
  const bases = entries.map(e => moneyValue(e, "baseSalary", "basesalary", "base")).filter(Boolean);
  const avgBase = bases.length ? bases.reduce((s,v)=>s+v,0)/bases.length : 0;
  return { p25: p(0.25), p50: p(0.5), p75: p(0.75), avgBase, count: totals.length };
}

function moneyValue(entry, ...keys) {
  const value = numberValue(entry, ...keys);
  if (!value) return 0;
  return value > 1000 ? value : value * 1000;
}

function numberValue(entry, ...keys) {
  for (const key of keys) {
    const value = entry?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[$,]/g, "").trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

const fmt = n => n ? "$" + Math.round(n/1000) + "k" : "—";
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

// ── Widget HTML ───────────────────────────────────────────────────────────────
function buildWidget({ company, track, stats, levelsUrl, message }) {
  return `<div id="${WIDGET_ID}">
  <div class="lvl-header">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#1a56db"/><path d="M6 17L10 9l4 6 2-4 3 5" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span class="lvl-title">Salary Insights</span>
    <span class="lvl-badge">levels.fyi</span>
    <button class="lvl-close">✕</button>
  </div>
  <div class="lvl-meta">
    <strong>${esc(company)}</strong><span class="lvl-dot">·</span><span>${esc(track)}</span>
    ${stats ? `<span class="lvl-dot">·</span><span class="lvl-count">${stats.count} data points</span>` : ""}
  </div>
  ${stats ? `
  <div class="lvl-stats">
    <div class="lvl-stat"><div class="lvl-stat-label">Median TC</div><div class="lvl-stat-value lvl-blue">${fmt(stats.p50)}</div></div>
    <div class="lvl-stat"><div class="lvl-stat-label">Avg Base</div><div class="lvl-stat-value">${fmt(stats.avgBase)}</div></div>
    <div class="lvl-stat"><div class="lvl-stat-label">P25</div><div class="lvl-stat-value">${fmt(stats.p25)}</div></div>
    <div class="lvl-stat"><div class="lvl-stat-label">P75</div><div class="lvl-stat-value">${fmt(stats.p75)}</div></div>
  </div>` : `<p class="lvl-no-data">${esc(message || "No salary data found on levels.fyi for this role.")}</p>`}
  <a class="lvl-cta" href="${levelsUrl}" target="_blank" rel="noopener">Browse all ${esc(company)} salaries on levels.fyi ↗</a>
</div>`;
}

function buildLoading() {
  return `<div id="${WIDGET_ID}" class="lvl-loading">
  <div class="lvl-header">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#1a56db"/><path d="M6 17L10 9l4 6 2-4 3 5" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span class="lvl-title">Salary Insights</span><span class="lvl-badge">levels.fyi</span>
  </div>
  <div class="lvl-spinner-row"><div class="lvl-spinner"></div><span>Fetching salary data…</span></div>
</div>`;
}

function injectWidget(html, insertAfter) {
  document.getElementById(WIDGET_ID)?.remove();
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const widget = tmp.firstElementChild;
  if (insertAfter?.parentElement) insertAfter.insertAdjacentElement("afterend", widget);
  else document.body.prepend(widget);
  document.getElementById(WIDGET_ID)?.querySelector(".lvl-close")
    ?.addEventListener("click", () => document.getElementById(WIDGET_ID)?.remove());
  console.log("[LvlSalary] Widget injected ✓");
}

// ── Main flow ─────────────────────────────────────────────────────────────────
let lastJobKey = "", running = false;

async function run() {
  if (running) return;
  running = true;
  try {
    let info = extractJobInfo();

    // Async fallback via job API
    if (info === "NEED_ASYNC") {
      const jobId = location.pathname.match(/\/jobs\/view\/(\d+)/)?.[1];
      info = jobId ? await extractJobInfoAsync(jobId) : null;
    }
    if (!info) { running = false; return; }

    const { rawTitle, company } = info;
    const jobKey = `${company}::${rawTitle}`;
    if (jobKey === lastJobKey) { running = false; return; }
    lastJobKey = jobKey;

    const track = normalizeTitle(rawTitle);
    const levelsUrl = `https://www.levels.fyi/company/${encodeURIComponent(company)}/salaries`;

    injectWidget(buildLoading(), findInsertionPoint());
    const salaryResult = await loadSalaries(company, track);
    const stats = summarise(salaryResult.entries);
    if (salaryResult.entries?.length && !stats) {
      console.warn("[LvlSalary] Levels returned rows, but no usable compensation fields were recognized.", salaryResult.entries.slice(0, 3));
    }

    const displayTrack = salaryResult.matchedLevelName ? `${track} (${salaryResult.matchedLevelName})` : track;
    const finalLevelsUrl = salaryResult.matchedLevelUrl || levelsUrl;

    injectWidget(buildWidget({
      company,
      track: displayTrack,
      stats,
      levelsUrl: finalLevelsUrl,
      message: getSalaryMessage(salaryResult, stats),
    }), findInsertionPoint());
  } finally { running = false; }
}

function getSalaryMessage(result, stats) {
  if (stats) return "";
  if (result?.entries?.length) {
    return "Salary rows were returned by levels.fyi, but compensation fields were not recognized. Check the console for diagnostics.";
  }
  if (result?.error) return "Could not fetch salary data from levels.fyi. Check the console for request diagnostics.";

  const diagnostics = result?.diagnostics || [];
  const hadSuccess = diagnostics.some(item => item.ok);
  const hadFailure = diagnostics.some(item => item.error && item.error !== "empty result" && item.error !== "empty salary data");
  if (hadFailure && !hadSuccess) {
    return "Could not fetch salary data from levels.fyi. Check the console for request diagnostics.";
  }
  return "No salary data found on levels.fyi for this role.";
}

// Wait for document.title to be meaningful (not just "LinkedIn")
let attempts = 0;
function tryRun() {
  const title = document.title || "";
  const ready = title.length > 10 && !title.match(/^LinkedIn\s*$/) && extractJobInfo() !== null;
  if (ready) { run(); return; }
  if (attempts++ < 30) setTimeout(tryRun, 400);
  else console.log("[LvlSalary] Timed out waiting for page content");
}

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    attempts = 0;
    setTimeout(tryRun, 800);
  }
}).observe(document.body, { childList: true, subtree: true });

tryRun();
