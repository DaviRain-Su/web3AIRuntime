# ocaml-scheduler (w3rt-scheduler)

A minimal OCaml CLI that validates and compiles a workflow JSON file into a stable plan JSON (`w3rt.plan.v1`).

This is the **workflow/scheduler brain** (OCaml), meant to be used from OpenClaw skills/CLI.

## Why OCaml / OxCaml direction

Scheduler logic is state-machine / DAG-heavy. OCaml is great for correctness and maintainability here.

## Install toolchain (Ubuntu 24.04)

This repo currently does **not** have OCaml installed by default.

```bash
sudo apt-get update
sudo apt-get install -y opam ocaml dune
opam init -y
opam switch create 4.14.2
opam install -y yojson cmdliner dune
```

## Build

```bash
cd ocaml-scheduler
opam exec -- dune build
```

Binary will be in `_build/default/bin/main.exe`.

## Run

```bash
# Validate
opam exec -- dune exec -- w3rt-scheduler validate examples/workflow.json

# Explain
opam exec -- dune exec -- w3rt-scheduler explain examples/workflow.json

# Compile to plan JSON
opam exec -- dune exec -- w3rt-scheduler compile examples/workflow.json --out /tmp/plan.json
cat /tmp/plan.json
```

## Workflow JSON schema (minimal)

```json
{
  "name": "my-workflow",
  "actions": [
    {
      "id": "step1",
      "tool": "some_tool",
      "params": { "any": "json" },
      "dependsOn": []
    }
  ]
}
```

## Output plan format

```json
{
  "schema": "w3rt.plan.v1",
  "workflow": "my-workflow",
  "steps": [
    { "id": "step1", "tool": "some_tool", "params": {"any":"json"}, "dependsOn": [] }
  ]
}
```

## Next steps

- Add a strict JSON schema + better error messages
- Add policy compilation (limits, allowlists)
- Add deterministic hashing of plan artifacts
- Add OpenClaw skill that calls `w3rt-scheduler compile` then runs each step
