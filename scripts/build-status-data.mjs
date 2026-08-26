#!/usr/bin/env node
// Builds the static assets for the custom Diwa AI status page.
//
// Only branding/config that rarely changes (owner/repo, site name/url,
// intro text, navbar) is baked in at build time, as config.json. Uptime,
// response time, and incident data are fetched LIVE by the browser
// (web/app.js) directly from GitHub's raw content CDN and REST API - the
// same "always up-to-date" approach Upptime's own default template uses -
// so the page never shows stale data between deploys.
//
// The one exception is feed.xml (RSS): feed readers don't execute
// JavaScript, so that has to be generated as a static file here.
//
// No server, no database - this only runs inside the existing GitHub
// Actions workflow, right before the static site is deployed to gh-pages.

import { readFile, writeFile, mkdir, cp } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "web-dist");

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function readYaml(relPath) {
  const raw = await readFile(path.join(ROOT, relPath), "utf8");
  return yaml.load(raw);
}

async function githubRequest(pathname, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "diwa-status-build-script",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${pathname}`, { headers });
  if (!res.ok) {
    console.warn(`GitHub API request failed (${res.status}): ${pathname}`);
    return null;
  }
  return res.json();
}

// Upptime opens issues titled "🛑 {name} is down" or "⚠️ {name} has degraded
// performance", and closes them automatically on recovery. See
// upptime/uptime-monitor's src/update.ts. There is no dedicated label by
// default, so we match on title, against any of the monitored site names.
function isIncidentIssue(issue, siteNames) {
  const title = issue.title || "";
  return (
    siteNames.some((name) => title.includes(name)) &&
    (title.includes("is down") || title.includes("has degraded performance"))
  );
}

async function buildIncidentsForFeed({ owner, repo, siteNames, token }) {
  const issues = await githubRequest(
    `/repos/${owner}/${repo}/issues?state=all&per_page=50`,
    token
  );
  if (!issues) return [];
  return issues
    .filter((issue) => isIncidentIssue(issue, siteNames))
    .map((issue) => ({
      title: issue.title,
      url: issue.html_url,
      resolved: issue.state === "closed",
      openedAt: issue.created_at,
    }))
    .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
}

function escapeXml(value) {
  return String(value ?? "").replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return c;
    }
  });
}

function buildRssFeed({ siteUrl, name, incidents }) {
  const items = incidents
    .map(
      (incident) => `    <item>
      <title>${escapeXml(incident.title)}</title>
      <link>${escapeXml(incident.url)}</link>
      <guid>${escapeXml(incident.url)}</guid>
      <pubDate>${new Date(incident.openedAt).toUTCString()}</pubDate>
      <description>${escapeXml(
        incident.resolved ? "Resolved" : "Ongoing"
      )}</description>
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(name)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>Incident history for ${escapeXml(name)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

async function main() {
  const config = await readYaml(".upptimerc.yml");
  const { owner, repo } = config;
  const sites = config.sites; // v1: a small, fixed list of real, checkable services
  const websiteConfig = config["status-website"] || {};

  const token = process.env.GH_PAT || process.env.GITHUB_TOKEN;
  const incidents = await buildIncidentsForFeed({
    owner,
    repo,
    siteNames: sites.map((site) => site.name),
    token,
  });

  const configData = {
    generatedAt: new Date().toISOString(),
    owner,
    repo,
    sites: sites.map((site) => ({
      name: site.name,
      url: site.url,
      slug: slugify(site.name),
    })),
    page: {
      name: websiteConfig.name || "Status",
      introMessage: websiteConfig.introMessage || "",
      navbar: websiteConfig.navbar || [],
    },
    links: {
      rss: "./feed.xml",
      github: `https://github.com/${owner}/${repo}`,
    },
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    path.join(OUT_DIR, "config.json"),
    JSON.stringify(configData, null, 2)
  );
  await writeFile(
    path.join(OUT_DIR, "feed.xml"),
    buildRssFeed({
      siteUrl: `https://github.com/${owner}/${repo}`,
      name: websiteConfig.name || "Diwa AI Status",
      incidents,
    })
  );

  await cp(path.join(ROOT, "web"), OUT_DIR, { recursive: true });
  await mkdir(path.join(OUT_DIR, "assets"), { recursive: true });
  await cp(
    path.join(ROOT, "assets", "diwa-logo.png"),
    path.join(OUT_DIR, "assets", "diwa-logo.png")
  );

  console.log(
    `Built status page shell for ${sites
      .map((site) => site.name)
      .join(", ")} (${incidents.length} incidents in feed) -> ${OUT_DIR}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
