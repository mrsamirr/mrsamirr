const { Octokit } = require("@octokit/rest");
const fs = require("fs");
const path = require("path");

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const USERNAME = process.env.GH_USERNAME || "mrsamirr";
const README_PATH = path.join(process.cwd(), "README.md");

// ─── Helpers ────────────────────────────────────────────────────────────────

function inject(content, tag, newBlock) {
  const open = `<!--${tag}-->`;
  const close = `<!--/${tag}-->`;
  const re = new RegExp(`${open}[\\s\\S]*?${close}`, "g");
  return content.replace(re, `${open}\n${newBlock}\n${close}`);
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;
  return `${Math.floor(months / 12)} years ago`;
}

// ─── Fetchers ────────────────────────────────────────────────────────────────

async function getRecentRepos() {
  const { data } = await octokit.repos.listForUser({
    username: USERNAME,
    sort: "created",
    direction: "desc",
    per_page: 5,
    type: "owner",
  });

  return data
    .filter((r) => !r.fork)
    .slice(0, 5)
    .map((r) => {
      const desc = r.description ? ` - ${r.description}` : "";
      return `- **[${r.full_name}](${r.html_url})**${desc}`;
    })
    .join("\n");
}

async function getRecentStars() {
  const { data } = await octokit.activity.listReposStarredByUser({
    username: USERNAME,
    per_page: 5,
    headers: { Accept: "application/vnd.github.star+json" },
  });

  return data
    .slice(0, 5)
    .map((item) => {
      // response shape differs based on accept header support
      const repo = item.repo || item;
      const starredAt = item.starred_at ? ` (${timeAgo(item.starred_at)})` : "";
      const desc = repo.description ? ` - ${repo.description}` : "";
      return `- **[${repo.full_name}](${repo.html_url})**${desc}${starredAt}`;
    })
    .join("\n");
}

async function getRecentReleases() {
  // Get repos the user has recently contributed to (org repos only, exclude personal)
  const { data: events } = await octokit.activity.listPublicEventsForUser({
    username: USERNAME,
    per_page: 100,
  });

  // Get unique repos from push events, excluding personal repos
  const pushRepos = [
    ...new Set(
      events
        .filter((e) => e.type === "PushEvent" && !e.repo.name.startsWith(`${USERNAME}/`))
        .map((e) => e.repo.name)
    ),
  ].slice(0, 15);

  const releases = [];

  for (const repoFullName of pushRepos) {
    const [owner, repo] = repoFullName.split("/");
    try {
      const { data } = await octokit.repos.getLatestRelease({ owner, repo });
      releases.push({
        name: `${repoFullName} @ ${data.tag_name}`,
        url: data.html_url,
        published: data.published_at,
      });
    } catch {
      // no releases — skip
    }
    if (releases.length >= 5) break;
  }

  // If no releases found, show recent commits to org repos instead (deduplicated by repo)
  if (releases.length === 0) {
    const seenRepos = new Set();
    const orgCommits = [];

    for (const e of events) {
      if (e.type !== "PushEvent" || e.repo.name.startsWith(`${USERNAME}/`)) continue;
      if (seenRepos.has(e.repo.name)) continue;

      seenRepos.add(e.repo.name);
      const commits = e.payload.commits || [];
      const msg = commits.length > 0 ? commits[commits.length - 1].message.split("\n")[0] : "commits";
      const shortMsg = msg.length > 50 ? msg.slice(0, 50) + "..." : msg;
      orgCommits.push(`- [${e.repo.name}](https://github.com/${e.repo.name}) — ${shortMsg} (${timeAgo(e.created_at)})`);

      if (orgCommits.length >= 5) break;
    }

    if (orgCommits.length === 0) return "- Nothing yet — check back soon!";
    return orgCommits.join("\n");
  }

  return releases
    .sort((a, b) => new Date(b.published) - new Date(a.published))
    .map((r) => `- [${r.name}](${r.url}) (${timeAgo(r.published)})`)
    .join("\n");
}

async function getRecentActivity() {
  const { data: events } = await octokit.activity.listPublicEventsForUser({
    username: USERNAME,
    per_page: 100,
  });

  const lines = [];
  const seenRepos = new Set(); // avoid duplicate repos in a row

  for (const event of events) {
    if (lines.length >= 5) break;

    // Skip consecutive events from same repo for cleaner output
    const repoKey = `${event.repo.name}-${event.type}`;

    if (event.type === "PullRequestEvent" && event.payload.action === "opened") {
      const pr = event.payload.pull_request;
      lines.push(
        `- [${event.repo.name}](https://github.com/${event.repo.name}) ➔ **[${pr.title}](${pr.html_url})** - ${timeAgo(event.created_at)}`
      );
      seenRepos.add(repoKey);
    } else if (event.type === "PushEvent" && !seenRepos.has(repoKey)) {
      const commits = event.payload.commits || [];
      if (commits.length > 0) {
        const msg = commits[commits.length - 1].message.split("\n")[0].slice(0, 60);
        const displayMsg = commits[commits.length - 1].message.split("\n")[0].length > 60 ? msg + "..." : msg;
        lines.push(
          `- [${event.repo.name}](https://github.com/${event.repo.name}) ➔ **${displayMsg}** - ${timeAgo(event.created_at)}`
        );
        seenRepos.add(repoKey);
      }
    } else if (event.type === "CreateEvent" && event.payload.ref_type === "repository") {
      lines.push(
        `- Created **[${event.repo.name}](https://github.com/${event.repo.name})** - ${timeAgo(event.created_at)}`
      );
    } else if (event.type === "IssuesEvent" && event.payload.action === "opened") {
      const issue = event.payload.issue;
      lines.push(
        `- [${event.repo.name}](https://github.com/${event.repo.name}) ➔ **[${issue.title}](${issue.html_url})** - ${timeAgo(event.created_at)}`
      );
    } else if (event.type === "PullRequestReviewEvent") {
      const pr = event.payload.pull_request;
      const prUrl = pr.html_url || `https://github.com/${event.repo.name}/pull/${pr.number}`;
      lines.push(
        `- Reviewed [${event.repo.name}#${pr.number}](${prUrl}) - ${timeAgo(event.created_at)}`
      );
    }
  }

  if (lines.length === 0) return "- No public activity yet!";
  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching GitHub data for", USERNAME, "...");

  const [repos, stars, releases, activity] = await Promise.all([
    getRecentRepos(),
    getRecentStars(),
    getRecentReleases(),
    getRecentActivity(),
  ]);

  let readme = fs.readFileSync(README_PATH, "utf8");

  readme = inject(readme, "RECENT_REPOS", repos);
  readme = inject(readme, "RECENT_STARS", stars);
  readme = inject(readme, "RECENT_RELEASES", releases);
  readme = inject(readme, "RECENT_ACTIVITY", activity);

  fs.writeFileSync(README_PATH, readme, "utf8");
  console.log("README.md updated ✓");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
