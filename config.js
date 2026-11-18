// Self-hosted Renovate configuration shared by the Docker image and a
// Renovate checkout run from source. scripts/run.ts sets the environment.
module.exports = {
  platform: 'gerrit',
  endpoint: process.env.GERRIT_URL,
  username: 'renovate',
  password: process.env.RENOVATE_GERRIT_PASSWORD,
  repositories: ['code-review-minus-2-demo'],
  onboarding: false,
  requireConfig: 'optional',
  gitAuthor: 'Renovate <renovate@example.org>',
};
