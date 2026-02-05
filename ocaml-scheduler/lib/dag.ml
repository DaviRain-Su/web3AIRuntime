open Types

module SSet = Set.Make (String)

let uniq_ids (actions : action list) : (unit, string) result =
  let rec go seen = function
    | [] -> Ok ()
    | (a : action) :: rest ->
        if SSet.mem a.id seen then Error ("duplicate action id: " ^ a.id)
        else go (SSet.add a.id seen) rest
  in
  go SSet.empty actions

let ensure_deps_exist (actions : action list) : (unit, string) result =
  let ids = List.fold_left (fun acc (a : action) -> SSet.add a.id acc) SSet.empty actions in
  let missing =
    actions
    |> List.concat_map (fun (a : action) ->
           a.depends_on
           |> List.filter (fun d -> not (SSet.mem d ids))
           |> List.map (fun d -> (a.id, d)))
  in
  match missing with
  | [] -> Ok ()
  | (aid, dep) :: _ -> Error ("missing dependency: " ^ aid ^ " dependsOn " ^ dep)

let topo_sort (actions : action list) : (action list, string) result =
  (* Kahn's algorithm *)
  let by_id = Hashtbl.create 64 in
  List.iter (fun (a : action) -> Hashtbl.replace by_id a.id a) actions;

  let indeg = Hashtbl.create 64 in
  List.iter (fun (a : action) -> Hashtbl.replace indeg a.id 0) actions;
  List.iter
    (fun (a : action) ->
      List.iter
        (fun (_d : string) ->
          let v = Hashtbl.find indeg a.id in
          Hashtbl.replace indeg a.id (v + 1))
        a.depends_on)
    actions;

  let q = Queue.create () in
  List.iter (fun (a : action) -> if Hashtbl.find indeg a.id = 0 then Queue.add a.id q) actions;

  let out = ref [] in
  while not (Queue.is_empty q) do
    let id = Queue.take q in
    let a = Hashtbl.find by_id id in
    out := a :: !out;
    (* edges: id -> others that depend on id *)
    List.iter
      (fun (b : action) ->
        if List.exists (( = ) id) b.depends_on then (
          let v = Hashtbl.find indeg b.id in
          let v' = v - 1 in
          Hashtbl.replace indeg b.id v';
          if v' = 0 then Queue.add b.id q))
      actions
  done;

  let sorted = List.rev !out in
  if List.length sorted <> List.length actions then Error "cycle detected in dependsOn graph"
  else Ok sorted

let is_swap_exec (a : action) = String.equal a.tool "w3rt_swap_exec"
let is_swap_quote (a : action) = String.equal a.tool "w3rt_swap_quote"

let json_member (k : string) (j : Yojson.Safe.t) : Yojson.Safe.t =
  match j with
  | `Assoc kv -> (match List.assoc_opt k kv with Some v -> v | None -> `Null)
  | _ -> `Null

let json_string_opt (j : Yojson.Safe.t) : string option =
  match j with
  | `String s -> Some s
  | `Null -> None
  | _ -> None

let validate_swap_exec (wf : workflow) : (unit, string) result =
  let by_id = Hashtbl.create 64 in
  List.iter (fun (a : action) -> Hashtbl.replace by_id a.id a) wf.actions;

  let quote_ids =
    wf.actions
    |> List.filter is_swap_quote
    |> List.map (fun (a : action) -> a.id)
  in

  let has_quote_dep (a : action) : bool =
    List.exists (fun d -> List.mem d quote_ids) a.depends_on
  in

  let rec check = function
    | [] -> Ok ()
    | (a : action) :: rest ->
        if not (is_swap_exec a) then check rest
        else
          (* Must depend on at least one swap_quote action *)
          if not (has_quote_dep a) then
            Error ("swap_exec requires dependsOn a w3rt_swap_quote step: " ^ a.id)
          else
            (* Must include confirm phrase in params *)
            let confirm = json_member "confirm" a.params |> json_string_opt in
            (match confirm with
            | Some s when String.equal s "I_CONFIRM" -> check rest
            | Some _ -> Error ("swap_exec confirm must be I_CONFIRM: " ^ a.id)
            | None -> Error ("swap_exec missing params.confirm: " ^ a.id))
  in
  check wf.actions

let validate (wf : workflow) : (unit, string) result =
  match uniq_ids wf.actions with
  | Error e -> Error e
  | Ok () -> (
      match ensure_deps_exist wf.actions with
      | Error e -> Error e
      | Ok () -> (
          match topo_sort wf.actions with
          | Error e -> Error e
          | Ok _ -> validate_swap_exec wf))
