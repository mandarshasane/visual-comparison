"""
REAL-TIME EVALUATOR
===================
Per mobile session. NO per-rule database round trips.

On session start the engine loads ONE customer context object:
    - graph neighborhood from Neo4j  (Customer + attached derived nodes + 1-hop edges)
    - the Mongo doc(s) for that customer (credit report, etc.)
into a single dict. Then every active realtime rule is evaluated in memory
against that dict. New rules take effect next session because the engine
reloads the active ruleset on a version bump — no redeploy.

Same AST as the batch compiler. Difference: we INTERPRET it against one
customer instead of COMPILING it to population queries.
"""

import operator

CMP = {">": operator.gt, ">=": operator.ge, "<": operator.lt,
       "<=": operator.le, "=": operator.eq, "!=": operator.ne}


def _get(ctx, dotted):
    """Resolve 'SpendingProfile.dining_90d' or 'CreditReport.score' from the
    loaded context. Both neo4j-derived nodes and mongo docs are flattened into
    ctx by the loader, so source is irrelevant at eval time."""
    cur = ctx
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def _eval_condition(ctx, cond):
    if cond is None:
        return True
    if "logic" in cond:
        results = [_eval_condition(ctx, c) for c in cond["conditions"]]
        if cond["logic"] == "AND":
            return all(results)
        if cond["logic"] == "OR":
            return any(results)
        if cond["logic"] == "NOT":
            return not all(results)
    # leaf
    actual = _get(ctx, cond["attr"])
    op, val = cond["op"], cond.get("value")
    if op == "exists":
        return actual is not None
    if actual is None:
        return False
    if op in CMP:
        return CMP[op](actual, val)
    if op == "in":
        return actual in val
    if op == "not_in":
        return actual not in val
    if op == "contains":
        return val in actual
    return False


def _eval_traversal(ctx, t):
    """Traversals were pre-loaded as lists on the context, e.g.
    ctx['_edges']['HAS_RECURRING'] = [ {Merchant doc}, ... ].
    quantifier any/all/none decides how the target where must hold."""
    targets = ctx.get("_edges", {}).get(t["rel"], [])
    q = t.get("quantifier", "any")
    matches = [_eval_condition(tgt, t.get("where")) for tgt in targets]
    if q == "any":
        ok = any(matches)
    elif q == "all":
        ok = bool(matches) and all(matches)
    elif q == "none":
        ok = not any(matches)
    else:
        ok = any(matches)
    # nested traversals on each matching target
    if ok and t.get("traversals"):
        for tgt in targets:
            for nt in t["traversals"]:
                if not _eval_traversal(tgt, nt):
                    return False
    return ok


def evaluate(rule, ctx):
    """Return the insight dict if the customer matches, else None."""
    m = rule["match"]
    if not _eval_condition(ctx, m.get("where")):
        return None
    for t in m.get("traversals", []):
        if not _eval_traversal(ctx, t):
            return None
    p = rule.get("produce", {"node": rule["insight"]})
    return {
        "insight": p.get("node", rule["insight"]),
        "rule_id": rule["id"],
        "version": rule["version"],
        **p.get("props", {})
    }


class RealtimeEngine:
    """Holds the active ruleset in memory; reloads on version bump."""
    def __init__(self):
        self.rules = []
        self.ruleset_version = 0

    def publish(self, rules, version):
        # only keep rules tagged for realtime
        self.rules = [r for r in rules if "realtime" in r["modes"]]
        self.ruleset_version = version

    def evaluate_session(self, customer_ctx):
        hits = []
        for r in sorted(self.rules, key=lambda x: x.get("priority", 100)):
            res = evaluate(r, customer_ctx)
            if res:
                hits.append(res)
        return hits


if __name__ == "__main__":
    from ast_schema import EXAMPLE_RULE

    # A customer context as the session loader would assemble it.
    # (neo4j derived node + mongo doc flattened; 1-hop edges preloaded)
    ctx_match = {
        "customer_id": "C1",
        "SpendingProfile": {"dining_90d": 1450},     # neo4j-derived
        "CreditReport": {"score": 742},               # mongo doc
        "_edges": {
            "HAS_RECURRING": [
                {"name": "Netflix", "category": "Streaming"},
                {"name": "PowerCo", "category": "Utilities"},
            ]
        }
    }
    ctx_miss = {
        "customer_id": "C2",
        "SpendingProfile": {"dining_90d": 300},       # too low
        "CreditReport": {"score": 800},
        "_edges": {"HAS_RECURRING": [{"name": "PowerCo", "category": "Utilities"}]}
    }

    eng = RealtimeEngine()
    eng.publish([EXAMPLE_RULE], version=3)

    print("Active realtime rules:", len(eng.rules), "| ruleset v", eng.ruleset_version)
    print("\nCustomer C1 (dining 1450, score 742, has Netflix):")
    print("  ->", eng.evaluate_session(ctx_match))
    print("\nCustomer C2 (dining 300):")
    print("  ->", eng.evaluate_session(ctx_miss) or "  no insight")
