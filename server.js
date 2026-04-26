import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 48731);
const SESSIONS_ROOT =
  process.env.CODEX_SESSIONS_ROOT ||
  path.join(os.homedir(), ".codex", "sessions");
const PUBLIC_DIR = path.join(__dirname, "public");
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 2500);

const pricing = [
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    default: true
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    input: 0.75,
    cachedInput: 0.075,
    output: 4.5
  },
  {
    id: "gpt-5.4-nano",
    label: "GPT-5.4 nano",
    input: 0.2,
    cachedInput: 0.02,
    output: 1.25
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    input: 1.75,
    cachedInput: 0.175,
    output: 14
  },
  {
    id: "gpt-5-codex",
    label: "GPT-5 Codex",
    input: 1.25,
    cachedInput: 0.125,
    output: 10
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    input: 5,
    cachedInput: 0.5,
    output: 30
  },
  {
    id: "gpt-5.4-pro",
    label: "GPT-5.4/5.5 Pro reference",
    input: 30,
    cachedInput: null,
    output: 180
  }
];

const emptyTotals = () => ({
  sessions: 0,
  files: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  bytes: 0,
  diskBytes: 0,
  badJsonLines: 0
});

const fileCache = new Map();
let lastScan = null;
let lastScanAt = 0;

function shanghaiDay(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

function monthOf(day) {
  return day ? day.slice(0, 7) : "unknown";
}

function addDays(day, delta) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function fallbackDayFromPath(filePath) {
  const match = filePath.match(/sessions\/(\d{4})\/(\d{2})\/(\d{2})\//);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "unknown";
}

function walkJsonl(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

function normalizeUsage(raw = {}) {
  return {
    inputTokens: Number(raw.input_tokens || 0),
    cachedInputTokens: Number(raw.cached_input_tokens || 0),
    outputTokens: Number(raw.output_tokens || 0),
    reasoningOutputTokens: Number(raw.reasoning_output_tokens || 0),
    totalTokens: Number(raw.total_tokens || 0)
  };
}

function usageDelta(current, previous) {
  if (!previous) return { ...current };

  const reset = current.totalTokens < previous.totalTokens;
  const diff = (key) =>
    reset ? Number(current[key] || 0) : Math.max(0, Number(current[key] || 0) - Number(previous[key] || 0));

  return {
    inputTokens: diff("inputTokens"),
    cachedInputTokens: diff("cachedInputTokens"),
    outputTokens: diff("outputTokens"),
    reasoningOutputTokens: diff("reasoningOutputTokens"),
    totalTokens: diff("totalTokens")
  };
}

function modelInfoFromMeta(meta = {}) {
  const fields = {};
  for (const key of ["model", "model_id", "model_slug", "model_name", "model_provider"]) {
    if (typeof meta[key] === "string" && meta[key].trim()) {
      fields[key] = meta[key].trim();
    }
  }
  return fields;
}

function parseSession(filePath, stat) {
  let meta = {};
  let lastUsage = null;
  let lastUsageTimestamp = null;
  let lastRate = null;
  let lastRateTimestamp = null;
  const rateEvents = [];
  let maxPrimaryUsed = 0;
  let maxSecondaryUsed = 0;
  let badJsonLines = 0;
  const plans = {};
  const rateHits = {};
  const usageEvents = [];
  let previousUsage = null;

  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      badJsonLines += 1;
      continue;
    }

    if (event.type === "session_meta") {
      meta = event.payload || {};
      continue;
    }

    if (event.type !== "event_msg") continue;
    const payload = event.payload || {};
    if (payload.type !== "token_count") continue;

    const info = payload.info || null;
    if (info?.total_token_usage) {
      const currentUsage = normalizeUsage(info.total_token_usage);
      const delta = usageDelta(currentUsage, previousUsage);
      previousUsage = currentUsage;
      lastUsage = currentUsage;
      lastUsageTimestamp = event.timestamp || null;
      if (delta.totalTokens > 0) {
        usageEvents.push({
          timestamp: event.timestamp || null,
          day: event.timestamp ? shanghaiDay(event.timestamp) : null,
          usage: currentUsage,
          delta
        });
      }
    }

    const rate = payload.rate_limits || null;
    if (rate) {
      lastRate = rate;
      lastRateTimestamp = event.timestamp || null;
      rateEvents.push({
        timestamp: event.timestamp || null,
        day: event.timestamp ? shanghaiDay(event.timestamp) : null,
        rate
      });
      const primaryUsed = Number(rate.primary?.used_percent || 0);
      const secondaryUsed = Number(rate.secondary?.used_percent || 0);
      maxPrimaryUsed = Math.max(maxPrimaryUsed, primaryUsed);
      maxSecondaryUsed = Math.max(maxSecondaryUsed, secondaryUsed);

      if (rate.plan_type) {
        plans[rate.plan_type] = (plans[rate.plan_type] || 0) + 1;
      }
      if (rate.rate_limit_reached_type) {
        const key = String(rate.rate_limit_reached_type);
        rateHits[key] = (rateHits[key] || 0) + 1;
      }
    }
  }

  const timestamp = meta.timestamp || null;
  const day = timestamp ? shanghaiDay(timestamp) : fallbackDayFromPath(filePath);
  const usage = lastUsage || normalizeUsage();
  const modelInfo = modelInfoFromMeta(meta);

  return {
    path: filePath,
    file: path.basename(filePath),
    id: meta.id || null,
    timestamp,
    day,
    month: monthOf(day),
    cwd: meta.cwd || null,
    originator: meta.originator || null,
    source: meta.source || null,
    cliVersion: meta.cli_version || null,
    agentRole: meta.agent_role || null,
    modelInfo,
    hasUsage: Boolean(lastUsage),
    usage,
    usageEvents,
    lastUsageTimestamp,
    lastRate,
    lastRateTimestamp,
    rateEvents,
    maxPrimaryUsed,
    maxSecondaryUsed,
    plans,
    rateHits,
    bytes: stat.size,
    diskBytes: Number(stat.blocks || 0) * 512 || stat.size,
    badJsonLines
  };
}

function getSessionSummary(filePath) {
  const stat = fs.statSync(filePath);
  const cached = fileCache.get(filePath);
  const key = `${stat.size}:${stat.mtimeMs}`;
  if (cached?.key === key) {
    return cached.summary;
  }

  const summary = parseSession(filePath, stat);
  fileCache.set(filePath, { key, summary });
  return summary;
}

function addUsage(target, session) {
  target.files += 1;
  target.bytes += session.bytes;
  target.diskBytes += session.diskBytes;
  target.badJsonLines += session.badJsonLines;

  if (!session.hasUsage) return target;

  target.sessions += 1;
  target.inputTokens += session.usage.inputTokens;
  target.cachedInputTokens += session.usage.cachedInputTokens;
  target.outputTokens += session.usage.outputTokens;
  target.reasoningOutputTokens += session.usage.reasoningOutputTokens;
  target.totalTokens += session.usage.totalTokens;
  return target;
}

function eventBucket() {
  return {
    ...emptyTotals(),
    sessionKeys: new Set(),
    fileKeys: new Set()
  };
}

function addDelta(target, session, delta) {
  const sessionKey = session.id || session.path;
  const hadSession = target.sessionKeys.has(sessionKey);
  const hadFile = target.fileKeys.has(session.path);

  target.sessionKeys.add(sessionKey);
  target.fileKeys.add(session.path);
  target.sessions = target.sessionKeys.size;
  target.files = target.fileKeys.size;

  if (!hadFile) {
    target.bytes += session.bytes;
    target.diskBytes += session.diskBytes;
    target.badJsonLines += session.badJsonLines;
  } else if (!hadSession) {
    target.badJsonLines += session.badJsonLines;
  }

  target.inputTokens += delta.inputTokens;
  target.cachedInputTokens += delta.cachedInputTokens;
  target.outputTokens += delta.outputTokens;
  target.reasoningOutputTokens += delta.reasoningOutputTokens;
  target.totalTokens += delta.totalTokens;
  return target;
}

function finishTotals(total) {
  const { sessionKeys, fileKeys, ...plain } = total;
  if (sessionKeys) plain.sessions = sessionKeys.size;
  if (fileKeys) plain.files = fileKeys.size;
  const uncached = Math.max(0, total.inputTokens - total.cachedInputTokens);
  return {
    ...plain,
    uncachedInputTokens: uncached,
    cacheHitRate: total.inputTokens
      ? total.cachedInputTokens / total.inputTokens
      : 0
  };
}

function costFor(total, model) {
  const input = Number(total.inputTokens || 0);
  const cached = Number(total.cachedInputTokens || 0);
  const uncached = Math.max(0, input - cached);
  const output = Number(total.outputTokens || 0);
  const inputCost =
    model.cachedInput === null
      ? (input / 1_000_000) * model.input
      : (uncached / 1_000_000) * model.input;
  const cachedCost =
    model.cachedInput === null
      ? 0
      : (cached / 1_000_000) * model.cachedInput;
  const outputCost = (output / 1_000_000) * model.output;
  return {
    inputCost,
    cachedCost,
    outputCost,
    totalCost: inputCost + cachedCost + outputCost
  };
}

function buildScan() {
  const startedAt = Date.now();
  const files = walkJsonl(SESSIONS_ROOT).sort();
  const seen = new Set(files);
  for (const key of fileCache.keys()) {
    if (!seen.has(key)) fileCache.delete(key);
  }

  const sessions = [];
  const totals = eventBucket();
  const sessionTotals = emptyTotals();
  const byDayMap = new Map();
  const byMonthMap = new Map();
  const modelSummary = {};
  const rateEvents = [];
  let latestRateSession = null;

  for (const file of files) {
    let session;
    try {
      session = getSessionSummary(file);
    } catch (error) {
      session = {
        path: file,
        file: path.basename(file),
        day: fallbackDayFromPath(file),
        month: monthOf(fallbackDayFromPath(file)),
        hasUsage: false,
        usage: normalizeUsage(),
        lastRate: null,
        lastRateTimestamp: null,
        maxPrimaryUsed: 0,
        maxSecondaryUsed: 0,
        plans: {},
        rateHits: {},
        bytes: 0,
        diskBytes: 0,
        badJsonLines: 1,
        error: error.message
      };
    }

    sessions.push(session);
    addUsage(sessionTotals, session);

    for (const [key, value] of Object.entries(session.modelInfo || {})) {
      const summaryKey = `${key}:${value}`;
      modelSummary[summaryKey] = modelSummary[summaryKey] || {
        key,
        value,
        sessions: 0,
        totalTokens: 0
      };
      modelSummary[summaryKey].sessions += session.hasUsage ? 1 : 0;
      modelSummary[summaryKey].totalTokens += session.usage?.totalTokens || 0;
    }

    if (
      session.lastRate &&
      (!latestRateSession ||
        new Date(session.lastRateTimestamp || 0) >
          new Date(latestRateSession.lastRateTimestamp || 0))
    ) {
      latestRateSession = session;
    }

    for (const event of session.rateEvents || []) {
      rateEvents.push({
        ...event,
        file: session.file,
        sessionDay: session.day
      });
    }

    for (const event of session.usageEvents || []) {
      if (!event.day) continue;
      addDelta(totals, session, event.delta);

      if (!byDayMap.has(event.day)) byDayMap.set(event.day, eventBucket());
      addDelta(byDayMap.get(event.day), session, event.delta);

      const eventMonth = monthOf(event.day);
      if (!byMonthMap.has(eventMonth)) byMonthMap.set(eventMonth, eventBucket());
      addDelta(byMonthMap.get(eventMonth), session, event.delta);
    }
  }

  const today = shanghaiDay();
  const currentMonth = monthOf(today);
  const last7Start = addDays(today, -6);
  const last30Start = addDays(today, -29);

  const byDay = [...byDayMap.entries()]
    .map(([day, total]) => ({ day, ...finishTotals(total) }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const byMonth = [...byMonthMap.entries()]
    .map(([month, total]) => ({ month, ...finishTotals(total) }))
    .sort((a, b) => a.month.localeCompare(b.month));

  function range(predicate) {
    const total = eventBucket();
    for (const session of sessions) {
      for (const event of session.usageEvents || []) {
        if (predicate(event, session)) addDelta(total, session, event.delta);
      }
    }
    return finishTotals(total);
  }

  const ranges = {
    today: range((event) => event.day === today),
    currentMonth: range((event) => monthOf(event.day) === currentMonth),
    last7: range((event) => event.day >= last7Start && event.day <= today),
    last30: range((event) => event.day >= last30Start && event.day <= today),
    all: finishTotals(totals)
  };

  const topSessions = sessions
    .filter((session) => session.hasUsage)
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens)
    .slice(0, 12)
    .map((session) => ({
      day: session.day,
      file: session.file,
      totalTokens: session.usage.totalTokens,
      inputTokens: session.usage.inputTokens,
      cachedInputTokens: session.usage.cachedInputTokens,
      outputTokens: session.usage.outputTokens,
      cacheHitRate: session.usage.inputTokens
        ? session.usage.cachedInputTokens / session.usage.inputTokens
        : 0,
      bytes: session.bytes,
      cwd: session.cwd
    }));

  const topDays = [...byDay]
    .filter((day) => day.sessions > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 12);

  const recentDays = byDay
    .filter((day) => day.day >= addDays(today, -30) && day.sessions > 0)
    .slice(-31);

  const latestRateEvent = [...rateEvents]
    .filter((event) => event.rate)
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0];
  let latestRate = null;
  if (latestRateEvent) {
    const latestPrimaryReset = latestRateEvent.rate.primary?.resets_at ?? null;
    const latestSecondaryReset = latestRateEvent.rate.secondary?.resets_at ?? null;
    const samePrimaryWindow = rateEvents.filter(
      (event) => event.rate?.primary?.resets_at === latestPrimaryReset
    );
    const sameSecondaryWindow = rateEvents.filter(
      (event) => event.rate?.secondary?.resets_at === latestSecondaryReset
    );
    const primaryMax = Math.max(
      ...samePrimaryWindow.map((event) => Number(event.rate?.primary?.used_percent || 0))
    );
    const secondaryMax = Math.max(
      ...sameSecondaryWindow.map((event) => Number(event.rate?.secondary?.used_percent || 0))
    );
    latestRate = {
      day: latestRateEvent.day || latestRateEvent.sessionDay,
      file: latestRateEvent.file,
      timestamp: latestRateEvent.timestamp,
      source: "session token_count.rate_limits",
      observedAgeSeconds: latestRateEvent.timestamp
        ? Math.max(0, Math.round((Date.now() - new Date(latestRateEvent.timestamp).getTime()) / 1000))
        : null,
      primaryUsed: primaryMax,
      secondaryUsed: secondaryMax,
      primaryLatestUsed: Number(latestRateEvent.rate.primary?.used_percent || 0),
      secondaryLatestUsed: Number(latestRateEvent.rate.secondary?.used_percent || 0),
      maxPrimaryUsed: primaryMax,
      maxSecondaryUsed: secondaryMax,
      primarySamples: samePrimaryWindow.length,
      secondarySamples: sameSecondaryWindow.length,
      rateLimits: latestRateEvent.rate
    };
  }

  const costs = {};
  for (const [rangeName, total] of Object.entries(ranges)) {
    costs[rangeName] = {};
    for (const model of pricing) {
      costs[rangeName][model.id] = costFor(total, model);
    }
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      generatedDay: today,
      scanDurationMs: Date.now() - startedAt,
      cacheTtlMs: CACHE_TTL_MS,
      refreshNote: "Rate limits are read from Codex session token_count snapshots.",
      sessionsRoot: SESSIONS_ROOT,
      fileCount: files.length,
      cacheEntries: fileCache.size
    },
    pricing,
    totals: finishTotals(totals),
    sessionTotals: finishTotals(sessionTotals),
    ranges,
    costs,
    modelSummary: Object.values(modelSummary).sort((a, b) => b.totalTokens - a.totalTokens),
    byDay,
    byMonth,
    topDays,
    topSessions,
    recentDays,
    latestRate
  };
}

function getScan() {
  const now = Date.now();
  if (lastScan && now - lastScanAt < CACHE_TTL_MS) {
    return { ...lastScan, meta: { ...lastScan.meta, servedFromCache: true } };
  }
  lastScan = buildScan();
  lastScanAt = now;
  return lastScan;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml"
    }[ext] || "application/octet-stream"
  );
}

function safeStaticPath(requestPath) {
  const normalized = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  const resolved = path.join(PUBLIC_DIR, normalized === "/" ? "index.html" : normalized);
  return resolved.startsWith(PUBLIC_DIR) ? resolved : null;
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || HOST}`);

  if (requestUrl.pathname === "/api/summary") {
    try {
      const body = JSON.stringify(getScan());
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, root: SESSIONS_ROOT }));
    return;
  }

  const staticPath = safeStaticPath(requestUrl.pathname);
  if (!staticPath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(staticPath, (error, content) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": contentType(staticPath),
      "cache-control": "no-store"
    });
    res.end(content);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Codex Token Monitor running at http://${HOST}:${PORT}`);
  console.log(`Reading sessions from ${SESSIONS_ROOT}`);
});
