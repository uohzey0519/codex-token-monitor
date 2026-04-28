const state = {
  data: null,
  modelId: "gpt-5.5",
  range: "last7",
  timer: null,
  themeIndex: 0,
  refreshMs: 10_000
};

const themes = ["sage", "peach", "sky"];
const $ = (id) => document.getElementById(id);

const formatInt = (value) => new Intl.NumberFormat("en-US").format(Math.round(value || 0));
const formatCompact = (value) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value || 0);
const formatUsd = (value) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2
  }).format(value || 0);
const pct = (value) => `${((value || 0) * 100).toFixed(2)}%`;
const shortPct = (value) => `${((value || 0) * 100).toFixed(1)}%`;

function activeModel() {
  return state.data.pricing.find((model) => model.id === state.modelId) || state.data.pricing[0];
}

function calcCost(total, model = activeModel()) {
  const input = total.inputTokens || 0;
  const cached = total.cachedInputTokens || 0;
  const uncached = Math.max(0, input - cached);
  const output = total.outputTokens || 0;
  const inputCost =
    model.cachedInput === null ? (input / 1_000_000) * model.input : (uncached / 1_000_000) * model.input;
  const cachedCost = model.cachedInput === null ? 0 : (cached / 1_000_000) * model.cachedInput;
  const outputCost = (output / 1_000_000) * model.output;
  return { inputCost, cachedCost, outputCost, totalCost: inputCost + cachedCost + outputCost };
}

function setText(id, text) {
  $(id).textContent = text;
}

function displayPath(value) {
  if (!value) return "-";
  const text = String(value);
  return text.replace(/^\/Users\/[^/]+/, "~");
}

function setBar(id, value) {
  const percent = Math.max(0, Math.min(100, Number(value || 0)));
  const el = $(id);
  el.style.width = `${percent}%`;
  el.style.background = percent >= 90 ? "var(--danger)" : percent >= 70 ? "var(--warn)" : "var(--accent)";
}

function resetTime(epochSeconds) {
  if (!epochSeconds) return "-";
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function durationText(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  if (minutes >= 1) return `${minutes}m`;
  return `${seconds}s`;
}

function remainingUntil(epochSeconds) {
  if (!epochSeconds) return "未知";
  const seconds = epochSeconds - Date.now() / 1000;
  return seconds <= 0 ? "已过期" : `剩余 ${durationText(seconds)}`;
}

function timeAgo(isoTimestamp) {
  if (!isoTimestamp) return "未知时间";
  const seconds = (Date.now() - new Date(isoTimestamp).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return "刚刚";
  if (seconds < 60) return `${Math.round(seconds)}s 前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m 前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h 前`;
  return `${Math.round(seconds / 86400)}d 前`;
}

function windowLabel(minutes, fallback) {
  const value = Number(minutes || 0);
  if (value === 300) return `5h ${fallback}`;
  if (value === 10080) return `1w ${fallback}`;
  if (!value) return fallback;
  if (value % 1440 === 0) return `${value / 1440}d ${fallback}`;
  if (value % 60 === 0) return `${value / 60}h ${fallback}`;
  return `${value}m ${fallback}`;
}

function renderControls() {
  const select = $("modelSelect");
  select.innerHTML = state.data.pricing
    .map(
      (model) =>
        `<option value="${model.id}" ${model.id === state.modelId ? "selected" : ""}>${model.label}</option>`
    )
    .join("");
}

function renderSummary() {
  const total = state.data.ranges[state.range];
  const cost = calcCost(total);
  const model = activeModel();

  setText("costValue", formatUsd(cost.totalCost));
  setText(
    "costBreakdown",
    `input ${formatUsd(cost.inputCost)} / cached ${formatUsd(cost.cachedCost)} / output ${formatUsd(cost.outputCost)}`
  );
  setText("totalTokens", formatCompact(total.totalTokens));
  setText("sessionCount", `${formatInt(total.sessions)} sessions / ${formatInt(total.files)} files`);
  setText("cacheRate", pct(total.cacheHitRate));
  setText("cachedTokens", `${formatCompact(total.cachedInputTokens)} cached, ${formatCompact(total.uncachedInputTokens)} fresh`);
  setText("outputTokens", formatCompact(total.outputTokens));
  setText("reasoningTokens", `${formatCompact(total.reasoningOutputTokens)} reasoning tokens included`);

  setText("dataSource", state.data.meta.sessionsRootDisplay || displayPath(state.data.meta.sessionsRoot));
  setText(
    "priceSource",
    `input $${model.input}/M · hit ${model.cachedInput === null ? "无折扣" : `$${model.cachedInput}/M`} · output $${model.output}/M`
  );
  setText(
    "updatedAt",
    new Date(state.data.meta.generatedAt).toLocaleString("zh-CN", {
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })
  );
  setText("scanTime", `${state.data.meta.scanDurationMs} ms · ${model.label}`);
}

function renderRate() {
  const latest = state.data.latestRate;
  if (!latest?.rateLimits) {
    setText("rateContext", "没有 rate limit 记录");
    setText("primaryUsed", "0%");
    setText("secondaryUsed", "0%");
    setBar("primaryBar", 0);
    setBar("secondaryBar", 0);
    return;
  }

  const rate = latest.rateLimits;
  const primary = rate.primary || {};
  const secondary = rate.secondary || {};
  const primaryUsed = Number(latest.primaryUsed ?? latest.maxPrimaryUsed ?? primary.used_percent ?? 0);
  const secondaryUsed = Number(latest.secondaryUsed ?? latest.maxSecondaryUsed ?? secondary.used_percent ?? 0);
  const snapshotAge = timeAgo(latest.timestamp);

  setText(
    "rateContext",
    `${rate.limit_id || latest.selectedLimitId || "unknown limit"} · ${rate.plan_type || "unknown plan"} · 本地快照 · ${snapshotAge}`
  );
  setText("primaryLabel", windowLabel(primary.window_minutes, "primary"));
  setText("secondaryLabel", windowLabel(secondary.window_minutes, "secondary"));
  setText("primaryUsed", `${Math.round(primaryUsed)}%`);
  setText("secondaryUsed", `${Math.round(secondaryUsed)}%`);
  setText("primaryReset", `${remainingUntil(primary.resets_at)} · ${resetTime(primary.resets_at)} 重置`);
  setText("secondaryReset", `${remainingUntil(secondary.resets_at)} · ${resetTime(secondary.resets_at)} 重置`);
  setBar("primaryBar", primaryUsed);
  setBar("secondaryBar", secondaryUsed);
}

function pathForPoints(points) {
  return points
    .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
}

function smoothPath(points) {
  if (points.length < 3) return pathForPoints(points);
  const commands = [`M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const midX = (current.x + next.x) / 2;
    commands.push(
      `C${midX.toFixed(2)},${current.y.toFixed(2)} ${midX.toFixed(2)},${next.y.toFixed(2)} ${next.x.toFixed(2)},${next.y.toFixed(2)}`
    );
  }
  return commands.join(" ");
}

function niceMax(value) {
  const raw = Math.max(1, Number(value || 0));
  const power = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / power;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * power;
}

function axisTicks(max, count = 4) {
  const top = niceMax(max);
  return Array.from({ length: count + 1 }, (_, index) => (top / count) * index);
}

function rateBounds(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return { min: 0, max: 1 };
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const spread = Math.max(0.02, max - min);
  return {
    min: Math.max(0, min - spread * 0.22),
    max: Math.min(1, max + spread * 0.22)
  };
}

function scale(value, domainMin, domainMax, rangeMin, rangeMax) {
  if (domainMax <= domainMin) return rangeMax;
  const ratio = (Number(value || 0) - domainMin) / (domainMax - domainMin);
  return rangeMin + ratio * (rangeMax - rangeMin);
}

function renderTrend() {
  const days = state.data.recentDays.filter((day) => day.sessions > 0);
  if (!days.length) {
    $("trendChart").innerHTML = "<p class=\"muted\">暂无数据</p>";
    return;
  }

  const model = activeModel();
  const width = 1120;
  const height = 470;
  const pad = { top: 30, right: 92, bottom: 54, left: 78 };
  const chartW = width - pad.left - pad.right;
  const mainH = 274;
  const mainBottom = pad.top + mainH;
  const cacheTop = mainBottom + 52;
  const cacheH = 82;
  const cacheBottom = cacheTop + cacheH;
  const maxTokens = niceMax(Math.max(...days.map((day) => day.totalTokens)));
  const costs = days.map((day) => calcCost(day, model).totalCost);
  const maxCost = niceMax(Math.max(...costs));
  const cacheBounds = rateBounds(days.map((day) => day.cacheHitRate || 0));
  const band = chartW / Math.max(1, days.length);
  const barW = Math.max(7, Math.min(34, band * 0.56));
  const xMidFor = (index) => pad.left + band * index + band / 2;
  const xFor = (index) => xMidFor(index) - barW / 2;
  const tokenTicks = axisTicks(maxTokens, 4);
  const costTicks = axisTicks(maxCost, 4);
  const cacheTicks = [cacheBounds.min, (cacheBounds.min + cacheBounds.max) / 2, cacheBounds.max];
  const labelEvery = Math.max(1, Math.ceil(days.length / 8));

  const bars = days
    .map((day, index) => {
      const x = xFor(index);
      const y = scale(day.totalTokens, 0, maxTokens, mainBottom, pad.top);
      const h = mainBottom - y;
      const label = day.day.slice(5);
      return `<g>
        <rect class="bar-total" x="${x}" y="${y}" width="${barW}" height="${h}" rx="4">
          <title>${day.day}: ${formatInt(day.totalTokens)} tokens / ${formatUsd(calcCost(day, model).totalCost)}</title>
        </rect>
        ${
          index % labelEvery === 0 || index === days.length - 1
            ? `<text class="axis axis-x" x="${xMidFor(index)}" y="${height - 18}" text-anchor="middle">${label}</text>`
            : ""
        }
      </g>`;
    })
    .join("");

  const costPoints = days.map((day, index) => {
    const x = xMidFor(index);
    const cost = calcCost(day, model).totalCost;
    const y = scale(cost, 0, maxCost, mainBottom, pad.top);
    return { x, y, cost };
  });

  const cachePoints = days.map((day, index) => {
    const x = xMidFor(index);
    const y = scale(day.cacheHitRate || 0, cacheBounds.min, cacheBounds.max, cacheBottom, cacheTop);
    return { x, y, rate: day.cacheHitRate || 0 };
  });

  const leftAxis = tokenTicks
    .map((tick) => {
      const y = scale(tick, 0, maxTokens, mainBottom, pad.top);
      return `<g>
        <line class="grid-line" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" />
        <text class="axis" x="${pad.left - 12}" y="${y + 4}" text-anchor="end">${formatCompact(tick)}</text>
      </g>`;
    })
    .join("");

  const rightAxis = costTicks
    .map((tick) => {
      const y = scale(tick, 0, maxCost, mainBottom, pad.top);
      return `<text class="axis" x="${width - pad.right + 12}" y="${y + 4}">${formatUsd(tick)}</text>`;
    })
    .join("");

  const cacheAxis = cacheTicks
    .map((tick) => {
      const y = scale(tick, cacheBounds.min, cacheBounds.max, cacheBottom, cacheTop);
      return `<g>
        <line class="grid-line grid-line-soft" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" />
        <text class="axis" x="${pad.left - 12}" y="${y + 4}" text-anchor="end">${shortPct(tick)}</text>
      </g>`;
    })
    .join("");

  const dots = costPoints
    .map(
      (point, index) =>
        `<circle class="dot-cost" cx="${point.x}" cy="${point.y}" r="3.6"><title>${days[index].day}: ${formatUsd(point.cost)}</title></circle>`
    )
    .join("");

  const lastIndex = days.length - 1;
  const latestTokenY = scale(days[lastIndex].totalTokens, 0, maxTokens, mainBottom, pad.top);
  const latestCostPoint = costPoints[lastIndex];
  const latestCachePoint = cachePoints[lastIndex];
  const cacheArea = cachePoints.length
    ? `M${cachePoints[0].x.toFixed(2)},${cacheBottom} ${pathForPoints(cachePoints).replace(/^M/, "L")} L${cachePoints[lastIndex].x.toFixed(2)},${cacheBottom} Z`
    : "";

  $("trendChart").innerHTML = `<div class="chart-legend">
      <span><i class="legend-bar"></i>Total tokens</span>
      <span><i class="legend-cost"></i>Estimated cost</span>
      <span><i class="legend-cache"></i>Cache hit rate</span>
    </div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="daily token trend">
    <defs>
      <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#b8ddf0" stop-opacity="0.95" />
        <stop offset="100%" stop-color="#d8eff3" stop-opacity="0.58" />
      </linearGradient>
      <linearGradient id="cacheAreaGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffd19c" stop-opacity="0.28" />
        <stop offset="100%" stop-color="#ffd19c" stop-opacity="0.02" />
      </linearGradient>
    </defs>
    <rect class="plot-bg" x="${pad.left}" y="${pad.top}" width="${chartW}" height="${mainH}" rx="8"></rect>
    <rect class="plot-bg plot-bg-soft" x="${pad.left}" y="${cacheTop}" width="${chartW}" height="${cacheH}" rx="8"></rect>
    ${leftAxis}
    ${rightAxis}
    ${cacheAxis}
    <line class="axis-line" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${mainBottom}" />
    <line class="axis-line" x1="${width - pad.right}" y1="${pad.top}" x2="${width - pad.right}" y2="${mainBottom}" />
    <line class="axis-line" x1="${pad.left}" y1="${mainBottom}" x2="${width - pad.right}" y2="${mainBottom}" />
    <line class="axis-line" x1="${pad.left}" y1="${cacheBottom}" x2="${width - pad.right}" y2="${cacheBottom}" />
    <text class="axis axis-title" x="${pad.left}" y="${pad.top - 12}">tokens</text>
    <text class="axis axis-title" x="${width - pad.right}" y="${pad.top - 12}" text-anchor="end">cost</text>
    <text class="axis axis-title" x="${pad.left}" y="${cacheTop - 12}">cache hit</text>
    ${bars}
    <path class="line-cost" d="${smoothPath(costPoints)}" />
    ${dots}
    ${cacheArea ? `<path class="area-cache" d="${cacheArea}" />` : ""}
    <path class="line-cache" d="${smoothPath(cachePoints)}" />
    <circle class="dot-latest" cx="${xMidFor(lastIndex)}" cy="${latestTokenY}" r="4"><title>${days[lastIndex].day}: ${formatInt(days[lastIndex].totalTokens)} tokens</title></circle>
    <text class="value-label" x="${Math.min(width - pad.right - 38, xMidFor(lastIndex) + 10)}" y="${Math.max(pad.top + 18, latestTokenY - 10)}">${formatCompact(days[lastIndex].totalTokens)}</text>
    <text class="value-label value-label-cost" x="${Math.max(pad.left + 8, latestCostPoint.x - 58)}" y="${Math.max(pad.top + 18, latestCostPoint.y - 10)}">${formatUsd(latestCostPoint.cost)}</text>
    <text class="value-label value-label-cache" x="${Math.max(pad.left + 8, latestCachePoint.x - 54)}" y="${Math.max(cacheTop + 16, latestCachePoint.y - 8)}">${shortPct(latestCachePoint.rate)}</text>
  </svg>`;
}

function renderMonthOverview() {
  const months = state.data.byMonth.filter((item) => item.sessions > 0).slice(-8);
  $("monthOverview").innerHTML = months
    .map((item) => {
      const month = item.month;
      const activeDays = state.data.byDay.filter((day) => day.day.startsWith(month) && day.sessions > 0);
      const avg = activeDays.length ? (item.totalTokens || 0) / activeDays.length : 0;
      const cost = calcCost(item).totalCost;
      return `<div class="month-block">
        <span class="pill">${month}</span>
        <strong>${formatCompact(item.totalTokens || 0)}</strong>
        <small>${formatUsd(cost)} · ${activeDays.length} active days</small>
        <div class="mini-grid">
          <div><span>活跃日均</span><b>${formatCompact(avg)}</b></div>
          <div><span>Sessions</span><b>${formatInt(item.sessions || 0)}</b></div>
          <div><span>缓存命中</span><b>${pct(item.cacheHitRate || 0)}</b></div>
          <div><span>输出</span><b>${formatCompact(item.outputTokens || 0)}</b></div>
        </div>
      </div>`;
    })
    .join("");
}

function renderTopDays() {
  $("topDays").innerHTML = state.data.topDays
    .slice(0, 8)
    .map((day) => {
      const cost = calcCost(day).totalCost;
      return `<tr>
        <td>${day.day}</td>
        <td class="numeric">${formatInt(day.sessions)}</td>
        <td class="numeric">${formatCompact(day.totalTokens)}</td>
        <td class="numeric">${formatUsd(cost)}</td>
      </tr>`;
    })
    .join("");
}

function renderTopSessions() {
  $("topSessions").innerHTML = state.data.topSessions
    .slice(0, 8)
    .map(
      (session) => `<tr>
        <td>${session.day}</td>
        <td class="numeric">${formatCompact(session.totalTokens)}</td>
        <td class="numeric">${pct(session.cacheHitRate)}</td>
        <td class="file-cell" title="${session.file}">${session.file}</td>
      </tr>`
    )
    .join("");
}

function renderAll() {
  renderControls();
  renderSummary();
  renderRate();
  renderTrend();
  renderMonthOverview();
  renderTopDays();
  renderTopSessions();
}

async function refresh({ rotateTheme = false } = {}) {
  $("refreshBtn").disabled = true;
  $("refreshBtn").textContent = "刷新中";
  try {
    const response = await fetch(`/api/summary?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    if (rotateTheme) {
      state.themeIndex = (state.themeIndex + 1) % themes.length;
      document.body.dataset.theme = themes[state.themeIndex];
    }
    renderAll();
  } catch (error) {
    setText("updatedAt", "读取失败，等待自动重试");
    setText("scanTime", error.message || "unknown error");
    if (!state.data) {
      setText("dataSource", "本地服务暂时不可用");
      setText("priceSource", "默认按 GPT-5.4 估算");
    }
  } finally {
    $("refreshBtn").disabled = false;
    $("refreshBtn").textContent = "刷新";
  }
}

function bindEvents() {
  $("refreshBtn").addEventListener("click", () => refresh({ rotateTheme: true }));
  $("modelSelect").addEventListener("change", (event) => {
    state.modelId = event.target.value;
    renderAll();
  });
  document.querySelectorAll(".range-tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".range-tabs button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.range = button.dataset.range;
      renderSummary();
    });
  });
  $("autoRefresh").addEventListener("change", (event) => {
    if (event.target.checked) {
      state.timer = window.setInterval(() => refresh(), state.refreshMs);
    } else {
      window.clearInterval(state.timer);
      state.timer = null;
    }
  });
}

bindEvents();
refresh();
state.timer = window.setInterval(() => refresh(), state.refreshMs);
