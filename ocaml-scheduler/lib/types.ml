type action = {
  id : string;
  tool : string;
  params : Yojson.Safe.t;
  depends_on : string list;
}

type workflow = {
  name : string;
  actions : action list;
}

type plan_step = {
  id : string;
  tool : string;
  params : Yojson.Safe.t;
  depends_on : string list;
}

type plan = {
  schema : string;
  workflow : string;
  steps : plan_step list;
}
