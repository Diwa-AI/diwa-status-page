(async function () {
  const DAYS_TO_SHOW = 90;
  const STATUS_COPY = {
    up: { title: "All Systems Operational", badge: "Operational", cls: "" },
    degraded: {
      title: "Degraded Performance",
      badge: "Degraded",
      cls: "degraded",
    },
    down: { title: "Service Disruption", badge: "Down", cls: "down" },
  };

  // --- small helpers -------------------------------------------------

  function timeAgo(isoString) {
    if (!isoString) return "recently";
    const diffMs = Date.now() - new Date(isoString).getTime();
    const minutes = Math.round(diffMs / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 2) return "a minute ago";
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  function formatDateTime(isoString) {
    if (!isoString) return "";
    return new Date(isoString).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value ?? "";
    return div.innerHTML;
  }

  // Upptime's history/<slug>.yml files are flat "key: value" YAML with no
  // nesting, so a tiny line parser avoids pulling in a YAML library just
  // for the browser bundle.
  function parseFlatYaml(text) {
    const result = {};
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[match[1]] = value;
    }
    return result;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }

  async function fetchText(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.text();
  }

  // --- data assembly (mirrors scripts/build-status-data.mjs) --------

  function buildDailyBars(dailyMinutesDown, startTime) {
    const monitoringStart = startTime ? new Date(startTime) : null;
    if (monitoringStart) monitoringStart.setUTCHours(0, 0, 0, 0);
    const days = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    for (let i = DAYS_TO_SHOW - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setUTCDate(date.getUTCDate() - i);
      const key = date.toISOString().slice(0, 10);

      let state = "up";
      if (monitoringStart && date < monitoringStart) {
        state = "nodata";
      } else {
        const minutesDown = (dailyMinutesDown && dailyMinutesDown[key]) || 0;
        if (minutesDown >= 60) state = "down";
        else if (minutesDown > 0) state = "degraded";
      }
      days.push({ date: key, state });
    }
    return days;
  }

  function computeRealUptime(days, dailyMinutesDown) {
    const monitoredDays = days.filter((d) => d.state !== "nodata");
    if (monitoredDays.length === 0) return null;
    let totalMinutes = 0;
    let downMinutes = 0;
    for (const day of monitoredDays) {
      totalMinutes += 24 * 60;
      downMinutes += (dailyMinutesDown && dailyMinutesDown[day.date]) || 0;
    }
    const uptime = ((totalMinutes - downMinutes) / totalMinutes) * 100;
    return Math.round(uptime * 100) / 100;
  }

  function isIncidentIssue(issue, siteNames) {
    const title = issue.title || "";
    return (
      siteNames.some((name) => title.includes(name)) &&
      (title.includes("is down") || title.includes("has degraded performance"))
    );
  }

  async function loadIncidents({ owner, repo, siteNames }) {
    let issues;
    try {
      issues = await fetchJson(
        `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=50`
      );
    } catch (error) {
      console.warn("Could not load incidents from GitHub", error);
      return [];
    }

    const incidentIssues = issues.filter((issue) =>
      isIncidentIssue(issue, siteNames)
    );

    const incidents = [];
    for (const issue of incidentIssues) {
      let comments = [];
      try {
        comments = await fetchJson(
          `https://api.github.com/repos/${owner}/${repo}/issues/${issue.number}/comments`
        );
      } catch (error) {
        console.warn("Could not load comments for incident", issue.number, error);
      }

      const timeline = [
        { label: "Investigating", time: issue.created_at, body: issue.body || "" },
      ];
      for (const comment of comments) {
        timeline.push({
          label: "Update",
          time: comment.created_at,
          body: comment.body || "",
        });
      }
      if (issue.state === "closed" && issue.closed_at) {
        timeline.push({ label: "Resolved", time: issue.closed_at, body: "" });
      }

      const openedAt = new Date(issue.created_at);
      const closedAt = issue.closed_at ? new Date(issue.closed_at) : null;
      incidents.push({
        title: issue.title,
        url: issue.html_url,
        resolved: issue.state === "closed",
        openedAt: issue.created_at,
        durationMinutes: closedAt
          ? Math.round((closedAt - openedAt) / 60000)
          : null,
        timeline,
      });
    }

    incidents.sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
    return incidents;
  }

  // --- rendering -------------------------------------------------------

  function renderNav(navbar) {
    const nav = document.getElementById("topbar-nav");
    nav.innerHTML = "";
    for (const item of navbar || []) {
      const a = document.createElement("a");
      a.href = item.href;
      const isExternal = /^https?:\/\//.test(item.href);
      a.textContent = isExternal ? `${item.title} ↗` : item.title;
      if (isExternal) {
        a.target = "_blank";
        a.rel = "noopener";
      }
      nav.appendChild(a);
    }
  }

  // Overall page status/uptime reflect the least healthy monitored service.
  const STATUS_SEVERITY = { up: 0, degraded: 1, down: 2 };

  function worstStatus(sites) {
    return sites.reduce(
      (worst, site) =>
        STATUS_SEVERITY[site.status] > STATUS_SEVERITY[worst] ? site.status : worst,
      "up"
    );
  }

  function renderHero(sites, links) {
    const overallStatus = worstStatus(sites);
    const copy = STATUS_COPY[overallStatus] || STATUS_COPY.up;
    const mostRecentCheck = sites
      .map((site) => site.lastUpdated)
      .filter(Boolean)
      .sort()
      .pop();
    const uptimes = sites
      .map((site) => site.uptime90d)
      .filter((value) => value !== null);

    document.getElementById("hero-icon").className = `hero-icon ${copy.cls}`;
    document.getElementById("hero-title").textContent = copy.title;
    document.getElementById(
      "hero-subtitle"
    ).textContent = `Last checked ${timeAgo(
      mostRecentCheck
    )} · checks run automatically every 5 minutes`;

    const pill = document.getElementById("uptime-pill");
    pill.textContent = uptimes.length === 0
      ? "Collecting uptime data — monitoring just started"
      : `${Math.min(...uptimes).toFixed(2)}% uptime — last 90 days`;

    document.getElementById("github-button").href = links.github;
    document.getElementById("rss-button").href = links.rss;
  }

  function renderServices(sites) {
    const container = document.getElementById("services");
    container.innerHTML = "";
    for (const site of sites) {
      renderServiceRow(container, site);
    }
  }

  function renderServiceRow(container, site) {
    const copy = STATUS_COPY[site.status] || STATUS_COPY.up;

    const row = document.createElement("div");
    row.className = "service-row";

    const head = document.createElement("div");
    head.className = "service-head";
    head.innerHTML = `
      <div class="service-name-block">
        <span class="status-dot ${copy.cls}"></span>
        <div>
          <div class="service-name">${escapeHtml(site.name)}</div>
          <div class="service-url">${escapeHtml(
            site.url.replace(/^https?:\/\//, "")
          )}</div>
        </div>
      </div>
      <div class="service-meta">
        <span class="service-uptime">${
          site.uptime90d === null ? "–" : site.uptime90d.toFixed(2) + "% uptime"
        }</span>
        <span class="status-badge ${copy.cls}">${copy.badge}</span>
      </div>
    `;
    row.appendChild(head);

    const strip = document.createElement("div");
    strip.className = "bar-strip";
    for (const day of site.days) {
      const bar = document.createElement("div");
      bar.className = `bar ${day.state === "up" ? "" : day.state}`;
      bar.title = `${day.date}: ${
        day.state === "nodata" ? "not yet monitored" : day.state
      }`;
      strip.appendChild(bar);
    }
    row.appendChild(strip);

    const labels = document.createElement("div");
    labels.className = "bar-labels";
    labels.innerHTML = `<span>${site.days.length} days ago</span><span>Today</span>`;
    row.appendChild(labels);

    container.appendChild(row);
  }

  function renderIncidents(incidents) {
    const container = document.getElementById("incidents");
    if (!incidents.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No incidents reported in the last 90 days.";
      container.appendChild(empty);
      return;
    }

    for (const incident of incidents) {
      const card = document.createElement("article");
      card.className = "incident-card";

      const durationText = incident.durationMinutes
        ? ` · ${incident.durationMinutes}m`
        : "";
      card.innerHTML = `
        <div class="incident-head">
          <div>
            <h3 class="incident-title">${escapeHtml(incident.title)}</h3>
            <div class="incident-meta">${formatDateTime(
              incident.openedAt
            )}${durationText}</div>
          </div>
          <span class="status-badge ${incident.resolved ? "" : "down"}">${
        incident.resolved ? "Resolved" : "Ongoing"
      }</span>
        </div>
      `;

      const timeline = document.createElement("div");
      timeline.className = "incident-timeline";
      for (const step of incident.timeline) {
        const stepEl = document.createElement("div");
        stepEl.className = `timeline-step ${
          step.label === "Resolved" ? "resolved" : ""
        }`;
        stepEl.innerHTML = `
          <div><span class="timeline-label">${escapeHtml(
            step.label
          )}</span> <span class="timeline-time">— ${formatDateTime(
          step.time
        )}</span></div>
          ${
            step.body
              ? `<div class="timeline-body">${escapeHtml(step.body)}</div>`
              : ""
          }
        `;
        timeline.appendChild(stepEl);
      }
      card.appendChild(timeline);
      container.appendChild(card);
    }
  }

  // --- main -------------------------------------------------------------

  try {
    const config = await fetchJson("./config.json");
    const { owner, repo, sites: siteConfigs, page, links } = config;
    const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD`;

    const summary = await fetchJson(`${rawBase}/history/summary.json`);

    const sites = await Promise.all(
      siteConfigs.map(async (siteConfig) => {
        const historyText = await fetchText(
          `${rawBase}/history/${siteConfig.slug}.yml`
        ).catch(() => "");

        const siteSummary =
          summary.find((s) => s.slug === siteConfig.slug) || {};
        const history = historyText ? parseFlatYaml(historyText) : {};

        const days = buildDailyBars(
          siteSummary.dailyMinutesDown,
          history.startTime
        );
        const uptime90d = computeRealUptime(days, siteSummary.dailyMinutesDown);

        return {
          name: siteConfig.name,
          url: siteConfig.url,
          status: history.status || siteSummary.status || "up",
          lastUpdated: history.lastUpdated || null,
          uptime90d,
          days,
        };
      })
    );

    renderNav(page.navbar);
    renderHero(sites, links);
    renderServices(sites);
    document.getElementById("footer-message").textContent = page.introMessage;

    const incidents = await loadIncidents({
      owner,
      repo,
      siteNames: siteConfigs.map((siteConfig) => siteConfig.name),
    });
    renderIncidents(incidents);
  } catch (error) {
    console.error("Failed to load status data", error);
    document.getElementById("hero-title").textContent =
      "Unable to load status data";
  }
})();
