# Pi SDK integration

We currently integrate with Pi via an **extension file**.

## Build first

```bash
bun install
bun run build
```

## Start Pi with w3rt extension loaded

From repo root:

```bash
pi -e packages/pi/dist/pi-extension.js
```

Or:

```bash
bun run pi
```

## Commands inside Pi

- `/w3rt.run <workflowPath>`
  - Example: `/w3rt.run workflows/solana_swap_exact_in.yaml`
- `/w3rt.trace <runId>`
- `/w3rt.replay <runId> --workflow workflows/solana_swap_exact_in.yaml`
- `/w3rt.policy.suggest <runId>`

## Approval UI

The extension uses `ctx.ui.confirm()` when available to request approvals.
