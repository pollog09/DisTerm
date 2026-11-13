# DisTerm

A node-based terminal manager: real terminals and agent sessions on one canvas, with a board and a graph
as other views of the same project.

## Graph view

**Agent graph**:
The graph view's picture of a project's agent sessions, what passes between them and how work moved
through the ship process.
_Avoid_: agentic workflow view, agent view

**System map**:
A repo's parts (callers, services, stores, workers, outside services) and the flows between them, as
written by an agent in a file in the repo and drawn by the graph view.
_Avoid_: code map, code graph, flow atlas

**Code map**:
The repo's own architecture docs: `docs/architecture/CODEMAP.md` (task to files) and the import graph
`GRAPH.md` generated from `src/`. Not a view in the app.
_Avoid_: system map
