const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_PR_CHANNEL_ID = process.env.DISCORD_PR_CHANNEL_ID;
const DISCORD_DEPLOYMENTS_CHANNEL_ID = process.env.DISCORD_DEPLOYMENTS_CHANNEL_ID;
const DISCORD_ISSUES_CHANNEL_ID = process.env.DISCORD_ISSUES_CHANNEL_ID;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

// Map GitHub usernames → Discord user IDs
// Stored as individual env vars: DISCORD_ID_<GITHUB_USERNAME_UPPERCASE>
// e.g. DISCORD_ID_PAOLOGUM=449805392369942558
function buildDiscordMap() {
  const map = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith('DISCORD_ID_')) {
      const githubUsername = key.replace('DISCORD_ID_', '').toLowerCase();
      map[githubUsername] = val;
      console.log(`[config] Mapped GitHub user "${githubUsername}" to Discord ID "${val}"`);
    }
  }
  return map;
}
const GITHUB_TO_DISCORD = buildDiscordMap();

console.log(`[config] DISCORD_BOT_TOKEN set: ${!!DISCORD_BOT_TOKEN}`);
console.log(`[config] DISCORD_PR_CHANNEL_ID: ${DISCORD_PR_CHANNEL_ID}`);
console.log(`[config] DISCORD_DEPLOYMENTS_CHANNEL_ID: ${DISCORD_DEPLOYMENTS_CHANNEL_ID}`);
console.log(`[config] DISCORD_ISSUES_CHANNEL_ID: ${DISCORD_ISSUES_CHANNEL_ID}`);
console.log(`[config] GITHUB_WEBHOOK_SECRET set: ${!!GITHUB_WEBHOOK_SECRET}`);

function getMention(githubUsername) {
  const id = GITHUB_TO_DISCORD[githubUsername];
  if (!id) console.warn(`[mention] No Discord ID mapped for GitHub user "${githubUsername}"`);
  return id ? `<@${id}>` : `\`${githubUsername}\``;
}

function truncate(str, max = 300) {
  if (!str) return '_No description provided._';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function diffStats(pr) {
  return `\`+${pr.additions}\` \`-${pr.deletions}\` · 📁 ${pr.changed_files} file${pr.changed_files === 1 ? '' : 's'}`;
}

function labelList(pr) {
  if (!pr.labels?.length) return null;
  return pr.labels.map((l) => `\`${l.name}\``).join(' ');
}

// Preserve raw body for signature verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

function verifySignature(req) {
  if (!GITHUB_WEBHOOK_SECRET) {
    console.warn('[auth] No webhook secret set — skipping signature check');
    return true;
  }
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) {
    console.warn('[auth] Request missing x-hub-signature-256 header');
    return false;
  }
  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  hmac.update(req.rawBody);
  const digest = 'sha256=' + hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
  } catch {
    return false;
  }
}

async function sendDiscord(channelId, channelLabel, content, embeds = [], retries = 3) {
  if (!channelId) {
    console.warn(`[discord] Skipping send to ${channelLabel} — channel ID not configured`);
    return;
  }
  console.log(`[discord] Sending to ${channelLabel}: "${content}"`);
  try {
    const res = await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { content, embeds },
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[discord] ${channelLabel} responded ${res.status}`);
  } catch (err) {
    if (err.response?.status === 429 && retries > 0) {
      const retryAfter = (err.response.data?.retry_after ?? 1) * 1000;
      console.warn(`[discord] Rate limited on ${channelLabel} — full response: ${JSON.stringify(err.response.data)}`);
      console.warn(`[discord] Retrying in ${retryAfter}ms... (${retries} retries left)`);
      await new Promise((r) => setTimeout(r, retryAfter));
      return sendDiscord(channelId, channelLabel, content, embeds, retries - 1);
    }
    console.error(`[discord] Failed to send to ${channelLabel}: ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
    throw err;
  }
}

// ── Event handlers ──────────────────────────────────────────────────────────

async function handlePullRequest(payload) {
  const { action, pull_request: pr, sender } = payload;
  console.log(`[pr] action="${action}" pr=#${pr.number} sender=${sender.login}`);
  const actor = getMention(sender.login);
  const fields = [];

  if (action === 'opened') {
    fields.push({ name: 'Changes', value: diffStats(pr), inline: true });
    const labels = labelList(pr);
    if (labels) fields.push({ name: 'Labels', value: labels, inline: true });
    if (pr.milestone) fields.push({ name: 'Milestone', value: pr.milestone.title, inline: true });
    fields.push({ name: 'Branch', value: `\`${pr.head.ref}\` → \`${pr.base.ref}\``, inline: false });

    await sendDiscord(DISCORD_PR_CHANNEL_ID, '#pull-requests', `${actor} opened a pull request`, [
      {
        author: { name: sender.login, icon_url: sender.avatar_url, url: `https://github.com/${sender.login}` },
        title: `#${pr.number} ${pr.title}`,
        url: pr.html_url,
        description: truncate(pr.body),
        color: 0x2ecc71,
        fields,
        timestamp: new Date().toISOString(),
      },
    ]);
  } else if (action === 'closed') {
    if (pr.merged) {
      fields.push({ name: 'Changes', value: diffStats(pr), inline: true });
      const labels = labelList(pr);
      if (labels) fields.push({ name: 'Labels', value: labels, inline: true });
      if (pr.milestone) fields.push({ name: 'Milestone', value: pr.milestone.title, inline: true });

      const prEmbed = {
        author: { name: sender.login, icon_url: sender.avatar_url, url: `https://github.com/${sender.login}` },
        title: `#${pr.number} ${pr.title}`,
        url: pr.html_url,
        color: 0x9b59b6,
        fields,
        timestamp: new Date().toISOString(),
      };

      await sendDiscord(DISCORD_PR_CHANNEL_ID, '#pull-requests', `${actor} merged a pull request`, [prEmbed]);

      if (pr.base.ref === 'main') {
        console.log(`[pr] Merged into main — posting to #deployments`);
        await sendDiscord(DISCORD_DEPLOYMENTS_CHANNEL_ID, '#deployments', `🚀 **Deployed to main**`, [
          {
            author: { name: `Merged by ${sender.login}`, icon_url: sender.avatar_url, url: `https://github.com/${sender.login}` },
            title: `#${pr.number} ${pr.title}`,
            url: pr.html_url,
            description: truncate(pr.body),
            color: 0x9b59b6,
            fields,
            timestamp: new Date().toISOString(),
          },
        ]);
      } else {
        console.log(`[pr] Merged into "${pr.base.ref}" (not main) — skipping #deployments`);
      }
    } else {
      await sendDiscord(DISCORD_PR_CHANNEL_ID, '#pull-requests', `${actor} closed a pull request without merging`, [
        {
          author: { name: sender.login, icon_url: sender.avatar_url, url: `https://github.com/${sender.login}` },
          title: `#${pr.number} ${pr.title}`,
          url: pr.html_url,
          color: 0xe74c3c,
          timestamp: new Date().toISOString(),
        },
      ]);
    }
  } else if (action === 'review_requested') {
    const reviewer = payload.requested_reviewer?.login;
    if (reviewer) {
      const reviewerMention = getMention(reviewer);
      await sendDiscord(DISCORD_PR_CHANNEL_ID, '#pull-requests', `${actor} requested a review from ${reviewerMention}`, [
        {
          author: { name: sender.login, icon_url: sender.avatar_url, url: `https://github.com/${sender.login}` },
          title: `#${pr.number} ${pr.title}`,
          url: pr.html_url,
          color: 0xf1c40f,
          timestamp: new Date().toISOString(),
        },
      ]);
    }
  } else {
    console.log(`[pr] Ignoring unhandled action "${action}"`);
  }
}

async function handlePullRequestReview(payload) {
  const { action, review, pull_request: pr, sender } = payload;
  console.log(`[review] action="${action}" state="${review.state}" pr=#${pr.number} sender=${sender.login}`);
  if (action !== 'submitted') return;

  const reviewer = getMention(sender.login);
  const prAuthor = getMention(pr.user.login);

  if (review.state === 'approved') {
    await sendDiscord(DISCORD_PR_CHANNEL_ID, '#pull-requests', `${reviewer} approved ${prAuthor}'s pull request`, [
      {
        author: { name: sender.login, icon_url: sender.avatar_url, url: `https://github.com/${sender.login}` },
        title: `#${pr.number} ${pr.title} ✅`,
        url: pr.html_url,
        color: 0x2ecc71,
        timestamp: new Date().toISOString(),
      },
    ]);
  } else if (review.state === 'changes_requested') {
    await sendDiscord(DISCORD_PR_CHANNEL_ID, '#pull-requests', `${reviewer} requested changes on ${prAuthor}'s pull request`, [
      {
        author: { name: sender.login, icon_url: sender.avatar_url, url: `https://github.com/${sender.login}` },
        title: `#${pr.number} ${pr.title} 🔄`,
        url: pr.html_url,
        description: truncate(review.body),
        color: 0xe67e22,
        timestamp: new Date().toISOString(),
      },
    ]);
  } else if (review.state === 'commented' && review.body) {
    await sendDiscord(DISCORD_PR_CHANNEL_ID, '#pull-requests', `${reviewer} left a review on ${prAuthor}'s pull request`, [
      {
        author: { name: sender.login, icon_url: sender.avatar_url, url: `https://github.com/${sender.login}` },
        title: `#${pr.number} ${pr.title}`,
        url: pr.html_url,
        description: truncate(review.body),
        color: 0x3498db,
        timestamp: new Date().toISOString(),
      },
    ]);
  } else {
    console.log(`[review] Ignoring state "${review.state}" (no body or unhandled)`);
  }
}

async function handleReviewComment(payload) {
  const { action, comment, pull_request: pr, sender } = payload;
  console.log(`[review-comment] action="${action}" pr=#${pr.number} sender=${sender.login}`);
  if (action !== 'created') return;

  const commenter = getMention(sender.login);
  await sendDiscord(DISCORD_PR_CHANNEL_ID, '#pull-requests', `${commenter} commented on a pull request`, [
    {
      author: { name: sender.login, icon_url: sender.avatar_url, url: `https://github.com/${sender.login}` },
      title: `#${pr.number} ${pr.title}`,
      url: comment.html_url,
      description: truncate(comment.body),
      color: 0x3498db,
      timestamp: new Date().toISOString(),
    },
  ]);
}

async function handleIssueComment(payload) {
  const { action, comment, issue, sender } = payload;
  console.log(`[issue-comment] action="${action}" issue=#${issue.number} sender=${sender.login}`);
  if (action !== 'created') return;

  const commenter = getMention(sender.login);
  await sendDiscord(DISCORD_PR_CHANNEL_ID, '#pull-requests', `${commenter} commented on a pull request`, [
    {
      author: { name: sender.login, icon_url: sender.avatar_url, url: `https://github.com/${sender.login}` },
      title: `#${issue.number} ${issue.title}`,
      url: comment.html_url,
      description: truncate(comment.body),
      color: 0x3498db,
      timestamp: new Date().toISOString(),
    },
  ]);
}

async function handleIssue(payload) {
  const { action, issue, assignee, sender } = payload;
  console.log(`[issue] action="${action}" issue=#${issue.number} sender=${sender.login} assignee=${assignee?.login ?? 'none'}`);
  if (action !== 'assigned' || !assignee) return;

  const assigneeMention = getMention(assignee.login);
  const actor = getMention(sender.login);

  await sendDiscord(DISCORD_ISSUES_CHANNEL_ID, '#issues', `${actor} assigned ${assigneeMention} to an issue`, [
    {
      author: { name: sender.login, icon_url: sender.avatar_url, url: `https://github.com/${sender.login}` },
      title: `#${issue.number} ${issue.title}`,
      url: issue.html_url,
      description: truncate(issue.body),
      color: 0xe67e22,
      fields: labelList(issue) ? [{ name: 'Labels', value: labelList(issue), inline: true }] : [],
      timestamp: new Date().toISOString(),
    },
  ]);
}

// ── Route ───────────────────────────────────────────────────────────────────

app.post('/github', async (req, res) => {
  if (!verifySignature(req)) {
    console.warn('[auth] Signature verification failed — rejecting request');
    return res.status(401).send('Unauthorized');
  }

  const event = req.headers['x-github-event'];
  const action = req.body?.action;
  console.log(`[webhook] Received event="${event}" action="${action}"`);

  // Respond to GitHub immediately so it doesn't time out
  res.status(200).send('OK');

  // Process asynchronously in the background
  (async () => {
    try {
      if (event === 'issues') {
        await handleIssue(req.body);
      } else if (event === 'pull_request') {
        await handlePullRequest(req.body);
      } else if (event === 'pull_request_review') {
        await handlePullRequestReview(req.body);
      } else if (event === 'pull_request_review_comment') {
        await handleReviewComment(req.body);
      } else if (event === 'issue_comment' && req.body.issue?.pull_request) {
        await handleIssueComment(req.body);
      } else {
        console.log(`[webhook] No handler for event="${event}" action="${action}" — ignoring`);
      }
    } catch (err) {
      console.error(`[webhook] Error handling event="${event}" action="${action}": ${err.message}`);
      if (err.response?.data) console.error(`[webhook] Response body: ${JSON.stringify(err.response.data)}`);
    }
  })();
});

app.get('/', (_req, res) => res.send('Guandan webhook server running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[server] Listening on port ${PORT}`));
