"""
BATCH COMPILER
==============
Population-scale. Compiles the AST into:
  (1) a Cypher query that matches the cohort using graph structure + neo4j attrs,
  (2) a Mongo aggregation per mongo-sourced condition,
then JOINs the two result sets on customer_id and writes insight nodes back.

Design choice: graph structure (traversals) and neo4j attribute filters are
expressed natively in Cypher (that's what the graph DB is good at). Mongo-owned
attributes (e.g. credit report) become a separate filter applied via join key.
"""

OPS = {">": ">", ">=": ">=", "<": "<", "<=": "<=", "=": "=", "!=": "<>"}


# ---- split conditions by source ------------------------------------------
def _split_conditions(cond, neo4j_acc, mongo_acc):
    """Walk a condition tree, bucket leaves by source. (Top-level AND assumed
    for cross-store; nested OR across stores would need a post-join filter —
    flagged below.)"""
    if cond is None:
        return
    if "logic" in cond:
        for c in cond["conditions"]:
            _split_conditions(c, neo4j_acc, mongo_acc)
    else:
        (neo4j_acc if cond.get("source") == "neo4j" else mongo_acc).append(cond)


# ---- Cypher generation ----------------------------------------------------
def _cypher_predicate(binding, cond):
    attr = cond["attr"].split(".")[-1]      # SpendingProfile.dining_90d -> dining_90d
    op = cond["op"]
    val = cond["value"]
    if op in OPS:
        v = f"'{val}'" if isinstance(val, str) else val
        return f"{binding}.{attr} {OPS[op]} {v}"
    if op == "in":
        return f"{binding}.{attr} IN {val}"
    if op == "exists":
        return f"{binding}.{attr} IS NOT NULL"
    if op == "contains":
        return f"{binding}.{attr} CONTAINS '{val}'"
    raise ValueError(f"unsupported op {op}")


def _attr_owner(attr):
    """SpendingProfile.dining_90d -> the entity that holds it."""
    return attr.split(".")[0] if "." in attr else None


def compile_batch(rule):
    m = rule["match"]
    root, root_as = m["entity"], m["as"]
    match_clauses = [f"({root_as}:{root})"]
    where_preds = []

    neo4j_conds, mongo_conds = [], []
    _split_conditions(m.get("where"), neo4j_conds, mongo_conds)

    # neo4j attribute conditions on the root: some live on attached derived
    # nodes (SpendingProfile) reached by an implicit edge.
    for c in neo4j_conds:
        owner = _attr_owner(c["attr"])
        if owner and owner != root:
            b = owner.lower()
            match_clauses.append(f"({root_as})-[:HAS_{owner.upper()}]->({b}:{owner})")
            where_preds.append(_cypher_predicate(b, c))
        else:
            where_preds.append(_cypher_predicate(root_as, c))

    # explicit graph traversals (from the canvas)
    for t in m.get("traversals", []):
        arrow = {"out": ("-", "->"), "in": ("<-", "-"), "both": ("-", "-")}[t.get("direction", "out")]
        match_clauses.append(
            f"({root_as}){arrow[0]}[:{t['rel']}]{arrow[1]}({t['as']}:{t['to']})"
        )
        if t.get("where"):
            tneo, tmongo = [], []
            _split_conditions(t["where"], tneo, tmongo)
            for c in tneo:
                where_preds.append(_cypher_predicate(t["as"], c))

    cypher = "MATCH " + ",\n      ".join(match_clauses)
    if where_preds:
        cypher += "\nWHERE " + "\n  AND ".join(where_preds)
    cypher += f"\nRETURN DISTINCT {root_as}.customer_id AS customer_id"

    # Mongo side: one aggregation that returns the qualifying customer_ids
    mongo_pipeline = None
    if mongo_conds:
        match_stage = {}
        for c in mongo_conds:
            field = c["attr"].split(".")[-1]
            op = c["op"]
            mop = {">": "$gt", ">=": "$gte", "<": "$lt", "<=": "$lte",
                   "=": "$eq", "!=": "$ne", "in": "$in"}[op]
            match_stage[field] = {mop: c["value"]}
        mongo_pipeline = [
            {"$match": match_stage},
            {"$project": {"_id": 0, "customer_id": 1}}
        ]

    return {
        "cypher": cypher,
        "mongo_collection": _attr_owner(mongo_conds[0]["attr"]) if mongo_conds else None,
        "mongo_pipeline": mongo_pipeline,
        "join_key": "customer_id",
        "produce": rule.get("produce", {"node": rule["insight"]})
    }


def writeback_cypher(rule, customer_ids):
    """The upsert that materializes the insight back into Neo4j (idempotent)."""
    p = rule.get("produce", {"node": rule["insight"]})
    props = p.get("props", {})
    prop_str = ", ".join(f"i.{k} = {repr(v)}" for k, v in props.items())
    set_clause = f"SET i.version = {rule['version']}, i.generated_at = timestamp()"
    if prop_str:
        set_clause += ", " + prop_str
    return (
        f"UNWIND {customer_ids} AS cid\n"
        f"MATCH (c:Customer {{customer_id: cid}})\n"
        f"MERGE (c)-[:HAS_INSIGHT]->(i:{p['node']} {{rule_id: '{rule['id']}'}})\n"
        f"{set_clause}"
    )


if __name__ == "__main__":
    from ast_schema import EXAMPLE_RULE
    plan = compile_batch(EXAMPLE_RULE)
    print("=== CYPHER (graph structure + neo4j attrs) ===")
    print(plan["cypher"])
    print("\n=== MONGO (collection:", plan["mongo_collection"], ") ===")
    import json
    print(json.dumps(plan["mongo_pipeline"], indent=2))
    print("\n=== JOIN on:", plan["join_key"], "===")
    print("\n=== WRITE-BACK (after joining the two id sets) ===")
    print(writeback_cypher(EXAMPLE_RULE, ["C1", "C2"]))
