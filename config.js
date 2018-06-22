const config = {};

config.discord_webhook = process.env.DISCORD_WEBHOOK;
config.RAVEN_DSN = process.env.RAVEN_DSN;

module.exports = config;
