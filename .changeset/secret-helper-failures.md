---
'@newrelic/preflight': patch
---

**A failing secret helper could stop the dashboard or send the digest to the wrong webhook.** Three cases are fixed.

- When `licenseKeyCommand` fails, the `--local` dashboard falls back to local mode, as it does for a missing license key, instead of exiting. This matters when nobody is there to answer the helper's Keychain or 1Password prompt, such as after an automatic update.
- When `digestWebhookUrlCommand` fails, the digest is not sent to a plaintext `digestWebhookUrl` left in the config file. The command outranks the file, so the file's URL is never a fallback.
- A blank `NEW_RELIC_AI_DIGEST_WEBHOOK_URL` no longer stops digests from sending to the URL in the config file.
