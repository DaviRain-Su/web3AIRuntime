open Types

let as_string = function
  | `String s -> s
  | j -> failwith ("expected string, got: " ^ Yojson.Safe.to_string j)

let as_list = function
  | `List xs -> xs
  | j -> failwith ("expected list, got: " ^ Yojson.Safe.to_string j)

let member name = function
  | `Assoc kv -> (match List.assoc_opt name kv with Some v -> v | None -> `Null)
  | _ -> `Null

let string_opt = function
  | `Null -> None
  | `String s -> Some s
  | j -> failwith ("expected string|null, got: " ^ Yojson.Safe.to_string j)

let list_strings = function
  | `Null -> []
  | `List xs -> List.map as_string xs
  | j -> failwith ("expected list|null, got: " ^ Yojson.Safe.to_string j)

let parse_action (j : Yojson.Safe.t) : action =
  let id = member "id" j |> as_string in
  let tool = member "tool" j |> as_string in
  let params = member "params" j in
  let depends_on = member "dependsOn" j |> list_strings in
  { id; tool; params; depends_on }

let parse_workflow (j : Yojson.Safe.t) : workflow =
  let name =
    match member "name" j |> string_opt with
    | Some s -> s
    | None -> "workflow"
  in
  let actions =
    match member "actions" j with
    | `Null -> []
    | x -> as_list x |> List.map parse_action
  in
  { name; actions }

let from_file (path : string) : workflow =
  let j = Yojson.Safe.from_file path in
  parse_workflow j
