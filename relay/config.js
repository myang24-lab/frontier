// Relay config: loads relay/.env if present, then validates.
// Dependency-free on purpose — this project keeps its dep list short, and a .env
// parser is twenty lines. Real environment variables always win over the file,
// so hosting platforms that inject config work without a .env at all.
const fs = require('fs');
const path = require('path');

function loadEnvFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return; } // absent is fine
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    const quoted = (val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"));
    if (quoted) val = val.slice(1, -1);
    else val = val.split(' #')[0].trim(); // trailing comment, unquoted values only
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(path.join(__dirname, '.env'));

const config = {
  port: Number(process.env.PORT) || 8787,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
};

// Fail at startup with the exact fix, rather than booting fine and failing
// confusingly on the first real call.
config.require = function require_() {
  if (!config.anthropicApiKey) {
    console.error(`
✕ ANTHROPIC_API_KEY is not set — the relay can't reach the Claude API without it.

  Fix:
      cp relay/.env.example relay/.env
  then paste your key into relay/.env

  Get a key at https://console.anthropic.com — billing must be attached.
  relay/.env is gitignored; never commit a key.
`);
    process.exit(1);
  }
  if (!config.anthropicApiKey.startsWith('sk-ant-')) {
    // Not fatal — OAuth tokens are also valid — but a pasted-wrong key is the
    // most common cause of a confusing 401 on the first call.
    console.warn("⚠ ANTHROPIC_API_KEY doesn't look like an API key (expected it to start with 'sk-ant-'). Continuing anyway.");
  }
  return config;
};

module.exports = config;
