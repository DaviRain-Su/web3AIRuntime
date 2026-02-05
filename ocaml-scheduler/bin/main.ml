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
      Printf.printf "Workflow: %s\nActions: %d\n\n" wf.name (List.length wf.actions);
      wf.actions
      |> List.iter (fun (a : W3rt_scheduler.Types.action) ->
             Printf.printf "- %s: %s" a.id a.tool;
             (match a.depends_on with
             | [] -> ()
             | ds -> Printf.printf "  (dependsOn: %s)" (String.concat "," ds));
             print_newline ());
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
