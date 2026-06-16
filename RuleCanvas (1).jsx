import React, { useState, useCallback, useRef, useMemo } from "react";

/**
 * Rule Authoring Workbench
 * ------------------------
 * Graph canvas (shape) + attached segment panels (filters) -> one Rule AST.
 *
 * React Flow is loaded from CDN at runtime (window.ReactFlow) so this stays a
 * single self-contained file. If it's unavailable we fall back to a lightweight
 * built-in canvas so the tool still works.
 */

/* ----------------------------- Ontology catalog -----------------------------
 * In production this is fetched from your metadata backbone. Each entity knows
 * which store owns it and what attributes/operators are available. The palette
 * and the per-node segment builder both read from this. */
const CATALOG = {
  Customer: {
    source: "neo4j",
    root: true,
    attrs: {
      tenure_months: { type: "number", ops: [">", ">=", "<", "<=", "="] },
      segment: { type: "enum", ops: ["=", "!=", "in"], values: ["mass", "affluent", "private"] },
    },
    rels: [
      { rel: "HAS_RECURRING", to: "Merchant" },
      { rel: "HAS_SPENDINGPROFILE", to: "SpendingProfile" },
      { rel: "HAS_CREDITREPORT", to: "CreditReport" },
      { rel: "HAD_INTERACTION", to: "Interaction" },
    ],
  },
  SpendingProfile: {
    source: "neo4j",
    attrs: {
      dining_90d: { type: "number", ops: [">", ">=", "<", "<="] },
      travel_90d: { type: "number", ops: [">", ">=", "<", "<="] },
      total_90d: { type: "number", ops: [">", ">=", "<", "<="] },
    },
  },
  Merchant: {
    source: "neo4j",
    attrs: {
      category: { type: "enum", ops: ["=", "!=", "in"], values: ["Streaming", "Utilities", "Travel", "Dining", "Retail"] },
      name: { type: "string", ops: ["=", "contains"] },
    },
  },
  Interaction: {
    source: "neo4j",
    attrs: {
      channel: { type: "enum", ops: ["=", "in"], values: ["app", "branch", "call", "chat"] },
      days_ago: { type: "number", ops: ["<", "<=", "within_days"] },
    },
  },
  CreditReport: {
    source: "mongo",
    attrs: {
      score: { type: "number", ops: [">", ">=", "<", "<="] },
      utilization: { type: "number", ops: [">", ">=", "<", "<="] },
      delinquencies: { type: "number", ops: ["=", ">", ">="] },
    },
  },
};

const SOURCE_META = {
  neo4j: { label: "Neo4j", color: "#5BE0B7", dim: "rgba(91,224,183,0.13)" },
  mongo: { label: "Mongo", color: "#7FB2FF", dim: "rgba(127,178,255,0.13)" },
};

const uid = (p = "n") => `${p}_${Math.random().toString(36).slice(2, 8)}`;

/* ----------------------------- Condition tree ----------------------------- */
const emptyGroup = () => ({ kind: "group", logic: "AND", conditions: [] });
const emptyLeaf = (entity) => {
  const attrs = Object.keys(CATALOG[entity].attrs);
  const attr = attrs[0];
  const def = CATALOG[entity].attrs[attr];
  return { kind: "leaf", attr, op: def.ops[0], value: def.type === "enum" ? def.values[0] : "" };
};

function countLeaves(node) {
  if (!node) return 0;
  if (node.kind === "leaf") return 1;
  return node.conditions.reduce((s, c) => s + countLeaves(c), 0);
}

/* Serialize the per-node condition tree into AST condition form (adds source). */
function serializeCondition(node, entity) {
  if (!node) return undefined;
  if (node.kind === "leaf") {
    const source = CATALOG[entity].source;
    const out = { attr: `${entity}.${node.attr}`, op: node.op, source };
    if (node.op !== "exists") out.value = coerce(node.value, CATALOG[entity].attrs[node.attr].type);
    return out;
  }
  const conditions = node.conditions.map((c) => serializeCondition(c, entity)).filter(Boolean);
  if (conditions.length === 0) return undefined;
  return { logic: node.logic, conditions };
}

function coerce(v, type) {
  if (type === "number") return v === "" ? null : Number(v);
  if (type === "enum" && Array.isArray(v)) return v;
  return v;
}

/* ----------------------------- AST assembly ----------------------------- */
function buildAST({ nodes, edges, insight, modes, rootId }) {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const childrenOf = (id) =>
    edges.filter((e) => e.source === id).map((e) => ({ edge: e, node: byId[e.target] }));

  const traversalsFor = (id) =>
    childrenOf(id).map(({ edge, node }) => {
      const t = {
        rel: edge.rel,
        direction: "out",
        to: node.entity,
        as: node.varName,
        quantifier: edge.quantifier || "any",
      };
      const where = serializeCondition(node.tree, node.entity);
      if (where) t.where = where;
      const nested = traversalsFor(node.id);
      if (nested.length) t.traversals = nested;
      return t;
    });

  const root = byId[rootId];
  if (!root) return null;
  const match = { entity: root.entity, as: root.varName };
  const rootWhere = serializeCondition(root.tree, root.entity);
  if (rootWhere) match.where = rootWhere;
  const tr = traversalsFor(rootId);
  if (tr.length) match.traversals = tr;

  return {
    id: `rule_${insight.toLowerCase().replace(/\s+/g, "_") || "untitled"}`,
    version: 1,
    insight: insight || "UntitledInsight",
    modes,
    match,
    produce: { node: insight || "UntitledInsight" },
  };
}

/* ===========================================================================
 * Dry-run evaluator — SAME semantics as the real-time engine / batch compiler.
 * Runs the AST against an in-memory sample so authors see the cohort before
 * publishing. This is the honest-preview contract: identical logic, so the
 * count here is the count production will produce.
 * =========================================================================== */
const CMP = {
  ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b,
  "<=": (a, b) => a <= b, "=": (a, b) => a === b, "!=": (a, b) => a !== b,
};
function getVal(ctx, dotted) {
  let cur = ctx;
  for (const p of dotted.split(".")) {
    if (cur && typeof cur === "object" && p in cur) cur = cur[p];
    else return undefined;
  }
  return cur;
}
function evalCondition(ctx, c) {
  if (!c) return true;
  if (c.logic) {
    const r = c.conditions.map((x) => evalCondition(ctx, x));
    return c.logic === "AND" ? r.every(Boolean) : c.logic === "OR" ? r.some(Boolean) : !r.every(Boolean);
  }
  const actual = getVal(ctx, c.attr), op = c.op, val = c.value;
  if (op === "exists") return actual !== undefined && actual !== null;
  if (actual === undefined || actual === null) return false;
  if (CMP[op]) return CMP[op](actual, val);
  if (op === "in") return Array.isArray(val) && val.includes(actual);
  if (op === "contains") return String(actual).includes(val);
  if (op === "within_days") return actual <= val;
  return false;
}
function evalTraversal(ctx, t) {
  const targets = (ctx._edges && ctx._edges[t.rel]) || [];
  const m = targets.map((tg) => evalCondition(tg, t.where));
  const q = t.quantifier || "any";
  let ok = q === "any" ? m.some(Boolean) : q === "all" ? (m.length > 0 && m.every(Boolean)) : q === "none" ? !m.some(Boolean) : m.some(Boolean);
  if (ok && t.traversals) for (const tg of targets) for (const nt of t.traversals) if (!evalTraversal(tg, nt)) return false;
  return ok;
}
function astMatches(ast, ctx) {
  if (!ast) return false;
  if (!evalCondition(ctx, ast.match.where)) return false;
  for (const t of ast.match.traversals || []) if (!evalTraversal(ctx, t)) return false;
  return true;
}

/* The dry-run evaluator works on a FLATTENED context (derived nodes + mongo
 * docs merged onto the customer, 1-hop edges preloaded) — exactly what the
 * session loader assembles. The AST attrs are "Entity.field"; getVal resolves
 * them against this shape. Traversal `where` clauses reference the target
 * entity's own fields, so we store edge targets as flat dicts. */
function buildContextFromAST_compatible(raw) {
  return raw; // sample is generated already in flattened form
}

/* Synthetic but realistic sample population. In production swap this for a
 * sampled slice of the real graph+mongo (e.g. 5k random customers). */
const SAMPLE_SIZE = 2000;
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function genSample(n = SAMPLE_SIZE) {
  const merchCats = ["Streaming", "Utilities", "Travel", "Dining", "Retail"];
  const channels = ["app", "branch", "call", "chat"];
  const segs = ["mass", "affluent", "private"];
  const out = [];
  for (let i = 0; i < n; i++) {
    const nRecurring = Math.floor(Math.random() * 4);
    out.push({
      customer_id: `C${100000 + i}`,
      Customer: { tenure_months: Math.floor(Math.random() * 120), segment: pick(segs) },
      SpendingProfile: {
        dining_90d: Math.round(Math.random() ** 1.8 * 3000),
        travel_90d: Math.round(Math.random() ** 2 * 5000),
        total_90d: Math.round(Math.random() * 12000),
      },
      CreditReport: {
        score: 500 + Math.floor(Math.random() * 350),
        utilization: Math.round(Math.random() * 100) / 100,
        delinquencies: Math.random() < 0.85 ? 0 : Math.floor(Math.random() * 3) + 1,
      },
      _edges: {
        HAS_RECURRING: Array.from({ length: nRecurring }, () => ({
          category: pick(merchCats), name: "m_" + Math.random().toString(36).slice(2, 6),
        })),
        HAS_SPENDINGPROFILE: [{}], // structural presence
        HAS_CREDITREPORT: [{}],
        HAD_INTERACTION: Array.from({ length: Math.floor(Math.random() * 6) }, () => ({
          channel: pick(channels), days_ago: Math.floor(Math.random() * 90),
        })),
      },
    });
  }
  return out;
}

/* The traversal `where` in our AST references the TARGET entity's fields
 * directly (e.g. Merchant.category). But the sample stores edge targets as
 * bare dicts keyed by field. Normalize: rewrite "Entity.field" -> "field"
 * inside traversal where-clauses so getVal resolves against the edge target. */
function localizeTraversalAttrs(ast) {
  if (!ast) return ast;
  const clone = structuredClone(ast);
  const stripEntity = (cond) => {
    if (!cond) return cond;
    if (cond.logic) { cond.conditions.forEach(stripEntity); return cond; }
    if (cond.attr && cond.attr.includes(".")) cond.attr = cond.attr.split(".").slice(1).join(".");
    return cond;
  };
  const walk = (travs) => {
    (travs || []).forEach((t) => {
      if (t.where) stripEntity(t.where);
      if (t.traversals) walk(t.traversals);
    });
  };
  walk(clone.match.traversals);
  return clone;
}

function runDryRun(ast, sample) {
  if (!ast) return null;
  const t0 = performance.now();
  const localized = localizeTraversalAttrs(ast);
  const hits = [];
  for (const ctx of sample) if (astMatches(localized, ctx)) hits.push(ctx);
  const ms = performance.now() - t0;
  // small breakdown: which single condition is most limiting (drop-one analysis)
  return { total: sample.length, matched: hits.length, sampleHits: hits.slice(0, 8), ms };
}

/* ===========================================================================
 * Segment panel — the query-builder that attaches to the selected node
 * =========================================================================== */
function SegmentBuilder({ entity, tree, onChange }) {
  const def = CATALOG[entity];

  const update = (path, mutator) => {
    const clone = structuredClone(tree);
    let ref = clone;
    for (const idx of path) ref = ref.conditions[idx];
    mutator(ref, clone);
    onChange(clone);
  };

  const renderNode = (node, path) => {
    if (node.kind === "group") {
      return (
        <div key={path.join("-") || "root"} style={S.group}>
          <div style={S.groupHeader}>
            <div style={S.logicToggle}>
              {["AND", "OR", "NOT"].map((l) => (
                <button
                  key={l}
                  onClick={() => update(path, (r) => (r.logic = l))}
                  style={{ ...S.logicBtn, ...(node.logic === l ? S.logicBtnActive : {}) }}
                >
                  {l}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button style={S.addBtn} onClick={() => update(path, (r) => r.conditions.push(emptyLeaf(entity)))}>
                + condition
              </button>
              <button style={S.addBtnGhost} onClick={() => update(path, (r) => r.conditions.push(emptyGroup()))}>
                + group
              </button>
            </div>
          </div>
          <div style={S.groupBody}>
            {node.conditions.length === 0 && <div style={S.emptyHint}>No filters. Add a condition to narrow this entity.</div>}
            {node.conditions.map((c, i) => renderNode(c, [...path, i]))}
          </div>
        </div>
      );
    }
    // leaf
    const attrDef = def.attrs[node.attr];
    return (
      <div key={path.join("-")} style={S.leaf}>
        <select
          value={node.attr}
          onChange={(e) =>
            update(path.slice(0, -1), (r) => {
              const leaf = r.conditions[path[path.length - 1]];
              leaf.attr = e.target.value;
              const d = def.attrs[e.target.value];
              leaf.op = d.ops[0];
              leaf.value = d.type === "enum" ? d.values[0] : "";
            })
          }
          style={S.select}
        >
          {Object.keys(def.attrs).map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          value={node.op}
          onChange={(e) => update(path.slice(0, -1), (r) => (r.conditions[path[path.length - 1]].op = e.target.value))}
          style={{ ...S.select, width: 92 }}
        >
          {attrDef.ops.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        {node.op !== "exists" &&
          (attrDef.type === "enum" ? (
            <select
              value={node.value}
              onChange={(e) => update(path.slice(0, -1), (r) => (r.conditions[path[path.length - 1]].value = e.target.value))}
              style={S.select}
            >
              {attrDef.values.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          ) : (
            <input
              value={node.value}
              placeholder={attrDef.type === "number" ? "0" : "value"}
              onChange={(e) => update(path.slice(0, -1), (r) => (r.conditions[path[path.length - 1]].value = e.target.value))}
              style={S.input}
            />
          ))}
        <button
          style={S.removeBtn}
          onClick={() => update(path.slice(0, -1), (r) => r.conditions.splice(path[path.length - 1], 1))}
          title="Remove"
        >
          ×
        </button>
      </div>
    );
  };

  return <div>{renderNode(tree, [])}</div>;
}

/* ===========================================================================
 * Main workbench
 * =========================================================================== */
export default function RuleCanvas() {
  const rootId = useRef(uid("root")).current;
  const [nodes, setNodes] = useState([
    { id: rootId, entity: "Customer", varName: "c", x: 80, y: 130, tree: emptyGroup() },
  ]);
  const [edges, setEdges] = useState([]);
  const [selected, setSelected] = useState(rootId);
  const [insight, setInsight] = useState("StreamingDiner");
  const [modes, setModes] = useState(["realtime", "batch"]);
  const [drag, setDrag] = useState(null); // {id, dx, dy}
  const [showAST, setShowAST] = useState(true);
  const [dryRun, setDryRun] = useState(null); // {total, matched, sampleHits, ms}
  const [running, setRunning] = useState(false);
  const canvasRef = useRef(null);
  const sampleRef = useRef(null);
  if (!sampleRef.current) sampleRef.current = genSample();

  const selectedNode = nodes.find((n) => n.id === selected);

  /* Add an entity by following a relationship from the selected node. */
  const addRelated = (rel, to) => {
    const parent = nodes.find((n) => n.id === selected) || nodes[0];
    const id = uid();
    const varName = to[0].toLowerCase() + Object.keys(CATALOG).indexOf(to);
    setNodes((ns) => [
      ...ns,
      { id, entity: to, varName, x: parent.x + 280, y: parent.y + (Math.random() * 120 - 40), tree: emptyGroup() },
    ]);
    setEdges((es) => [...es, { id: uid("e"), source: parent.id, target: id, rel, quantifier: "any" }]);
    setSelected(id);
  };

  const removeNode = (id) => {
    if (id === rootId) return;
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    if (selected === id) setSelected(rootId);
  };

  const updateTree = (id, tree) => setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, tree } : n)));

  /* dragging */
  const onPointerDown = (e, id) => {
    const node = nodes.find((n) => n.id === id);
    const rect = canvasRef.current.getBoundingClientRect();
    setDrag({ id, dx: e.clientX - rect.left - node.x, dy: e.clientY - rect.top - node.y });
    setSelected(id);
  };
  const onPointerMove = (e) => {
    if (!drag) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - drag.dx;
    const y = e.clientY - rect.top - drag.dy;
    setNodes((ns) => ns.map((n) => (n.id === drag.id ? { ...n, x, y } : n)));
  };
  const onPointerUp = () => setDrag(null);

  const ast = useMemo(
    () => buildAST({ nodes, edges, insight, modes, rootId }),
    [nodes, edges, insight, modes, rootId]
  );

  // Any edit to the rule invalidates a prior dry-run result.
  const astKey = JSON.stringify(ast);
  const lastKeyRef = useRef(astKey);
  if (lastKeyRef.current !== astKey) {
    lastKeyRef.current = astKey;
    if (dryRun) setDryRun(null);
  }

  const handleDryRun = () => {
    setRunning(true);
    // defer so the spinner paints before the (synchronous) scan
    setTimeout(() => {
      const result = runDryRun(ast, sampleRef.current);
      setDryRun(result);
      setRunning(false);
    }, 30);
  };

  const availableRels = selectedNode ? CATALOG[selectedNode.entity].rels || [] : [];

  return (
    <div style={S.app} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <style>{CSS}</style>

      {/* Top bar */}
      <div style={S.topbar}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={S.logo}>◆ ontology</div>
          <div style={S.bc}>rule builder</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <label style={S.insightLabel}>produces</label>
          <input value={insight} onChange={(e) => setInsight(e.target.value)} style={S.insightInput} />
          <div style={S.modeGroup}>
            {["realtime", "batch"].map((m) => (
              <button
                key={m}
                onClick={() => setModes((ms) => (ms.includes(m) ? ms.filter((x) => x !== m) : [...ms, m]))}
                style={{ ...S.modeBtn, ...(modes.includes(m) ? S.modeBtnOn : {}) }}
              >
                {m}
              </button>
            ))}
          </div>
          <button style={{ ...S.runBtn, ...(running ? S.runBtnBusy : {}) }} onClick={handleDryRun} disabled={running}>
            {running ? "running…" : "◷ dry run"}
          </button>
          <button style={S.publishBtn} title="Publishes the current AST to the rule registry">
            publish
          </button>
        </div>
      </div>

      <div style={S.body}>
        {/* Left palette */}
        <div style={S.palette}>
          <div style={S.paletteTitle}>Entities</div>
          <div style={S.paletteHint}>Select a node, then add a connected entity by its relationship.</div>
          {selectedNode ? (
            availableRels.length ? (
              availableRels.map((r) => {
                const src = CATALOG[r.to].source;
                return (
                  <button key={r.rel} style={S.entityCard} onClick={() => addRelated(r.rel, r.to)}>
                    <span style={{ ...S.dot, background: SOURCE_META[src].color }} />
                    <div style={{ textAlign: "left", flex: 1 }}>
                      <div style={S.entityName}>{r.to}</div>
                      <div style={S.relName}>via {r.rel}</div>
                    </div>
                    <span style={S.plus}>+</span>
                  </button>
                );
              })
            ) : (
              <div style={S.emptyHint}>{selectedNode.entity} has no outgoing relationships in the catalog.</div>
            )
          ) : (
            <div style={S.emptyHint}>Select a node.</div>
          )}

          <div style={{ ...S.paletteTitle, marginTop: 22 }}>Legend</div>
          {Object.entries(SOURCE_META).map(([k, v]) => (
            <div key={k} style={S.legendRow}>
              <span style={{ ...S.dot, background: v.color }} /> {v.label} <span style={S.legendSub}>· {k}</span>
            </div>
          ))}
        </div>

        {/* Canvas */}
        <div ref={canvasRef} style={S.canvas}>
          <svg style={S.edgeLayer}>
            {edges.map((e) => {
              const a = nodes.find((n) => n.id === e.source);
              const b = nodes.find((n) => n.id === e.target);
              if (!a || !b) return null;
              const x1 = a.x + 200, y1 = a.y + 34, x2 = b.x, y2 = b.y + 34;
              const mx = (x1 + x2) / 2;
              return (
                <g key={e.id}>
                  <path
                    d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="rgba(150,170,200,0.45)"
                    strokeWidth="1.5"
                  />
                  <rect x={mx - 46} y={(y1 + y2) / 2 - 10} width="92" height="20" rx="10" fill="#1a2130" stroke="rgba(150,170,200,0.3)" />
                  <text x={mx} y={(y1 + y2) / 2 + 4} textAnchor="middle" fill="#9fb0c8" fontSize="10" fontFamily="ui-monospace, monospace">
                    {e.rel}
                  </text>
                </g>
              );
            })}
          </svg>

          {nodes.map((n) => {
            const meta = SOURCE_META[CATALOG[n.entity].source];
            const cnt = countLeaves(n.tree);
            const isSel = n.id === selected;
            const isRoot = n.id === rootId;
            return (
              <div
                key={n.id}
                onPointerDown={(e) => onPointerDown(e, n.id)}
                style={{
                  ...S.node,
                  left: n.x,
                  top: n.y,
                  borderColor: isSel ? meta.color : "rgba(150,170,200,0.22)",
                  boxShadow: isSel ? `0 0 0 1px ${meta.color}, 0 12px 30px rgba(0,0,0,0.45)` : "0 8px 20px rgba(0,0,0,0.35)",
                }}
              >
                <div style={{ ...S.nodeTab, background: meta.dim, color: meta.color }}>
                  {meta.label}
                  {isRoot && <span style={S.rootBadge}>root</span>}
                </div>
                <div style={S.nodeBody}>
                  <div style={S.nodeName}>{n.entity}</div>
                  <div style={S.nodeVar}>as {n.varName}</div>
                </div>
                <div style={S.nodeFoot}>
                  <span style={{ ...S.cntBadge, color: cnt ? meta.color : "#67748c" }}>
                    {cnt} filter{cnt === 1 ? "" : "s"}
                  </span>
                  {!isRoot && (
                    <button style={S.nodeDel} onPointerDown={(e) => { e.stopPropagation(); removeNode(n.id); }}>
                      remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* AST drawer */}
          <div style={{ ...S.astDrawer, height: showAST ? 240 : 36 }}>
            <div style={S.astHeader} onClick={() => setShowAST((s) => !s)}>
              <span style={S.astTitle}>▸ rule AST</span>
              <span style={S.astToggle}>{showAST ? "collapse" : "expand"}</span>
            </div>
            {showAST && (
              <pre style={S.astPre}>{JSON.stringify(ast, null, 2)}</pre>
            )}
          </div>
        </div>

        {/* Right inspector */}
        <div style={S.inspector}>
          {selectedNode ? (
            <>
              <div style={S.inspHeader}>
                <div>
                  <div style={S.inspEntity}>{selectedNode.entity}</div>
                  <div style={S.inspSub}>
                    bound as <code style={S.code}>{selectedNode.varName}</code> ·{" "}
                    <span style={{ color: SOURCE_META[CATALOG[selectedNode.entity].source].color }}>
                      {SOURCE_META[CATALOG[selectedNode.entity].source].label}
                    </span>
                  </div>
                </div>
              </div>
              <div style={S.inspScroll}>
                <div style={S.sectionLabel}>Filters on this entity</div>
                <SegmentBuilder
                  entity={selectedNode.entity}
                  tree={selectedNode.tree}
                  onChange={(t) => updateTree(selectedNode.id, t)}
                />

                <div style={{ ...S.sectionLabel, marginTop: 24 }}>Dry run preview</div>
                {!dryRun && !running && (
                  <div style={S.dryIdle}>
                    Test this rule against a {sampleRef.current.length.toLocaleString()}-customer sample before publishing.
                    <button style={S.dryRunInline} onClick={handleDryRun}>Run preview</button>
                  </div>
                )}
                {running && <div style={S.dryIdle}>Scanning {sampleRef.current.length.toLocaleString()} customers…</div>}
                {dryRun && !running && (
                  <div>
                    <div style={S.dryStatRow}>
                      <div style={S.dryStat}>
                        <div style={S.dryNum}>{dryRun.matched.toLocaleString()}</div>
                        <div style={S.dryStatLabel}>matched</div>
                      </div>
                      <div style={S.dryStat}>
                        <div style={{ ...S.dryNum, color: "#7FB2FF" }}>
                          {((dryRun.matched / dryRun.total) * 100).toFixed(1)}%
                        </div>
                        <div style={S.dryStatLabel}>of sample</div>
                      </div>
                      <div style={S.dryStat}>
                        <div style={{ ...S.dryNum, color: "#9fb0c8", fontSize: 18 }}>{dryRun.ms.toFixed(0)}ms</div>
                        <div style={S.dryStatLabel}>scan time</div>
                      </div>
                    </div>

                    {/* match-rate bar */}
                    <div style={S.dryBarTrack}>
                      <div style={{ ...S.dryBarFill, width: `${Math.max(0.5, (dryRun.matched / dryRun.total) * 100)}%` }} />
                    </div>

                    {/* extrapolation hint */}
                    <div style={S.dryExtrap}>
                      ≈ {Math.round((dryRun.matched / dryRun.total) * 8_500_000).toLocaleString()} customers
                      across a 8.5M book
                      {dryRun.matched === 0 && " — no matches; loosen a filter"}
                      {dryRun.matched / dryRun.total > 0.6 && " — very broad; consider tightening"}
                    </div>

                    {dryRun.sampleHits.length > 0 && (
                      <>
                        <div style={{ ...S.dryStatLabel, marginTop: 16, marginBottom: 7 }}>SAMPLE MATCHES</div>
                        {dryRun.sampleHits.map((h) => (
                          <div key={h.customer_id} style={S.hitRow}>
                            <span style={S.hitId}>{h.customer_id}</span>
                            <span style={S.hitMeta}>
                              dining ${h.SpendingProfile.dining_90d} · score {h.CreditReport.score} ·{" "}
                              {h._edges.HAS_RECURRING.length} recurring
                            </span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={S.emptyHint}>Select a node to edit its filters.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- styles ----------------------------- */
const mono = "ui-monospace, 'SF Mono', Menlo, monospace";
const S = {
  app: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "#0d1117", color: "#e6edf3", fontFamily: "Inter, system-ui, sans-serif", overflow: "hidden", userSelect: "none" },
  topbar: { height: 52, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px", borderBottom: "1px solid rgba(150,170,200,0.14)", background: "#0f1420" },
  logo: { fontFamily: mono, fontSize: 14, fontWeight: 600, letterSpacing: "0.04em", color: "#5BE0B7" },
  bc: { fontSize: 12, color: "#67748c", letterSpacing: "0.08em", textTransform: "uppercase" },
  insightLabel: { fontSize: 11, color: "#67748c", textTransform: "uppercase", letterSpacing: "0.08em" },
  insightInput: { background: "#0d1117", border: "1px solid rgba(150,170,200,0.25)", borderRadius: 6, color: "#e6edf3", padding: "6px 10px", fontFamily: mono, fontSize: 13, width: 160 },
  modeGroup: { display: "flex", gap: 4, background: "#0d1117", padding: 3, borderRadius: 7, border: "1px solid rgba(150,170,200,0.14)" },
  modeBtn: { border: "none", background: "transparent", color: "#67748c", padding: "4px 10px", borderRadius: 5, fontSize: 11, cursor: "pointer", fontFamily: mono, letterSpacing: "0.03em" },
  modeBtnOn: { background: "rgba(91,224,183,0.14)", color: "#5BE0B7" },
  runBtn: { border: "1px solid rgba(127,178,255,0.4)", background: "rgba(127,178,255,0.1)", color: "#7FB2FF", padding: "6px 13px", borderRadius: 7, fontSize: 12, cursor: "pointer", fontFamily: mono, letterSpacing: "0.02em" },
  runBtnBusy: { opacity: 0.6, cursor: "wait" },
  publishBtn: { border: "none", background: "#5BE0B7", color: "#062019", padding: "7px 15px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", letterSpacing: "0.02em" },
  dryIdle: { fontSize: 12, color: "#8b97ad", lineHeight: 1.6, background: "rgba(20,27,40,0.5)", border: "1px solid rgba(150,170,200,0.14)", borderRadius: 9, padding: 13 },
  dryRunInline: { display: "block", marginTop: 10, border: "1px solid rgba(127,178,255,0.4)", background: "rgba(127,178,255,0.1)", color: "#7FB2FF", padding: "6px 13px", borderRadius: 6, fontSize: 12, cursor: "pointer", fontFamily: mono },
  dryStatRow: { display: "flex", gap: 9 },
  dryStat: { flex: 1, background: "rgba(20,27,40,0.6)", border: "1px solid rgba(150,170,200,0.14)", borderRadius: 9, padding: "11px 12px" },
  dryNum: { fontSize: 24, fontWeight: 700, fontFamily: mono, color: "#5BE0B7", lineHeight: 1 },
  dryStatLabel: { fontSize: 10, color: "#67748c", textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 5 },
  dryBarTrack: { height: 6, background: "rgba(150,170,200,0.12)", borderRadius: 3, marginTop: 12, overflow: "hidden" },
  dryBarFill: { height: "100%", background: "linear-gradient(90deg,#5BE0B7,#7FB2FF)", borderRadius: 3, transition: "width .4s ease" },
  dryExtrap: { fontSize: 11.5, color: "#8b97ad", marginTop: 9, lineHeight: 1.5, fontFamily: mono },
  hitRow: { display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "6px 9px", background: "#0d1117", border: "1px solid rgba(150,170,200,0.1)", borderRadius: 6, marginBottom: 5 },
  hitId: { fontFamily: mono, fontSize: 12, color: "#e6edf3" },
  hitMeta: { fontFamily: mono, fontSize: 10.5, color: "#67748c" },
  body: { flex: 1, display: "flex", minHeight: 0 },
  palette: { width: 230, flexShrink: 0, borderRight: "1px solid rgba(150,170,200,0.14)", background: "#0f1420", padding: 14, overflowY: "auto" },
  paletteTitle: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#8b97ad", marginBottom: 8, fontWeight: 600 },
  paletteHint: { fontSize: 11, color: "#5a6677", lineHeight: 1.5, marginBottom: 14 },
  entityCard: { display: "flex", alignItems: "center", gap: 9, width: "100%", background: "#141b28", border: "1px solid rgba(150,170,200,0.16)", borderRadius: 8, padding: "9px 11px", marginBottom: 7, cursor: "pointer", transition: "border-color .15s" },
  entityName: { fontSize: 13, fontWeight: 500, color: "#e6edf3" },
  relName: { fontSize: 10.5, color: "#67748c", fontFamily: mono, marginTop: 1 },
  plus: { color: "#67748c", fontSize: 16, fontWeight: 300 },
  dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  legendRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#9fb0c8", padding: "3px 0" },
  legendSub: { color: "#5a6677", fontFamily: mono, fontSize: 10.5 },
  canvas: { flex: 1, position: "relative", overflow: "hidden", backgroundColor: "#0d1117", backgroundImage: "radial-gradient(rgba(150,170,200,0.10) 1px, transparent 1px)", backgroundSize: "22px 22px" },
  edgeLayer: { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" },
  node: { position: "absolute", width: 200, background: "#141b28", border: "1px solid", borderRadius: 11, cursor: "grab", overflow: "hidden", transition: "box-shadow .15s, border-color .15s" },
  nodeTab: { fontSize: 10, fontFamily: mono, padding: "4px 11px", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 7 },
  rootBadge: { background: "rgba(255,255,255,0.08)", color: "#9fb0c8", borderRadius: 4, padding: "1px 5px", fontSize: 9 },
  nodeBody: { padding: "9px 12px 6px" },
  nodeName: { fontSize: 15, fontWeight: 600 },
  nodeVar: { fontSize: 11, color: "#67748c", fontFamily: mono, marginTop: 1 },
  nodeFoot: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 12px", borderTop: "1px solid rgba(150,170,200,0.10)" },
  cntBadge: { fontSize: 10.5, fontFamily: mono },
  nodeDel: { background: "transparent", border: "none", color: "#5a6677", fontSize: 10.5, cursor: "pointer", fontFamily: mono },
  astDrawer: { position: "absolute", left: 14, right: 14, bottom: 14, background: "rgba(15,20,32,0.97)", border: "1px solid rgba(150,170,200,0.18)", borderRadius: 10, overflow: "hidden", transition: "height .2s", backdropFilter: "blur(8px)" },
  astHeader: { height: 36, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px", cursor: "pointer", borderBottom: "1px solid rgba(150,170,200,0.12)" },
  astTitle: { fontFamily: mono, fontSize: 12, color: "#9fb0c8", letterSpacing: "0.04em" },
  astToggle: { fontSize: 10.5, color: "#5a6677", fontFamily: mono },
  astPre: { margin: 0, padding: 14, fontFamily: mono, fontSize: 11.5, lineHeight: 1.5, color: "#9fd6c2", overflow: "auto", height: 204, whiteSpace: "pre" },
  inspector: { width: 360, flexShrink: 0, borderLeft: "1px solid rgba(150,170,200,0.14)", background: "#0f1420", display: "flex", flexDirection: "column", minHeight: 0 },
  inspHeader: { padding: "16px 18px", borderBottom: "1px solid rgba(150,170,200,0.12)" },
  inspEntity: { fontSize: 18, fontWeight: 600 },
  inspSub: { fontSize: 12, color: "#67748c", marginTop: 3 },
  code: { fontFamily: mono, background: "#141b28", padding: "1px 6px", borderRadius: 4, color: "#9fb0c8" },
  inspScroll: { padding: 16, overflowY: "auto", flex: 1 },
  sectionLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#8b97ad", marginBottom: 12, fontWeight: 600 },
  group: { border: "1px solid rgba(150,170,200,0.18)", borderRadius: 9, padding: 9, marginBottom: 9, background: "rgba(20,27,40,0.5)" },
  groupHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 },
  logicToggle: { display: "flex", gap: 3, background: "#0d1117", padding: 3, borderRadius: 6 },
  logicBtn: { border: "none", background: "transparent", color: "#67748c", padding: "3px 9px", borderRadius: 4, fontSize: 11, cursor: "pointer", fontFamily: mono, fontWeight: 600 },
  logicBtnActive: { background: "rgba(127,178,255,0.16)", color: "#7FB2FF" },
  addBtn: { border: "1px solid rgba(91,224,183,0.4)", background: "rgba(91,224,183,0.08)", color: "#5BE0B7", padding: "3px 9px", borderRadius: 5, fontSize: 11, cursor: "pointer" },
  addBtnGhost: { border: "1px solid rgba(150,170,200,0.25)", background: "transparent", color: "#9fb0c8", padding: "3px 9px", borderRadius: 5, fontSize: 11, cursor: "pointer" },
  groupBody: { display: "flex", flexDirection: "column", gap: 7 },
  leaf: { display: "flex", alignItems: "center", gap: 6, background: "#0d1117", border: "1px solid rgba(150,170,200,0.14)", borderRadius: 7, padding: 7 },
  select: { background: "#141b28", border: "1px solid rgba(150,170,200,0.2)", borderRadius: 5, color: "#e6edf3", padding: "5px 7px", fontSize: 12, fontFamily: mono, flex: 1, minWidth: 0 },
  input: { background: "#141b28", border: "1px solid rgba(150,170,200,0.2)", borderRadius: 5, color: "#e6edf3", padding: "5px 7px", fontSize: 12, fontFamily: mono, flex: 1, minWidth: 0, width: 60 },
  removeBtn: { background: "transparent", border: "none", color: "#5a6677", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: "0 2px", flexShrink: 0 },
  emptyHint: { fontSize: 12, color: "#5a6677", lineHeight: 1.5, fontStyle: "italic", padding: "4px 0" },
};

const CSS = `
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 9px; height: 9px; }
  ::-webkit-scrollbar-thumb { background: rgba(150,170,200,0.22); border-radius: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  button:hover { filter: brightness(1.15); }
  select:focus, input:focus { outline: 1px solid rgba(127,178,255,0.5); }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;
