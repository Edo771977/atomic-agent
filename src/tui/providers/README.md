# Provider management UI

Status: current
Owner: src/tui/providers/

This feature owns provider rows, configuration wizard state, input and presentation. Read [TUI instructions](../AGENTS.md); provider persistence follows [config instructions](../../config/AGENTS.md) and requests follow [LLM instructions](../../llm/AGENTS.md).

## Entries and state

[ProvidersPanel](providers-panel.tsx) renders rows and confirmations from [panel state](providers-panel-state.ts). [ProvidersWizard](providers-wizard.tsx) renders the shared add/configure flow; [measurement](providers-wizard-measure.ts) supplies its row budget to the wizard and onboarding layout. [Wizard state](providers-wizard-state.ts), [reducer](providers-reducer.ts), [keys](providers-key-bindings.ts), [wizard keys](providers-wizard-key-bindings.ts) and [list keys](providers-wizard-list-keys.ts) own transitions. [The list adapter](wizard-pick-list.tsx) binds the shared pick-list to the displayed wizard, preserving keyboard/mouse activation and the existing paste route.

## Operations and lifetime

[ProvidersOrchestrator](providers-orchestrator.ts) projects the runtime registry, fetches model lists, guards stale responses, verifies credentials before saving, and requests live switching. [Save](save-provider-wizard.ts), [verification](verify-wizard-before-save.ts) and [contract probe](probe-wizard-contract.ts) are explicit seams. Validated config, credentials and cache invalidation belong to [config commands](../../config/llm-provider-commands.ts); a persisted change and a failed live apply are distinct outcomes. Active pins, model rollback and abort guards must survive UI changes.

[CloudProviderOnboarding](cloud-provider-onboarding.tsx) retains its standalone API and cancellation/probe tests, although it currently has no production consumer. Its mounted verification owns its abort/unmount guards. The wizard still contains catalog fetch effects; this relocation did not move them into a controller. Onboarding and LLM modals intentionally compose the provider wizard; generic list/input primitives do not depend on it.

The shared provider writer automatically saves a [model behavior default](../../llm/docs/model-mode.md) for new connections: `cloud` for recognized cloud services and subscription CLIs, `local` for local or unknown endpoints. The v75 config migration also enables cloud policy for existing recognized cloud connections without a saved flag. The wizard returns the saved entry and preserves existing settings on reconfiguration after migration. Switching policy currently uses `/llm model-mode`, whose submit handler persists settings through config commands; it does not hot-swap the provider or change a running turn's snapshot.

Keys follow the address (ATO-1066). The wizard resolves a key with the entry's new base URL, so a server on another computer on the network never receives the shared compat variables; a key typed for any endpoint the shared variables are not sent to (another computer, or plain http:// off this machine) is saved under the entry's own `ATOMIC_AGENT_KEY_<ID>` variable and named on the key screen, never in the shared one; a reconfigure reads and saves back only the key literally written in `config.json` (an `apiKeyEnvVar` stays a variable) ([stored entry](stored-provider-entry.ts)), never from the env-filled runtime config, and a key saved for a different server does not follow the entry to another computer. While a shared variable is set and no key of the server's own is, the key screen says it is not sent there, and a 401/403 from a request that carried no key [says so](describe-model-list-error.ts) instead of calling a key rejected. The URL screen is left only with a plain address ([check](base-url-line-error.ts)): no credentials, query, fragment or whitespace.

## Checks

Run `npx vitest run src/tui/providers src/tui/llm-panel src/tui/onboarding` for wizard consumers, including real mouse, filtering, cancellation, contract probing and persisted/live behavior. Run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`. Tests live beside their source; the [LLM guide](../llm-panel/README.md) locates the other composition surface.
