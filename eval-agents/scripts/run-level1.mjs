#!/usr/bin/env node
// Full GAIA validation Level 1 matrix (requires datasets download).

import {
  bringUpDaemons,
  installSignalHandlers,
  loadEnv,
  makeLog,
  runVitest,
  teardownDaemons,
} from "./_lib.mjs";

const log = makeLog("level1");
const cancellation = installSignalHandlers(log);

async function main() {
  let startedByUs = false;
  try {
    loadEnv();
    const daemons = await bringUpDaemons(log, { signal: cancellation.signal });
    const { chatUrl, embedUrl } = daemons;
    startedByUs = daemons.startedByUs;
    if (cancellation.signal.aborted) return 130;
    if (!chatUrl) {
      log("no chat llama URL");
      return 2;
    }

    const extraEnv = {
      ATOMIC_AGENT_EVAL_LLAMA_URL: chatUrl,
      ATOMIC_AGENT_GAIA_SOURCE: "hf",
      ATOMIC_AGENT_GAIA_LEVEL: "1",
      ATOMIC_AGENT_GAIA_MAX_STEPS: process.env.ATOMIC_AGENT_GAIA_MAX_STEPS ?? "40",
      ATOMIC_AGENT_GAIA_TIMEOUT_MS: process.env.ATOMIC_AGENT_GAIA_TIMEOUT_MS ?? "900000",
    };
    if (embedUrl) extraEnv.ATOMIC_AGENT_EVAL_EMBED_URL = embedUrl;

    const code = await runVitest({ extraEnv, forwarded: process.argv.slice(2), signal: cancellation.signal });
    return cancellation.signal.aborted ? 130 : code;
  } finally {
    await teardownDaemons(log, startedByUs);
    cancellation.dispose();
  }
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    if (cancellation.signal.aborted) process.exit(130);
    log(`fatal: ${err?.stack ?? err}`);
    process.exit(1);
  });
