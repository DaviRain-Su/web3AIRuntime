open Types

module SSet = Set.Make (String)

let action_to_step (a : action) : plan_step =
  { id = a.id; tool = a.tool; params = a.params; depends_on = a.depends_on }

let rec canonical_json (j : Yojson.Safe.t) : Yojson.Safe.t =
  match j with
  | `Assoc kvs ->
      let kvs' =
        kvs
        |> List.map (fun (k, v) -> (k, canonical_json v))
        |> List.sort (fun (a, _) (b, _) -> String.compare a b)
      in
      `Assoc kvs'
  | `List xs -> `List (List.map canonical_json xs)
  | (`Null | `Bool _ | `Int _ | `Intlit _ | `Float _ | `String _) as x -> x

let sha256_hex (s : string) : string = Digestif.SHA256.(to_hex (digest_string s))

let step_to_json (s : plan_step) : Yojson.Safe.t =
  `Assoc
    [
      ("id", `String s.id);
      ("tool", `String s.tool);
      ("params", canonical_json s.params);
      ("dependsOn", `List (List.map (fun d -> `String d) (List.sort String.compare s.depends_on)));
    ]

let plan_to_canonical_json (p : plan) : Yojson.Safe.t =
  `Assoc
    [
      ("schema", `String p.schema);
      ("workflow", `String p.workflow);
      ("steps", `List (List.map step_to_json p.steps));
    ]

let plan_hash (p : plan) : string =
  let canon = plan_to_canonical_json p |> Yojson.Safe.to_string in
  "sha256:" ^ sha256_hex canon

let hard_insert_balance_steps (_wf : workflow) (steps : plan_step list) : plan_step list =
  (* Hard policy: if there's any swap_exec, ensure balance_before and balance_after exist in the PLAN.
     We do NOT remove user-defined steps; we only add missing steps and patch deps.
  *)
  let has_swap_exec = List.exists (fun (s : plan_step) -> String.equal s.tool "w3rt_swap_exec") steps in
  if not has_swap_exec then steps
  else
    let ids = List.fold_left (fun acc (s : plan_step) -> SSet.add s.id acc) SSet.empty steps in

    let steps' =
      steps
      |> List.map (fun (s : plan_step) ->
             if String.equal s.tool "w3rt_swap_quote" then
               let deps = if List.mem "balance_before" s.depends_on then s.depends_on else "balance_before" :: s.depends_on in
               { s with depends_on = deps }
             else s)
    in

    let swap_exec_ids =
      steps'
      |> List.filter (fun (s : plan_step) -> String.equal s.tool "w3rt_swap_exec")
      |> List.map (fun s -> s.id)
    in

    let steps'' =
      steps'
      |> List.map (fun (s : plan_step) ->
             if String.equal s.id "balance_after" then
               let deps =
                 swap_exec_ids
                 |> List.fold_left (fun acc d -> if List.mem d acc then acc else d :: acc) s.depends_on
               in
               { s with depends_on = List.rev deps }
             else s)
    in

    let steps_final =
      (if SSet.mem "balance_before" ids then steps''
       else ({ id = "balance_before"; tool = "w3rt_balance"; params = `Assoc [ ("includeTokens", `Bool false) ]; depends_on = [] } : plan_step)
            :: steps'')
    in

    let ids2 = List.fold_left (fun acc (s : plan_step) -> SSet.add s.id acc) SSet.empty steps_final in

    if SSet.mem "balance_after" ids2 then steps_final
    else
      let deps = swap_exec_ids in
      steps_final
      @ [ ({ id = "balance_after"; tool = "w3rt_balance"; params = `Assoc [ ("includeTokens", `Bool false) ]; depends_on = deps } : plan_step) ]

let to_plan (wf : workflow) : plan =
  let base_steps = wf.actions |> List.map action_to_step in
  let steps = hard_insert_balance_steps wf base_steps in
  (* Keep step order deterministic *)
  let steps = List.sort (fun (a : plan_step) (b : plan_step) -> String.compare a.id b.id) steps in
  { schema = "w3rt.plan.v1"; workflow = wf.name; steps }

let plan_to_json (p : plan) : Yojson.Safe.t =
  let core = plan_to_canonical_json p in
  match core with
  | `Assoc kvs ->
      `Assoc
        (kvs
        @ [
            ( "meta",
              `Assoc
                [
                  ("planHash", `String (plan_hash p));
                  ("hashAlg", `String "sha256");
                  ("canonical", `Bool true);
                ] );
          ])
  | _ -> core
