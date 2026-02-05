---
description: Telegram-style command handler for w3rt safe swaps (help/swap/confirm/receipt)
---

# w3rt-tg

This skill provides a strict, command-style chat interface for the w3rt harness.

It is intended to be used in chat (Telegram) via OpenClaw: the agent receives a message and runs the handler, then replies with its stdout.

## Commands

- `help`
- `swap SOL USDC 0.01` (dry-run preview; creates a pending swap for ~2 minutes)
- `I_CONFIRM` (executes the last pending swap)
- `receipt <planRunId>` (shows a human receipt and best-effort verification)

## Implementation

Use:

```bash
cd /home/davirain/clawd/web3AIRuntime
node scripts/w3rt_tg_cli.mjs "<message text>"
```

State is stored in:

- `~/.w3rt/tmp/pending_swap.json`

## Safety

- Execution requires exact confirm phrase `I_CONFIRM`.
- Swap execution uses existing policy + simulate-before-send.
- Produces artifacts in `~/.w3rt/runs/<runId>/` and uses `w3rt_verify_run.mjs` for verification.
