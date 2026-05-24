/**
 * LinkedIn Salary Insights - Background Service Worker
 *
 * Host permissions let this worker perform cross-origin requests for the
 * content script without running into page/content-script CORS limits.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

/**
 * Routes incoming messages to appropriate handlers
 */
async function handleMessage(message) {
  switch (message?.type) {
    case "FETCH_LINKEDIN_JOB":
      return fetchLinkedInJob(message.jobId);
    case "FETCH_LEVELS_SALARIES":
      return fetchSalaries(message.company, message.title);
    default:
      throw new Error("Unknown background request");
  }
}

/**
 * Fetches LinkedIn job posting HTML
 * @param {string|number} jobId - LinkedIn job ID
 * @returns {Promise<{html: string}>}
 */
async function fetchLinkedInJob(jobId) {
  if (!/^\d+$/.test(String(jobId || ""))) {
    throw new Error("Invalid LinkedIn job ID");
  }

  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${encodeURIComponent(jobId)}`;
  const res = await fetch(url, { headers: { Accept: "text/html" } });

  if (!res.ok) {
    throw new Error(`LinkedIn HTTP ${res.status}`);
  }

  return { html: await res.text() };
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

function getJobFamilySlug(slug) {
  let parts = slug.split("-");
  while (parts.length > 1 && SENIORITY_WORDS.has(parts[0])) {
    parts.shift();
  }
  return parts.join("-");
}

function titleCase(str) {
  return str.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Fetches salary data from levels.fyi using multiple fallback strategies
 * @param {string} company - Company name
 * @param {string} title - Job title
 * @returns {Promise<{entries: Array|null, diagnostics: Array, source: string|null, matchedLevelName: string|null, matchedLevelUrl: string|null}>}
 */
async function fetchSalaries(company, title) {
  const cleanCompany = String(company || "").trim();
  const cleanTitle = String(title || "").trim();

  if (!cleanCompany || !cleanTitle) {
    throw new Error("Missing company or title");
  }

  const diagnostics = [];

  // Normalize company and title for URL
  const companySlug = cleanCompany
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const titleSlug = cleanTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  
  const strippedTitleSlug = getJobFamilySlug(titleSlug);

  // Strategy 1: Try the salary page directly (most reliable)
  const salaryPageUrl = `https://www.levels.fyi/companies/${companySlug}/salaries/${titleSlug}`;
  const salaryPageAttempt = { kind: "salary-page", url: salaryPageUrl };
  diagnostics.push(salaryPageAttempt);

  let html = null;
  let success = false;
  let finalUrl = salaryPageUrl;

  try {
    console.log("[LvlSalary] Fetching salary page:", salaryPageUrl);
    let res = await fetch(salaryPageUrl, { headers: { Accept: "text/html" } });
    salaryPageAttempt.status = res.status;
    salaryPageAttempt.ok = res.ok;
    salaryPageAttempt.contentType = res.headers.get("content-type") || "";

    if (res.ok) {
      html = await res.text();
      salaryPageAttempt.bytes = html.length;
      success = true;
    } else if (res.status === 404 && titleSlug !== strippedTitleSlug) {
      // 404 Fallback: try stripping seniority prefixes (e.g. staff-software-engineer -> software-engineer)
      const fallbackUrl = `https://www.levels.fyi/companies/${companySlug}/salaries/${strippedTitleSlug}`;
      console.log("[LvlSalary] 404 received. Retrying with stripped job family slug:", fallbackUrl);
      const fallbackAttempt = { kind: "salary-page-fallback", url: fallbackUrl };
      diagnostics.push(fallbackAttempt);
      finalUrl = fallbackUrl;

      const fallbackRes = await fetch(fallbackUrl, { headers: { Accept: "text/html" } });
      fallbackAttempt.status = fallbackRes.status;
      fallbackAttempt.ok = fallbackRes.ok;
      fallbackAttempt.contentType = fallbackRes.headers.get("content-type") || "";

      if (fallbackRes.ok) {
        html = await fallbackRes.text();
        fallbackAttempt.bytes = html.length;
        success = true;
      } else {
        salaryPageAttempt.error = `Fallback HTTP ${fallbackRes.status}`;
      }
    } else {
      salaryPageAttempt.error = `HTTP ${res.status}`;
    }
  } catch (e) {
    salaryPageAttempt.error = e.message;
    console.log("[LvlSalary] Salary page failed:", e.message);
  }

  if (success && html) {
    const { entries, averages } = extractSalariesAndAveragesFromHTML(html, strippedTitleSlug);
    if (entries && entries.length > 0) {
      salaryPageAttempt.entries = entries.length;

      let filteredEntries = entries;
      let matchedLevel = null;

      if (averages && averages.length > 0) {
        matchedLevel = findBestLevel(cleanTitle, averages);
        if (matchedLevel) {
          const levelId = String(matchedLevel.level || "").toLowerCase();
          filteredEntries = entries.filter(e => String(e.level || "").toLowerCase() === levelId);
          console.log(`[LvlSalary] Matched level: ${matchedLevel.primaryLevelName} (${matchedLevel.secondaryLevelName}). Filtered entries count: ${filteredEntries.length}`);
          if (filteredEntries.length === 0) {
            filteredEntries = entries;
            matchedLevel = null;
          }
        }
      }

      const levelName = matchedLevel ? (matchedLevel.secondaryLevelName || matchedLevel.primaryLevelName) : null;
      const levelUrl = matchedLevel ? `https://www.levels.fyi/companies/${companySlug}/salaries/${strippedTitleSlug}/levels/${matchedLevel.level}` : null;

      return {
        entries: filteredEntries,
        diagnostics,
        source: finalUrl,
        matchedLevelName: levelName,
        matchedLevelUrl: levelUrl
      };
    }
    salaryPageAttempt.error = "Could not extract salary data from HTML";
  }

  // Strategy 2: Try legacy API endpoints
  const cleanStrippedTitle = titleCase(strippedTitleSlug.replace(/-/g, " "));
  const endpoints = [
    `https://www.levels.fyi/api/v2/salary/?company=${encodeURIComponent(cleanCompany)}&title=${encodeURIComponent(cleanTitle)}&limit=30`,
    `https://www.levels.fyi/api/v2/salary/?company=${encodeURIComponent(cleanCompany)}&title=${encodeURIComponent(cleanStrippedTitle)}&limit=30`,
    `https://www.levels.fyi/api/salaries?company=${encodeURIComponent(cleanCompany)}&title=${encodeURIComponent(cleanTitle)}`,
    `https://www.levels.fyi/api/salaries?company=${encodeURIComponent(cleanCompany)}&title=${encodeURIComponent(cleanStrippedTitle)}`,
  ];

  for (const url of endpoints) {
    const attempt = { kind: "api", url };
    diagnostics.push(attempt);

    try {
      console.log("[LvlSalary] Fetching API:", url);
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      attempt.status = res.status;
      attempt.ok = res.ok;
      attempt.contentType = res.headers.get("content-type") || "";

      if (!res.ok) {
        attempt.error = `HTTP ${res.status}`;
        continue;
      }

      const text = await res.text();
      attempt.bytes = text.length;

      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        attempt.error = `JSON parse failed: ${e.message}`;
        attempt.preview = text.slice(0, 200);
        continue;
      }

      const entries = json.data || json.salaries || json.results || json;
      attempt.entries = Array.isArray(entries) ? entries.length : null;

      if (Array.isArray(entries) && entries.length > 0) {
        return { entries, diagnostics, source: url, matchedLevelName: null, matchedLevelUrl: null };
      }

      attempt.error = Array.isArray(entries) ? "empty result" : "unexpected response shape";
    } catch (e) {
      attempt.error = e.message;
      console.log("[LvlSalary] API failed:", e.message);
    }
  }

  // Strategy 3: Try company page as final fallback
  const pageUrl = `https://www.levels.fyi/companies/${companySlug}/salaries`;
  const fallback = { kind: "company-page", url: pageUrl };
  diagnostics.push(fallback);

  try {
    console.log("[LvlSalary] Fetching company page:", pageUrl);
    const res = await fetch(pageUrl, { headers: { Accept: "text/html" } });
    fallback.status = res.status;
    fallback.ok = res.ok;
    fallback.contentType = res.headers.get("content-type") || "";

    if (res.ok) {
      const html = await res.text();
      fallback.bytes = html.length;

      const { entries, averages } = extractSalariesAndAveragesFromHTML(html, strippedTitleSlug);
      if (entries && entries.length > 0) {
        fallback.entries = entries.length;

        let filteredEntries = entries;
        let matchedLevel = null;

        if (averages && averages.length > 0) {
          matchedLevel = findBestLevel(cleanTitle, averages);
          if (matchedLevel) {
            const levelId = String(matchedLevel.level || "").toLowerCase();
            filteredEntries = entries.filter(e => String(e.level || "").toLowerCase() === levelId);
            console.log(`[LvlSalary] Matched level (company fallback): ${matchedLevel.primaryLevelName} (${matchedLevel.secondaryLevelName}). Filtered entries count: ${filteredEntries.length}`);
            if (filteredEntries.length === 0) {
              filteredEntries = entries;
              matchedLevel = null;
            }
          }
        }

        const levelName = matchedLevel ? (matchedLevel.secondaryLevelName || matchedLevel.primaryLevelName) : null;
        const levelUrl = matchedLevel ? `https://www.levels.fyi/companies/${companySlug}/salaries/${strippedTitleSlug}/levels/${matchedLevel.level}` : null;

        return {
          entries: filteredEntries,
          diagnostics,
          source: pageUrl,
          matchedLevelName: levelName,
          matchedLevelUrl: levelUrl
        };
      }
      fallback.error = "Could not extract salary data from company page";
    } else {
      fallback.error = `HTTP ${res.status}`;
    }
  } catch (e) {
    fallback.error = e.message;
    console.log("[LvlSalary] Company page fallback failed:", e.message);
  }

  return { entries: null, diagnostics, source: null, matchedLevelName: null, matchedLevelUrl: null };
}

/**
 * Extracts salary data and averages array from HTML content using multiple parsing strategies
 * @param {string} html - HTML content to parse
 * @returns {{entries: Array|null, averages: Array|null}} Extracted salary entries and averages
 */
function extractSalariesAndAveragesFromHTML(html, titleSlug) {
  let entries = null;
  let averages = null;

  try {
    // Strategy 1: Try to extract from __NEXT_DATA__ first
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const pageProps = nextData?.props?.pageProps || {};
        
        // Extract averages
        averages = pageProps.averages || [];
        
        // 1. Check if averages/samples are present (new specific title page structure)
        const extractedSamples = [];
        if (Array.isArray(averages)) {
          for (const level of averages) {
            if (level?.samples && Array.isArray(level.samples)) {
              for (const sample of level.samples) {
                extractedSamples.push({
                  totalyearlycompensation: sample.totalCompensation || sample.totalcompensation,
                  baseSalary: sample.baseSalary || sample.basesalary,
                  stockGrantValue: sample.avgAnnualStockGrantValue || sample.stockGrantValue || 0,
                  annualBonus: sample.avgAnnualBonusValue || sample.annualBonus || 0,
                  level: sample.level,
                });
              }
            }
          }
        }
        
        if (extractedSamples.length > 0) {
          console.log("[LvlSalary] Extracted", extractedSamples.length, "samples from averages");
          entries = extractedSamples;
        } else {
          // 2. Check if overview breakdown is present (new company page structure)
          const overview = pageProps.overview || [];
          if (Array.isArray(overview) && overview.length > 0) {
            const cleanTitleSlug = String(titleSlug || "").trim().toLowerCase();
            const match = overview.find(item => 
              item.slug?.toLowerCase() === cleanTitleSlug || 
              item.name?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") === cleanTitleSlug
            ) || overview[0]; // fallback to first one if no match
            
            if (match && match.breakdown && Array.isArray(match.breakdown)) {
              const extractedBreakdowns = match.breakdown.map(b => ({
                totalyearlycompensation: b.total,
                level: b.level,
                jobFamily: match.name,
              }));
              console.log(`[LvlSalary] Extracted ${extractedBreakdowns.length} breakdowns for ${match.name}`);
              entries = extractedBreakdowns;
            }
          }

          if (!entries) {
            // 3. Fallback to older __NEXT_DATA__ fields
            const oldData =
              pageProps.salaryData ||
              pageProps.data?.salaries ||
              pageProps.salaries ||
              [];
            if (Array.isArray(oldData) && oldData.length > 0) {
              entries = oldData;
            }
          }
        }
      } catch (e) {
        console.log("[LvlSalary] Failed to parse __NEXT_DATA__:", e.message);
      }
    }

    if (!entries) {
      const salaries = [];
      // Strategy 2: Extract salary data from level patterns in HTML
      // Look for patterns like: L3, L4, L5 with compensation values
      const levelPattern = /(?:L\d+|Level\s+\d+|Entry|Mid|Senior|Staff|Principal)\s+[^<]*?(?:\$|₹|€|£)([\d,]+)k?\s*(?:\$|₹|€|£)?([\d,]+)?k?\s*(?:\$|₹|€|£)?([\d,]+)?k?\s*(?:\$|₹|€|£)?([\d,]+)?k?/gi;
      const matches = html.matchAll(levelPattern);

      for (const match of matches) {
        const totalComp =
          parseCompValue(match[1]) ||
          parseCompValue(match[1]) +
            parseCompValue(match[2]) +
            parseCompValue(match[3]) +
            parseCompValue(match[4]);

        if (totalComp > 10000) {
          salaries.push({
            totalyearlycompensation: totalComp,
            baseSalary: parseCompValue(match[1]) || 0,
            stockGrantValue: parseCompValue(match[2]) || 0,
            annualBonus: parseCompValue(match[3]) || 0,
          });
        }
      }

      // Strategy 3: Extract from table structure
      const tablePattern = /<tr[^>]*>[\s\S]*?<td[^>]*>([^<]+)<\/td>[\s\S]*?(?:\$|₹|€|£)([\d,]+(?:\.\d+)?)[kKmM]?[\s\S]*?<\/tr>/gi;
      const tableMatches = html.matchAll(tablePattern);

      for (const match of tableMatches) {
        const comp = parseCompValue(match[2]);
        if (comp > 10000) {
          salaries.push({
            totalyearlycompensation: comp,
            level: match[1].trim(),
          });
        }
      }

      if (salaries.length > 0) {
        entries = salaries;
      }
    }
  } catch (e) {
    console.log("[LvlSalary] HTML extraction error:", e.message);
  }

  return { entries, averages };
}

function cleanAndTokenize(text) {
  if (!text) return new Set();
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
  return new Set(words);
}

function extractSeniority(words) {
  const result = new Set();
  for (const word of words) {
    if (SENIORITY_WORDS.has(word)) {
      result.add(word);
    }
  }
  return result;
}

/**
 * Finds the best matching levels.fyi average level based on the LinkedIn job title
 * @param {string} jobTitle 
 * @param {Array} averages 
 * @returns {Object|null} Best matching average level object
 */
function findBestLevel(jobTitle, averages) {
  if (!averages || averages.length === 0) return null;

  const jobWords = cleanAndTokenize(jobTitle);
  const jobSeniority = extractSeniority(jobWords);

  // Check for direct level match in the job title (e.g. "L5", "L6", etc.)
  let directLevel = null;
  const levelMatch = jobTitle.toLowerCase().match(/\b(l|level\s*)(\d+)\b/);
  if (levelMatch) {
    directLevel = `l${levelMatch[2]}`;
  }

  // If no seniority keywords and no direct level specified, don't filter
  if (jobSeniority.size === 0 && !directLevel) {
    return null;
  }

  let bestLevel = null;
  let bestScore = -9999;

  for (const avg of averages) {
    const levelId = String(avg.level || "").toLowerCase();

    // Direct level match
    if (directLevel && levelId === directLevel) {
      return avg;
    }

    const levelNames = [
      avg.level,
      avg.primaryLevelName,
      avg.secondaryLevelName,
      avg.shortestLevelName,
    ].filter(Boolean);

    const levelWords = new Set();
    for (const name of levelNames) {
      const words = cleanAndTokenize(name);
      for (const w of words) {
        levelWords.add(w);
      }
    }

    const levelSeniority = extractSeniority(levelWords);

    // Scoring logic
    let score = 0;

    // Count matching seniority words
    let matchCount = 0;
    for (const s of jobSeniority) {
      if (levelSeniority.has(s)) {
        matchCount++;
      }
    }
    score += matchCount * 20;

    // Penalty for seniority words in level not in job
    let extraLevelCount = 0;
    for (const s of levelSeniority) {
      if (!jobSeniority.has(s)) {
        extraLevelCount++;
      }
    }
    score -= extraLevelCount * 10;

    // Penalty for seniority words in job not in level
    let extraJobCount = 0;
    for (const s of jobSeniority) {
      if (!levelSeniority.has(s)) {
        extraJobCount++;
      }
    }
    score -= extraJobCount * 5;

    // Substring match reward
    for (const name of levelNames) {
      if (jobTitle.toLowerCase().includes(name.toLowerCase())) {
        score += 5;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestLevel = avg;
    }
  }

  // If we have seniority keywords but the best match has a negative/zero score (no words matched), return null
  if (jobSeniority.size > 0 && bestScore <= 0) {
    return null;
  }

  return bestLevel;
}

/**
 * Parses compensation value from string, handling various formats and suffixes
 * @param {string} str - String containing compensation value
 * @returns {number} Parsed compensation value
 */
function parseCompValue(str) {
  if (!str) return 0;

  const cleaned = String(str).replace(/[,$]/g, "").trim();
  const num = parseFloat(cleaned);

  if (!Number.isFinite(num)) return 0;

  // Handle k/K suffix (thousands)
  if (/k$/i.test(str)) return num * 1000;

  // Handle m/M suffix (millions)
  if (/m$/i.test(str)) return num * 1000000;

  // If number is less than 1000, assume it's in thousands
  if (num < 1000) return num * 1000;

  return num;
}