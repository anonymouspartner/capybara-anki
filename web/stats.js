// The stats screen — step 6 of docs/DESIGN.md's build order. Plain JS, no build
// step, same as every other page in web/: fetch /sync/stats, render four things
// (streak, success rate, total reviews, a day-by-day activity chart) plus the
// collection's current state composition.

import { captureTokenFromUrl, getToken } from "./auth.js";
import { API_BASE } from "./config.js";

const contentEl = document.getElementById("content");

async function api(path) {
  const res = await fetch(API_BASE + path, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

function formatPercent(fraction) {
  return fraction === null ? "—" : `${Math.round(fraction * 100)}%`;
}

/** A stacked bar per day, each bar's height relative to the busiest day in the
 * window (not to a fixed scale) — so a quiet week doesn't render as a flat line
 * and a heavy one doesn't clip. Segments within a bar are relative to that day's
 * own total, using the same Again/Hard/Good/Easy colors as the reviewer's rating
 * buttons (theme.css's --btn-* tokens) so the chart reads the same language. */
function renderChart(days) {
  const maxTotal = Math.max(1, ...days.map((d) => d.again + d.hard + d.good + d.easy));
  const bars = days.map((d) => {
    const total = d.again + d.hard + d.good + d.easy;
    const barPct = (total / maxTotal) * 100;
    const segPct = (n) => (total > 0 ? (n / total) * 100 : 0);
    return `
      <div class="chart-bar" style="height:${barPct}%" title="${d.date}: ${total} review${total === 1 ? "" : "s"}">
        <div class="seg-again" style="height:${segPct(d.again)}%"></div>
        <div class="seg-hard" style="height:${segPct(d.hard)}%"></div>
        <div class="seg-good" style="height:${segPct(d.good)}%"></div>
        <div class="seg-easy" style="height:${segPct(d.easy)}%"></div>
      </div>
    `;
  }).join("");
  return `
    <div id="chart">${bars}</div>
    <div id="chart-range">
      <span>${days[0]?.date ?? ""}</span>
      <span>${days[days.length - 1]?.date ?? ""}</span>
    </div>
  `;
}

function render(stats) {
  contentEl.innerHTML = `
    <div class="stat-row">
      <span class="stat-label">Current streak</span>
      <span class="stat-value">${stats.currentStreak} day${stats.currentStreak === 1 ? "" : "s"}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Success rate</span>
      <span class="stat-value">${formatPercent(stats.successRate)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Total reviews</span>
      <span class="stat-value">${stats.totalReviews}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Lapses (Again)</span>
      <span class="stat-value">${stats.lapseCount}</span>
    </div>
    <div id="chart-title">Last ${stats.reviewsByDay.length} days</div>
    ${renderChart(stats.reviewsByDay)}
    <div id="composition">
      <div class="comp-block"><div class="comp-count new">${stats.cardCounts.newCount}</div><div class="comp-label">New</div></div>
      <div class="comp-block"><div class="comp-count learning">${stats.cardCounts.learningCount}</div><div class="comp-label">Learning</div></div>
      <div class="comp-block"><div class="comp-count review">${stats.cardCounts.reviewCount}</div><div class="comp-label">Review</div></div>
      <div class="comp-block"><div class="comp-count">${stats.cardCounts.suspendedCount}</div><div class="comp-label">Suspended</div></div>
    </div>
  `;
}

async function main() {
  captureTokenFromUrl();
  if (!getToken()) {
    contentEl.innerHTML = `<div id="error">No access token. Open your install link again.</div>`;
    return;
  }
  try {
    render(await api("/sync/stats"));
  } catch (e) {
    contentEl.innerHTML = `<div id="error">Couldn't load stats.</div>`;
    console.error(e);
  }
}

main();
