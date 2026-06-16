"""
Rule AST Schema
===============
One serialized format, emitted by BOTH the graph canvas and the segment builder.

Top-level shape:
{
  "id": "...", "version": N, "insight": "Label",
  "modes": ["realtime","batch"],          # where this rule is allowed to run
  "match":  { ...root entity + traversals... },
  "produce": { ...what insight to write back... }
}

Two structural ideas:
  - match.where      -> SEGMENT-style condition tree (nested AND/OR), comes from query-builder
  - match.traversals -> GRAPH-style relationship walks, comes from React Flow canvas
The whole thing is recursive: every traversal target can itself have a where + traversals.
"""

import json
import jsonschema

# ---------------------------------------------------------------------------
# JSON Schema (what the UI must emit; what the backend validates on publish)
# ---------------------------------------------------------------------------

CONDITION_SCHEMA = {
    "oneOf": [
        {   # leaf: a single attribute comparison
            "type": "object",
            "required": ["attr", "op"],
            "properties": {
                "attr":   {"type": "string"},   # e.g. "SpendingProfile.dining_90d"
                "op":     {"enum": [">", ">=", "<", "<=", "=", "!=",
                                     "in", "not_in", "contains", "exists",
                                     "within_days"]},
                "value":  {},                   # scalar | list | null (for exists)
                "source": {"enum": ["neo4j", "mongo"]}  # which store owns this attr
            },
            "additionalProperties": False
        },
        {   # branch: a logical group of nested conditions
            "type": "object",
            "required": ["logic", "conditions"],
            "properties": {
                "logic": {"enum": ["AND", "OR", "NOT"]},
                "conditions": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/condition"},
                    "minItems": 1
                }
            },
            "additionalProperties": False
        }
    ]
}

TRAVERSAL_SCHEMA = {
    "type": "object",
    "required": ["rel", "to", "as"],
    "properties": {
        "rel":       {"type": "string"},        # Neo4j relationship type, e.g. HAS_RECURRING
        "direction": {"enum": ["out", "in", "both"], "default": "out"},
        "to":        {"type": "string"},        # target entity label
        "as":        {"type": "string"},        # binding name for later reference
        "quantifier":{"enum": ["any", "all", "none"], "default": "any"},
        "where":     {"$ref": "#/$defs/condition"},
        "traversals":{"type": "array", "items": {"$ref": "#/$defs/traversal"}}
    },
    "additionalProperties": False
}

RULE_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$defs": {"condition": CONDITION_SCHEMA, "traversal": TRAVERSAL_SCHEMA},
    "type": "object",
    "required": ["id", "version", "insight", "modes", "match"],
    "properties": {
        "id":      {"type": "string"},
        "version": {"type": "integer", "minimum": 1},
        "insight": {"type": "string"},          # the derived node/label produced
        "modes":   {"type": "array", "items": {"enum": ["realtime", "batch"]},
                    "minItems": 1},
        "priority":{"type": "integer", "default": 100},
        "match": {
            "type": "object",
            "required": ["entity", "as"],
            "properties": {
                "entity":     {"type": "string"},   # root, almost always "Customer"
                "as":         {"type": "string"},
                "where":      {"$ref": "#/$defs/condition"},
                "traversals": {"type": "array", "items": {"$ref": "#/$defs/traversal"}}
            },
            "additionalProperties": False
        },
        "produce": {
            "type": "object",
            "properties": {
                "node":  {"type": "string"},        # insight node label to upsert
                "props": {"type": "object"},        # static props to stamp on it
                "ttl_seconds": {"type": "integer"}  # optional expiry
            }
        }
    },
    "additionalProperties": False
}


def validate(rule: dict) -> None:
    jsonschema.validate(rule, RULE_SCHEMA)


# ---------------------------------------------------------------------------
# Example rule — uses BOTH paradigms in one AST
# ---------------------------------------------------------------------------
# Business intent (authored by drag/drop, no code):
#   "Customers whose 90-day dining spend > $1000 (graph-derived SpendingProfile)
#    AND credit score >= 700 (Mongo credit report)
#    AND who have a recurring payment to a Merchant in the 'Streaming' category
#    => tag them 'StreamingDiner', eligible for a dining+entertainment offer."
#
#   - where ............ came from the SEGMENT builder (nested AND, mixed sources)
#   - traversals ....... came from the GRAPH canvas (Customer -HAS_RECURRING-> Merchant)

EXAMPLE_RULE = {
    "id": "rule_streaming_diner",
    "version": 3,
    "insight": "StreamingDiner",
    "modes": ["realtime", "batch"],
    "priority": 50,
    "match": {
        "entity": "Customer",
        "as": "c",
        "where": {
            "logic": "AND",
            "conditions": [
                {"attr": "SpendingProfile.dining_90d", "op": ">",  "value": 1000, "source": "neo4j"},
                {"attr": "CreditReport.score",         "op": ">=", "value": 700,  "source": "mongo"}
            ]
        },
        "traversals": [
            {
                "rel": "HAS_RECURRING", "direction": "out",
                "to": "Merchant", "as": "m", "quantifier": "any",
                "where": {
                    "logic": "AND",
                    "conditions": [
                        {"attr": "category", "op": "=", "value": "Streaming", "source": "neo4j"}
                    ]
                }
            }
        ]
    },
    "produce": {
        "node": "StreamingDiner",
        "props": {"offer_track": "dining_entertainment"},
        "ttl_seconds": 86400
    }
}


if __name__ == "__main__":
    validate(EXAMPLE_RULE)
    print("AST validates against schema OK")
    print(json.dumps(EXAMPLE_RULE, indent=2))
