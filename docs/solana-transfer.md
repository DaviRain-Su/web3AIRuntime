# Solana transfer

## Workflow

- `workflows/solana_transfer.yaml`

This workflow:
- builds a transfer transaction (SOL or SPL)
- simulates
- asks for approval
- sends + confirms

## Tools

### `solana_build_transfer_tx`
Params:
- `to` (required) destination pubkey
- `amount` (required)
  - if `tokenMint` omitted: SOL amount (ui)
  - if `tokenMint` provided: token amount (ui)
- `tokenMint` (optional) mint address for SPL transfer
- `createAta` (optional, default true) create destination ATA if missing

### `solana_simulate_tx`, `solana_send_tx`, `solana_confirm_tx`
See swap workflow.

## Artifacts
- `built_build.json` (transfer tx)
- `simulation_simulate.json`
- `submitted_send.json`
- `confirmed_confirm.json`
