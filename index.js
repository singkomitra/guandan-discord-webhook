const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
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

async function sendDiscord(content, embeds = []) {
  await axios.post(DISCORD_WEBHOOK_URL, { content, embeds });
}

// ── Event handlers ──────────────────────────────────────────────────────────

async function handlePullRequest(payload) {
  const { action, pull_request: pr, sender } = payload;
  const prLink = `[#${pr.number} ${pr.title}](${pr.html_url})`;
  const actor = getMention(sender.login);

  if (action === 'opened') {
    await sendDiscord(`${actor} opened PR ${prLink}`, [
      {
        description: pr.body || '_No description provided._',
        color: 0x2ecc71,
      },
    ]);
  } else if (action === 'closed') {
    if (pr.merged) {
      await sendDiscord(`${actor} merged PR ${prLink} 🎉`, [
        { color: 0x9b59b6 },
      ]);
    } else {
      await sendDiscord(`${actor} closed PR ${prLink} without merging`, [
        { color: 0xe74c3c },
      ]);
    }
  } else if (action === 'review_requested') {
    const reviewer = payload.requested_reviewer?.login;
    if (reviewer) {
      const reviewerMention = getMention(reviewer);
      await sendDiscord(
        `${actor} requested a review from ${reviewerMention} on PR ${prLink}`
      );
    }
  }
}

async function handlePullRequestReview(payload) {
  const { action, review, pull_request: pr, sender } = payload;
  if (action !== 'submitted') return;

  const prLink = `[#${pr.number} ${pr.title}](${pr.html_url})`;
  const reviewer = getMention(sender.login);
  const prAuthor = getMention(pr.user.login);

  if (review.state === 'approved') {
    await sendDiscord(
      `${reviewer} approved ${prAuthor}'s PR ${prLink} ✅`
    );
  } else if (review.state === 'changes_requested') {
    await sendDiscord(
      `${reviewer} requested changes on ${prAuthor}'s PR ${prLink} 🔄`,
      [
        {
          description: review.body || '_No comment left._',
          color: 0xe67e22,
        },
      ]
    );
  } else if (review.state === 'commented' && review.body) {
    await sendDiscord(`${reviewer} left a review on PR ${prLink}`, [
      {
        description: review.body,
        color: 0x3498db,
      },
    ]);
  }
}

async function handleReviewComment(payload) {
  const { action, comment, pull_request: pr, sender } = payload;
  if (action !== 'created') return;

  const prLink = `[#${pr.number} ${pr.title}](${pr.html_url})`;
  const commenter = getMention(sender.login);

  await sendDiscord(`${commenter} commented on PR ${prLink}`, [
    {
      description: comment.body,
      color: 0x3498db,
      url: comment.html_url,
    },
  ]);
}

async function handleIssueComment(payload) {
  const { action, comment, issue, sender } = payload;
  if (action !== 'created') return;

  const prLink = `[#${issue.number} ${issue.title}](${issue.html_url})`;
  const commenter = getMention(sender.login);

  await sendDiscord(`${commenter} commented on PR ${prLink}`, [
    {
      description: comment.body,
      color: 0x3498db,
      url: comment.html_url,
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
