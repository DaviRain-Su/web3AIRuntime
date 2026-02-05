open Cmdliner

(* Prevent interactive pagers in non-interactive/automation environments *)
let () =
  try Unix.putenv "CMDLINER_TERMPAGER" "cat" with _ -> ()

let write_file path s =
  let oc = open_out path in
  output_string oc s;
  output_char oc '\n';
  close_out oc

let cmd_validate input =
  let wf = W3rt_scheduler.Parser.from_file input in
  match W3rt_scheduler.Dag.validate wf with
  | Ok () ->
      Printf.printf "OK: %s (%d actions)\n" wf.name (List.length wf.actions);
      `Ok ()
  | Error e -> `Error (false, e)

let cmd_compile input out_path =
  let wf = W3rt_scheduler.Parser.from_file input in
  match W3rt_scheduler.Dag.validate wf with
  | Error e -> `Error (false, e)
  | Ok () ->
      let plan = W3rt_scheduler.Compile.to_plan wf |> W3rt_scheduler.Compile.plan_to_json in
      let s = Yojson.Safe.pretty_to_string plan in
      (match out_path with
      | None -> print_endline s
      | Some p -> write_file p s);
      `Ok ()

let cmd_explain input =
  let wf = W3rt_scheduler.Parser.from_file input in
  match W3rt_scheduler.Dag.validate wf with
  | Error e -> `Error (false, e)
  | Ok () ->
      let open W3rt_scheduler.Types in
      Printf.printf "Workflow: %s\n" wf.name;
      Printf.printf "Source actions: %d\n\n" (List.length wf.actions);

      Printf.printf "[Source]\n";
      wf.actions
      |> List.iter (fun (a : action) ->
             Printf.printf "- %s: %s" a.id a.tool;
             (match a.depends_on with
             | [] -> ()
             | ds -> Printf.printf "  (dependsOn: %s)" (String.concat "," ds));
             print_newline ());

      let plan = W3rt_scheduler.Compile.to_plan wf in
      let module SSet = Set.Make (String) in
      let src_ids =
        wf.actions
        |> List.fold_left (fun acc (a : action) -> SSet.add a.id acc) SSet.empty
      in
      let injected =
        plan.steps
        |> List.filter (fun (s : plan_step) -> not (SSet.mem s.id src_ids))
      in

      Printf.printf "\n[Compiled plan]\n";
      plan.steps
      |> List.iter (fun (s : plan_step) ->
             let tag = if SSet.mem s.id src_ids then "" else " (injected)" in
             Printf.printf "- %s: %s%s" s.id s.tool tag;
             (match s.depends_on with
             | [] -> ()
             | ds -> Printf.printf "  (dependsOn: %s)" (String.concat "," ds));
             print_newline ());

      (match injected with
      | [] -> ()
      | xs ->
          Printf.printf "\nInjected safety steps: %d\n" (List.length xs));

      `Ok ()

let input_arg =
  let doc = "Input workflow JSON path" in
  Arg.(required & pos 0 (some string) None & info [] ~docv:"WORKFLOW.json" ~doc)

let out_opt =
  let doc = "Write plan JSON to file instead of stdout" in
  Arg.(value & opt (some string) None & info [ "out" ] ~docv:"PLAN.json" ~doc)

let validate_cmd =
  let doc = "Validate workflow JSON (ids, deps, cycles)" in
  let term = Term.(ret (const cmd_validate $ input_arg)) in
  Cmd.v (Cmd.info "validate" ~doc) term

let compile_cmd =
  let doc = "Compile workflow JSON into w3rt.plan.v1 JSON" in
  let term = Term.(ret (const cmd_compile $ input_arg $ out_opt)) in
  Cmd.v (Cmd.info "compile" ~doc) term

let explain_cmd =
  let doc = "Explain workflow JSON in human-readable form" in
  let term = Term.(ret (const cmd_explain $ input_arg)) in
  Cmd.v (Cmd.info "explain" ~doc) term

let default_cmd =
  let doc = "w3rt scheduler compiler" in
  Cmd.group (Cmd.info "w3rt-scheduler" ~version:"0.1.0" ~doc) [ validate_cmd; explain_cmd; compile_cmd ]

let () = exit (Cmd.eval default_cmd)
