// LinkedIn Salary Insights - background service worker.
// Host permissions let this worker perform cross-origin requests for the
// content script without running into page/content-script CORS limits.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(payload => sendResponse({ ok: true, ...payload }))
    .catch(error => sendResponse({ ok: false, error: error.message }));

  return true;
});

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

async function fetchLinkedInJob(jobId) {
  if (!/^\d+$/.test(String(jobId || ""))) throw new Error("Invalid LinkedIn job ID");

  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${encodeURIComponent(jobId)}`;
  const res = await fetch(url, { headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error("LinkedIn HTTP " + res.status);

  return { html: await res.text() };
}

async function fetchSalaries(company, title) {
  const cleanCompany = String(company || "").trim();
  const cleanTitle = String(title || "").trim();
  if (!cleanCompany || !cleanTitle) throw new Error("Missing company or title");
  const diagnostics = [];

  const endpoints = [
    `https://www.levels.fyi/api/v2/salary/?company=${encodeURIComponent(cleanCompany)}&title=${encodeURIComponent(cleanTitle)}&limit=30`,
    `https://www.levels.fyi/api/salaries?company=${encodeURIComponent(cleanCompany)}&title=${encodeURIComponent(cleanTitle)}`,
  ];

  for (const url of endpoints) {
    const attempt = { kind: "api", url };
    diagnostics.push(attempt);
    try {
      console.log("[LvlSalary] Fetching:", url);
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      attempt.status = res.status;
      attempt.ok = res.ok;
      attempt.contentType = res.headers.get("content-type") || "";
      if (!res.ok) {
        attempt.error = "HTTP " + res.status;
        continue;
      }

      const text = await res.text();
      attempt.bytes = text.length;
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        attempt.error = "JSON parse failed: " + e.message;
        attempt.preview = text.slice(0, 200);
        continue;
      }
      const entries = json.data || json.salaries || json.results || json;
      attempt.entries = Array.isArray(entries) ? entries.length : null;
      if (Array.isArray(entries) && entries.length > 0) {
        return { entries, diagnostics, source: url };
      }
      attempt.error = Array.isArray(entries) ? "empty result" : "unexpected response shape";
    } catch (e) {
      attempt.error = e.message;
      console.log("[LvlSalary]", e.message);
    }
  }

  const pageUrl = `https://www.levels.fyi/company/${encodeURIComponent(cleanCompany)}/levels/`;
  const fallback = { kind: "company-page", url: pageUrl };
  diagnostics.push(fallback);
  try {
    const res = await fetch(pageUrl, { headers: { Accept: "text/html" } });
    fallback.status = res.status;
    fallback.ok = res.ok;
    fallback.contentType = res.headers.get("content-type") || "";
    if (res.ok) {
      const html = await res.text();
      fallback.bytes = html.length;
      const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (match) {
        const nextData = JSON.parse(match[1]);
        const salaries = nextData?.props?.pageProps?.salaryData ||
          nextData?.props?.pageProps?.data?.salaries ||
          [];
        fallback.entries = Array.isArray(salaries) ? salaries.length : null;
        if (Array.isArray(salaries) && salaries.length) {
          return { entries: salaries, diagnostics, source: pageUrl };
        }
        fallback.error = Array.isArray(salaries) ? "empty salary data" : "unexpected salary data shape";
      } else {
        fallback.error = "missing __NEXT_DATA__ script";
      }
    } else {
      fallback.error = "HTTP " + res.status;
    }
  } catch (e) {
    fallback.error = e.message;
    console.log("[LvlSalary] fallback failed:", e.message);
  }

  return { entries: null, diagnostics, source: null };
}
