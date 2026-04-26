const state = {
  data: null,
  modelId: "gpt-5.4",
  range: "last7",
  timer: null,
  themeIndex: 0
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

  setText("dataSource", state.data.meta.sessionsRoot);
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

  setText(
    "rateContext",
    `${rate.plan_type || "unknown plan"} · ${latest.day} · current reset window peak`
  );
  setText("primaryUsed", `${primaryUsed.toFixed(1)}%`);
  setText("secondaryUsed", `${secondaryUsed.toFixed(1)}%`);
  setText("primaryReset", `reset ${resetTime(primary.resets_at)} · ${primary.window_minutes || "-"} min`);
  setText("secondaryReset", `reset ${resetTime(secondary.resets_at)} · ${secondary.window_minutes || "-"} min`);
  setBar("primaryBar", primaryUsed);
  setBar("secondaryBar", secondaryUsed);
}

function pathForPoints(points) {
  return points
    .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
}

function renderTrend() {
  const days = state.data.recentDays.filter((day) => day.sessions > 0);
  if (!days.length) {
    $("trendChart").innerHTML = "<p class=\"muted\">暂无数据</p>";
    return;
  }

  const model = activeModel();
  const width = 1000;
  const height = 430;
  const pad = { top: 18, right: 26, bottom: 46, left: 62 };
  const chartW = width - pad.left - pad.right;
  const topH = 205;
  const bottomTop = pad.top + topH + 58;
  const bottomH = 92;
  const maxTokens = Math.max(...days.map((day) => day.totalTokens));
  const costs = days.map((day) => calcCost(day, model).totalCost);
  const maxCost = Math.max(...costs);
  const maxCache = 1;
  const gap = 8;
  const barW = Math.max(6, chartW / days.length - gap);
  const xFor = (index) => pad.left + index * (chartW / days.length) + gap / 2;
  const xMidFor = (index) => xFor(index) + barW / 2;

  const bars = days
    .map((day, index) => {
      const x = xFor(index);
      const h = maxTokens ? (day.totalTokens / maxTokens) * topH * 0.74 : 0;
      const y = pad.top + topH - h;
      const label = day.day.slice(5);
      return `<g>
        <rect class="bar-total" x="${x}" y="${y}" width="${barW}" height="${h}" rx="4">
          <title>${day.day}: ${formatInt(day.totalTokens)} tokens</title>
        </rect>
        ${index % Math.ceil(days.length / 8) === 0 ? `<text class="axis" x="${x}" y="${height - 16}">${label}</text>` : ""}
      </g>`;
    })
    .join("");

  const costPoints = days.map((day, index) => {
    const x = xMidFor(index);
    const cost = calcCost(day, model).totalCost;
    const y = pad.top + topH - (maxCost ? (cost / maxCost) * topH * 0.74 : 0);
    return { x, y, cost };
  });

  const cachePoints = days.map((day, index) => {
    const x = xMidFor(index);
    const y = bottomTop + bottomH - ((day.cacheHitRate || 0) / maxCache) * bottomH;
    return { x, y, rate: day.cacheHitRate || 0 };
  });

  const dots = costPoints
    .map(
      (point, index) =>
        `<circle class="dot-cost" cx="${point.x}" cy="${point.y}" r="4"><title>${days[index].day}: ${formatUsd(point.cost)}</title></circle>`
    )
    .join("");

  const maxDayIndex = days.findIndex((day) => day.totalTokens === maxTokens);
  const lastIndex = days.length - 1;
  const labels = [maxDayIndex, lastIndex]
    .filter((value, index, array) => value >= 0 && array.indexOf(value) === index)
    .map((index) => {
      const x = xMidFor(index);
      const h = maxTokens ? (days[index].totalTokens / maxTokens) * topH * 0.74 : 0;
      const y = pad.top + topH - h - 9;
      return `<text class="value-label" x="${x}" y="${Math.max(18, y)}" text-anchor="middle">${formatCompact(days[index].totalTokens)}</text>`;
    })
    .join("");

  $("trendChart").innerHTML = `<div class="chart-legend">
      <span><i class="legend-bar"></i>Total tokens</span>
      <span><i class="legend-cost"></i>Estimated cost</span>
      <span><i class="legend-cache"></i>Cache hit rate</span>
    </div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="daily token trend">
    <rect class="plot-bg" x="${pad.left}" y="${pad.top}" width="${chartW}" height="${topH}" rx="10"></rect>
    <rect class="plot-bg" x="${pad.left}" y="${bottomTop}" width="${chartW}" height="${bottomH}" rx="10"></rect>
    <line class="grid-line" x1="${pad.left}" y1="${pad.top + topH}" x2="${width - pad.right}" y2="${pad.top + topH}" />
    <line class="grid-line" x1="${pad.left}" y1="${pad.top + topH * 0.5}" x2="${width - pad.right}" y2="${pad.top + topH * 0.5}" />
    <line class="grid-line" x1="${pad.left}" y1="${bottomTop + bottomH}" x2="${width - pad.right}" y2="${bottomTop + bottomH}" />
    <line class="grid-line" x1="${pad.left}" y1="${bottomTop + bottomH * 0.2}" x2="${width - pad.right}" y2="${bottomTop + bottomH * 0.2}" />
    <text class="axis" x="10" y="${pad.top + 14}">${formatCompact(maxTokens)}</text>
    <text class="axis" x="${width - 142}" y="${pad.top + 14}">${formatUsd(maxCost)} peak</text>
    <text class="axis" x="16" y="${bottomTop + 12}">100%</text>
    <text class="axis" x="22" y="${bottomTop + bottomH - 4}">0%</text>
    ${bars}
    ${labels}
    <path class="line-cost" d="${pathForPoints(costPoints)}" />
    ${dots}
    <path class="line-cache" d="${pathForPoints(cachePoints)}" />
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
      state.timer = window.setInterval(() => refresh(), 30_000);
    } else {
      window.clearInterval(state.timer);
      state.timer = null;
    }
  });
}

bindEvents();
refresh();
state.timer = window.setInterval(() => refresh(), 30_000);
