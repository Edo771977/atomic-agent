#!/usr/bin/env node
// Full GAIA validation Level 1 matrix (requires datasets download).

import {
  bringUpDaemons,
  installSignalHandlers,
  loadEnv,
  makeLog,
  registerSyncTeardown,
  runVitest,
  teardownDaemons,
} from "./_lib.mjs";

const log = makeLog("level1");
const cancellation = installSignalHandlers(log);

async function main() {
  let startedByUs = false;
  let unregisterTeardown = () => {};
  try {
    loadEnv();
    const daemons = await bringUpDaemons(log, { signal: cancellation.signal });
    const { chatUrl, embedUrl } = daemons;
    startedByUs = daemons.startedByUs;
    // A second signal exits without reaching the finally below.
    if (startedByUs) unregisterTeardown = registerSyncTeardown(() => teardownDaemons(log, true));
    if (cancellation.signal.aborted) return cancellation.exitCode;
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
    return cancellation.signal.aborted ? cancellation.exitCode : code;
  } finally {
    unregisterTeardown();
    await teardownDaemons(log, startedByUs);
    cancellation.dispose();
  }
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    if (cancellation.signal.aborted) process.exit(cancellation.exitCode);
    log(`fatal: ${err?.stack ?? err}`);
    process.exit(1);
  });
