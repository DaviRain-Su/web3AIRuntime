open Types

let to_plan (wf : workflow) : plan =
  let steps =
    wf.actions
    |> List.map (fun a ->
           {
             id = a.id;
             tool = a.tool;
             params = a.params;
             depends_on = a.depends_on;
           })
  in
  { schema = "w3rt.plan.v1"; workflow = wf.name; steps }

let plan_to_json (p : plan) : Yojson.Safe.t =
  let step_to_json (s : plan_step) =
    `Assoc
      [
        ("id", `String s.id);
        ("tool", `String s.tool);
        ("params", s.params);
        ("dependsOn", `List (List.map (fun d -> `String d) s.depends_on)));
      ]
  in
  `Assoc
    [
      ("schema", `String p.schema);
      ("workflow", `String p.workflow);
      ("steps", `List (List.map step_to_json p.steps));
    ]
