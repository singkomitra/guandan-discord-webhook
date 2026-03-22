const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_DEPLOYMENTS_WEBHOOK_URL = process.env.DISCORD_DEPLOYMENTS_WEBHOOK_URL;
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
    }
  }
  return map;
}
const GITHUB_TO_DISCORD = buildDiscordMap();

function getMention(githubUsername) {
  const id = GITHUB_TO_DISCORD[githubUsername];
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
  if (!GITHUB_WEBHOOK_SECRET) return true;
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  hmac.update(req.rawBody);
  const digest = 'sha256=' + hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
  } catch {
    return false;
  }
}

async function sendDiscord(webhookUrl, content, embeds = []) {
  await axios.post(webhookUrl, { content, embeds });
}

// ── Event handlers ──────────────────────────────────────────────────────────

async function handlePullRequest(payload) {
  const { action, pull_request: pr, sender } = payload;
  const actor = getMention(sender.login);
  const fields = [];

  if (action === 'opened') {
    fields.push({ name: 'Changes', value: diffStats(pr), inline: true });
    const labels = labelList(pr);
    if (labels) fields.push({ name: 'Labels', value: labels, inline: true });
    if (pr.milestone) fields.push({ name: 'Milestone', value: pr.milestone.title, inline: true });
    fields.push({ name: 'Branch', value: `\`${pr.head.ref}\` → \`${pr.base.ref}\``, inline: false });

    await sendDiscord(DISCORD_WEBHOOK_URL, `${actor} opened a pull request`, [
      {
        author: {
          name: sender.login,
          icon_url: sender.avatar_url,
          url: `https://github.com/${sender.login}`,
        },
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
        author: {
          name: sender.login,
          icon_url: sender.avatar_url,
          url: `https://github.com/${sender.login}`,
        },
        title: `#${pr.number} ${pr.title}`,
        url: pr.html_url,
        color: 0x9b59b6,
        fields,
        timestamp: new Date().toISOString(),
      };

      // Post to PR channel
      await sendDiscord(DISCORD_WEBHOOK_URL, `${actor} merged a pull request`, [prEmbed]);

      // Post to deployments channel if merged into main
      if (pr.base.ref === 'main' && DISCORD_DEPLOYMENTS_WEBHOOK_URL) {
        await sendDiscord(
          DISCORD_DEPLOYMENTS_WEBHOOK_URL,
          `🚀 **Deployed to main**`,
          [
            {
              author: {
                name: `Merged by ${sender.login}`,
                icon_url: sender.avatar_url,
                url: `https://github.com/${sender.login}`,
              },
              title: `#${pr.number} ${pr.title}`,
              url: pr.html_url,
              description: truncate(pr.body),
              color: 0x9b59b6,
              fields,
              timestamp: new Date().toISOString(),
            },
          ]
        );
      }
    } else {
      await sendDiscord(DISCORD_WEBHOOK_URL, `${actor} closed a pull request without merging`, [
        {
          author: {
            name: sender.login,
            icon_url: sender.avatar_url,
            url: `https://github.com/${sender.login}`,
          },
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
      await sendDiscord(
        DISCORD_WEBHOOK_URL,
        `${actor} requested a review from ${reviewerMention}`,
        [
          {
            author: {
              name: sender.login,
              icon_url: sender.avatar_url,
              url: `https://github.com/${sender.login}`,
            },
            title: `#${pr.number} ${pr.title}`,
            url: pr.html_url,
            color: 0xf1c40f,
            timestamp: new Date().toISOString(),
          },
        ]
      );
    }
  }
}

async function handlePullRequestReview(payload) {
  const { action, review, pull_request: pr, sender } = payload;
  if (action !== 'submitted') return;

  const reviewer = getMention(sender.login);
  const prAuthor = getMention(pr.user.login);

  if (review.state === 'approved') {
    await sendDiscord(
      DISCORD_WEBHOOK_URL,
      `${reviewer} approved ${prAuthor}'s pull request`,
      [
        {
          author: {
            name: sender.login,
            icon_url: sender.avatar_url,
            url: `https://github.com/${sender.login}`,
          },
          title: `#${pr.number} ${pr.title} ✅`,
          url: pr.html_url,
          color: 0x2ecc71,
          timestamp: new Date().toISOString(),
        },
      ]
    );
  } else if (review.state === 'changes_requested') {
    await sendDiscord(
      DISCORD_WEBHOOK_URL,
      `${reviewer} requested changes on ${prAuthor}'s pull request`,
      [
        {
          author: {
            name: sender.login,
            icon_url: sender.avatar_url,
            url: `https://github.com/${sender.login}`,
          },
          title: `#${pr.number} ${pr.title} 🔄`,
          url: pr.html_url,
          description: truncate(review.body),
          color: 0xe67e22,
          timestamp: new Date().toISOString(),
        },
      ]
    );
  } else if (review.state === 'commented' && review.body) {
    await sendDiscord(
      DISCORD_WEBHOOK_URL,
      `${reviewer} left a review on ${prAuthor}'s pull request`,
      [
        {
          author: {
            name: sender.login,
            icon_url: sender.avatar_url,
            url: `https://github.com/${sender.login}`,
          },
          title: `#${pr.number} ${pr.title}`,
          url: pr.html_url,
          description: truncate(review.body),
          color: 0x3498db,
          timestamp: new Date().toISOString(),
        },
      ]
    );
  }
}

async function handleReviewComment(payload) {
  const { action, comment, pull_request: pr, sender } = payload;
  if (action !== 'created') return;

  const commenter = getMention(sender.login);

  await sendDiscord(DISCORD_WEBHOOK_URL, `${commenter} commented on a pull request`, [
    {
      author: {
        name: sender.login,
        icon_url: sender.avatar_url,
        url: `https://github.com/${sender.login}`,
      },
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
  if (action !== 'created') return;

  const commenter = getMention(sender.login);

  await sendDiscord(DISCORD_WEBHOOK_URL, `${commenter} commented on a pull request`, [
    {
      author: {
        name: sender.login,
        icon_url: sender.avatar_url,
        url: `https://github.com/${sender.login}`,
      },
      title: `#${issue.number} ${issue.title}`,
      url: comment.html_url,
      description: truncate(comment.body),
      color: 0x3498db,
      timestamp: new Date().toISOString(),
    },
  ]);
}

// ── Route ───────────────────────────────────────────────────────────────────

app.post('/github', async (req, res) => {
  if (!verifySignature(req)) {
    console.warn('Invalid signature');
    return res.status(401).send('Unauthorized');
  }

  const event = req.headers['x-github-event'];
  const payload = req.body;

  try {
    if (event === 'pull_request') {
      await handlePullRequest(payload);
    } else if (event === 'pull_request_review') {
      await handlePullRequestReview(payload);
    } else if (event === 'pull_request_review_comment') {
      await handleReviewComment(payload);
    } else if (event === 'issue_comment' && payload.issue?.pull_request) {
      await handleIssueComment(payload);
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling event:', err.message);
    res.status(500).send('Internal error');
  }
});

app.get('/', (_req, res) => res.send('Guandan webhook server running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
