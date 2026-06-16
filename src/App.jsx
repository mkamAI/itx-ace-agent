import { useState, useCallback, useRef } from "react";
import JSZip from "jszip";

// ─── WTX .mms binary parser (runs in browser) ────────────────────────────────
function parseMmsBinary(buffer) {
  const bytes = new Uint8Array(buffer);
  const strings = [];
  let cur = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 0x20 && b <= 0x7e) {
      cur.push(String.fromCharCode(b));
    } else {
      if (cur.length >= 3) strings.push(cur.join(""));
      cur = [];
    }
  }
  if (cur.length >= 3) strings.push(cur.join(""));

  const pairs = [];
  const seen = new Set();
  for (let i = 0; i < strings.length - 1; i++) {
    const s = strings[i + 1];
    if (s.startsWith("=") && strings[i].length > 4) {
      const target = strings[i];
      const source = s.slice(1);
      const key = target + "||" + source;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({ target, source });
      }
    }
  }

  // Prefer MF_ names (full map) over F_MAP_ (sub-map functions)
  const mfNames = strings.filter((s) => s.startsWith("MF_") && s.length > 4);
  const mapName = mfNames.length > 0 ? mfNames[0] : (strings.find((s) => s.startsWith("F_MAP_")) || 'UnknownMap');
  const sourceSchema = strings.find((s) => s.endsWith(".mtt")) || "";

  return { mapName, sourceSchema, pairs };
}

function classifyRule(source) {
  if (source === "NONE") return { type: "Not Mapped", expr: "", constant: "", condition: "" };
  if (source.startsWith('"') && source.endsWith('"'))
    return { type: "Constant", expr: "", constant: source.replace(/"/g, ""), condition: "" };
  if (/^IF\s*\(/i.test(source)) {
    const m = source.match(/^IF\s*\((.+?),/i);
    return { type: "Conditional", expr: source, constant: "", condition: m ? m[1] : "" };
  }
  if (/EXTRACT\s*\(/i.test(source))
    return { type: "Extract", expr: source, constant: "", condition: "" };
  if (/MEMBER\s*\(/i.test(source))
    return { type: "Member Lookup", expr: source, constant: "", condition: "" };
  if (/F_MAP_\w+\s*\(/i.test(source))
    return { type: "Sub-Map Call", expr: source, constant: "", condition: "" };
  if (/SYMBOL\s*\(/i.test(source))
    return { type: "Expression", expr: source, constant: "", condition: "" };
  return { type: "Direct Map", expr: "", constant: "", condition: "" };
}

function parseWtxFieldPath(raw) {
  const parts = raw.split(":");
  if (parts.length >= 2) {
    const card = parts[parts.length - 1].trim();
    const path = parts
      .slice(0, -1)
      .map((p) => p.trim())
      .join(" › ");
    return { path, card };
  }
  return { path: raw, card: "" };
}

// ─── Mapping Spec (HTML report w/ client-side Export to Word) ────────────────
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function buildMappingSpecHtml(mapData) {
  const title = "ITX/WTX Field Mapping Specification";
  const active = mapData.mappings.filter((m) => m.rule.type !== "Not Mapped");
  const unmapped = mapData.mappings.filter((m) => m.rule.type === "Not Mapped");
  const safeTitle = (mapData.mapName || "itx_mapping_spec").replace(/[^A-Za-z0-9_-]+/g, "_") || "itx_mapping_spec";

  const rows = active.map((m, i) => {
    const t = parseWtxFieldPath(m.target);
    const s = m.rule.type === "Direct Map" ? parseWtxFieldPath(m.source) : { path: "", card: "" };
    const cls = i % 2 === 0 ? "even" : "odd";
    return (
      '<tr class="' + cls + '">' +
      "<td>" + escapeHtml(t.path) + "</td>" +
      "<td>" + escapeHtml(t.card) + "</td>" +
      "<td>" + escapeHtml(s.path) + "</td>" +
      "<td>" + escapeHtml(m.rule.type) + "</td>" +
      "<td>" + escapeHtml(m.rule.expr) + "</td>" +
      "<td>" + escapeHtml(m.rule.constant) + "</td>" +
      "<td>" + escapeHtml(m.rule.condition) + "</td>" +
      "<td></td>" +
      "</tr>"
    );
  }).join("\n");

  const noneRows = unmapped.map((m, i) => {
    const t = parseWtxFieldPath(m.target);
    const cls = i % 2 === 0 ? "even" : "odd";
    return (
      '<tr class="' + cls + '"><td>' + escapeHtml(t.path) + "</td><td>" + escapeHtml(t.card) + "</td></tr>"
    );
  }).join("\n");

  const noneSection = unmapped.length
    ? (
      "<h3>Unmapped Target Fields (" + unmapped.length + " &mdash; set to NONE)</h3>" +
      '<table class="none-table"><thead><tr><th>Target Field</th><th>Target Card</th></tr></thead><tbody>' +
      noneRows +
      "</tbody></table>"
    )
    : "";

  const css = [
    "body { font-family: Calibri, Arial, sans-serif; color:#222; margin:0; padding:0 28px 48px; background:#fafafa; }",
    ".toolbar { position: sticky; top:0; background:#fff; padding:14px 4px; border-bottom:2px solid #1F497D; display:flex; align-items:center; justify-content:space-between; z-index:100; }",
    ".toolbar h1 { margin:0; font-size:18px; color:#1F497D; }",
    "#exportBtn { background:#1F497D; color:#fff; border:none; padding:10px 18px; border-radius:4px; font-size:14px; cursor:pointer; }",
    "#exportBtn:hover { background:#163a63; }",
    "#exportBtn:disabled { opacity:0.6; cursor:default; }",
    "h1.doc-title { text-align:center; color:#1F497D; font-size:24px; margin:28px 0 4px; }",
    ".subtitle { text-align:center; font-style:italic; color:#444; margin-top:0; margin-bottom:28px; }",
    "h2 { color:#1F497D; border-bottom:1px solid #ccc; padding-bottom:4px; margin-top:36px; }",
    "h3 { color:#404040; margin-top:22px; font-size:15px; }",
    "table { border-collapse: collapse; width:100%; margin-bottom:18px; font-size:13px; background:#fff; }",
    "table, th, td { border:1px solid #999; }",
    "th { background:#1F497D; color:#fff; padding:6px 8px; text-align:left; font-size:12px; }",
    "td { padding:6px 8px; vertical-align:top; }",
    "tr.even td { background:#F0F5FA; }",
    "tr.odd td { background:#FFFFFF; }",
    ".summary-table td:first-child { background:#DEEAF1; font-weight:bold; width:280px; }",
    ".meta p { margin:2px 0; font-size:13px; }",
    ".meta b { color:#1F497D; }",
    ".none-table th { background:#808080; }",
    ".none-table tr.even td { background:#F8F8F8; }",
    "@media print { .toolbar { display:none; } }",
  ].join("\n");

  const summaryRows = [
    ["Map Name", mapData.mapName],
    ["Source File", mapData.fileName || "—"],
    ["Source Schema", mapData.sourceSchema || "—"],
    ["Active Field Mappings", active.length],
    ["Unmapped Fields (NONE)", unmapped.length],
    ["Total Rules", mapData.mappings.length],
  ].map(([k, v]) => "<tr><td>" + escapeHtml(k) + "</td><td>" + escapeHtml(v) + "</td></tr>").join("\n");

  const content =
    '<h1 class="doc-title">' + escapeHtml(title) + "</h1>" +
    '<p class="subtitle">IIB/ACE Project Interchange &mdash; WTX/ITX Field Mapping Specification</p>' +
    "<h2>Summary</h2>" +
    '<table class="summary-table"><tbody>' + summaryRows + "</tbody></table>" +
    "<h2>1. " + escapeHtml(mapData.mapName) + "</h2>" +
    "<h3>Field Mappings (" + active.length + " active rules)</h3>" +
    "<table><thead><tr>" +
    "<th>Target Field</th><th>Target Card</th><th>Source Field</th><th>Transform Type</th>" +
    "<th>Expression / Rule</th><th>Constant</th><th>Condition</th><th>Notes</th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table>" +
    noneSection;

  const script = [
    "function exportToWord() {",
    "  var btn = document.getElementById('exportBtn');",
    "  var original = btn.textContent;",
    "  btn.disabled = true;",
    "  btn.textContent = 'Exporting…';",
    "  try {",
    "    var contentHtml = document.getElementById('export-content').innerHTML;",
    "    var styleTag = document.querySelector('style').innerHTML;",
    "    var sourceHTML = '<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>' + styleTag + '</style></head><body>' + contentHtml + '</body></html>';",
    "    var converted = htmlDocx.asBlob(sourceHTML);",
    "    saveAs(converted, '" + safeTitle + ".doc');",
    "  } catch (e) {",
    "    alert('Export to Word failed: ' + e.message);",
    "  } finally {",
    "    btn.disabled = false;",
    "    btn.textContent = original;",
    "  }",
    "}",
  ].join("\n");

  return (
    "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<title>" + escapeHtml(title) + "</title>" +
    "<style>" + css + "</style></head><body>" +
    '<div class="toolbar"><h1>' + escapeHtml(title) + '</h1>' +
    '<button id="exportBtn" onclick="exportToWord()">&#8681; Export to Word</button></div>' +
    '<div id="export-content">' + content + "</div>" +
    '<script src="https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js"></sc' + 'ript>' +
    '<script src="https://cdn.jsdelivr.net/npm/html-docx-js@0.3.1/dist/html-docx.js"></sc' + 'ript>' +
    "<script>" + script + "</sc" + "ript>" +
    "</body></html>"
  );
}

// ─── Prompt builder ───────────────────────────────────────────────────────────
function buildPrompt(mappings, mapName, sourceSchema) {
  const mappingLines = mappings
    .map((m, i) => {
      const t = parseWtxFieldPath(m.target);
      const s = m.rule.type === "Direct Map" ? parseWtxFieldPath(m.source) : { path: m.source };
      return (i + 1) + ". TARGET: " + t.path + "\n" +
        "   SOURCE: " + s.path + "\n" +
        "   TYPE: " + m.rule.type +
        (m.rule.constant ? "\n   CONSTANT: \"" + m.rule.constant + "\"" : "") +
        (m.rule.expr ? "\n   EXPRESSION: " + m.rule.expr : "");
    })
    .join("\n\n");

  return "You are an IBM ACE ESQL developer. Convert these WTX field mappings to ESQL statements.\n\n" +
    "Source: " + (sourceSchema || "HL7 ADT 2.5") + "\n\n" +
    "Path rules:\n" +
    "- Input:  InputRoot.DFDL.HL7.<Segment>.<Field>\n" +
    "- Output: OutputRoot.DFDL.HL7.<Segment>.<Field>\n" +
    "- Direct Map: SET OutputRoot.DFDL.HL7.X = InputRoot.DFDL.HL7.Y;\n" +
    "- Constant:   SET OutputRoot.DFDL.HL7.X = \'VALUE\';\n" +
    "- Conditional: IF cond THEN SET ...; END IF;\n" +
    "- Extract MRN: DECLARE v CHARACTER; SET v = (SELECT ITEM.ID FROM InputRoot.DFDL.HL7.Seg.Field[] AS ITEM WHERE ITEM.IdentifierTypeCode = \'MRN\'); IF v IS NOT NULL THEN SET OutputRoot.DFDL.HL7.X = v; END IF;\n" +
    "- Sub-Map: CALL F_MAP_NAME();\n\n" +
    "Output ONLY ESQL statements. No CREATE MODULE, no PROPAGATE, no procedures.\n" +
    "Add a -- comment before each mapping. Never truncate a statement.\n\n" +
    "MAPPINGS:\n" + mappingLines;
}


// ─── Claude API call ──────────────────────────────────────────────────────────
async function callClaude(prompt, onChunk) {
  const resp = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 16000,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  console.log("API response status:", resp.status, resp.headers.get("content-type"));
  if (!resp.ok) { const t = await resp.text(); throw new Error(`API error ${resp.status}: ${t}`); }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buffer = ""; // holds any partial SSE line split across chunk boundaries

  const processLine = (line) => {
    if (line.startsWith("data: ")) {
      try {
        const json = JSON.parse(line.slice(6));
        if (json.type === "content_block_delta" && json.delta?.text) {
          full += json.delta.text;
          onChunk(full);
        }
      } catch {}
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // stream:true keeps a trailing partial multi-byte UTF-8 sequence buffered
    // inside the decoder instead of corrupting it into U+FFFD
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // the last element may be an incomplete line — hold it for the next read()
    buffer = lines.pop();
    for (const line of lines) processLine(line);
  }
  // flush the decoder tail plus any unterminated final line
  buffer += decoder.decode();
  if (buffer) processLine(buffer);
  return full;
}

// ─── Components ───────────────────────────────────────────────────────────────
const COLORS = {
  bg: "#0f1117",
  surface: "#1a1d27",
  border: "#2a2d3a",
  accent: "#6c8ef5",
  accentDim: "#3d4f8a",
  green: "#4ade80",
  amber: "#fbbf24",
  red: "#f87171",
  text: "#e2e8f0",
  muted: "#6b7280",
  code: "#1e2130",
};

const TYPE_COLORS = {
  "Direct Map":    "#4ade80",
  Constant:        "#fbbf24",
  Conditional:     "#a78bfa",
  Extract:         "#38bdf8",
  "Member Lookup": "#fb923c",
  "Sub-Map Call":  "#f472b6",
  Expression:      "#34d399",
  "Not Mapped":    "#374151",
};

function Badge({ type }) {
  const color = TYPE_COLORS[type] || "#6b7280";
  return (
    <span style={{
      background: color + "20",
      color,
      border: `1px solid ${color}40`,
      borderRadius: 4,
      padding: "1px 7px",
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: "0.03em",
      whiteSpace: "nowrap",
    }}>{type}</span>
  );
}

function MappingRow({ m, idx }) {
  const [open, setOpen] = useState(false);
  const t = parseWtxFieldPath(m.target);
  const s = m.rule.type === "Direct Map" ? parseWtxFieldPath(m.source) : null;

  return (
    <div style={{
      borderBottom: `1px solid ${COLORS.border}`,
      background: idx % 2 === 0 ? COLORS.surface : "#16192300",
    }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: "grid",
          gridTemplateColumns: "28px 1fr 1fr 130px",
          gap: 8,
          padding: "7px 12px",
          cursor: "pointer",
          alignItems: "center",
          fontSize: 12,
          color: COLORS.text,
        }}
      >
        <span style={{ color: COLORS.muted, fontVariantNumeric: "tabular-nums" }}>{idx + 1}</span>
        <span style={{ fontFamily: "monospace", color: "#93c5fd", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={t.path}>{t.path}</span>
        <span style={{ fontFamily: "monospace", color: COLORS.green, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={s ? s.path : m.source}>{s ? s.path : m.rule.constant || m.rule.expr || m.source}</span>
        <Badge type={m.rule.type} />
      </div>
      {open && (
        <div style={{
          padding: "8px 16px 12px 48px",
          background: COLORS.code,
          fontSize: 11,
          fontFamily: "monospace",
          color: "#cbd5e1",
          lineHeight: 1.7,
          borderTop: `1px solid ${COLORS.border}`,
        }}>
          <div><span style={{ color: COLORS.muted }}>TARGET: </span><span style={{ color: "#93c5fd" }}>{m.target}</span></div>
          <div><span style={{ color: COLORS.muted }}>SOURCE: </span><span style={{ color: COLORS.green }}>{m.source}</span></div>
          {m.rule.condition && <div><span style={{ color: COLORS.muted }}>CONDITION: </span><span style={{ color: "#a78bfa" }}>{m.rule.condition}</span></div>}
          {m.rule.expr && <div><span style={{ color: COLORS.muted }}>EXPR: </span><span style={{ color: "#fbbf24" }}>{m.rule.expr}</span></div>}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [stage, setStage] = useState("upload"); // upload | parsed | generating | done
  const [mapData, setMapData] = useState(null);
  const [esql, setEsql] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [progress, setProgress] = useState(0);
  const fileRef = useRef();

  const handleFile = useCallback(async (file) => {
    setError("");
    try {
      const ab = await file.arrayBuffer();

      // Unzip in browser using DecompressionStream or JSZip-like approach
      // We'll use a minimal ZIP parser
      const parsed = await parseZip(ab);
      const mmsEntry = Object.entries(parsed).find(([k]) => k.endsWith(".mms"));
      if (!mmsEntry) throw new Error("No .mms file found in the interchange ZIP");

      const { mapName, sourceSchema, pairs } = parseMmsBinary(mmsEntry[1]);
      const mappings = pairs.map((p) => ({
        target: p.target,
        source: p.source,
        rule: classifyRule(p.source),
      }));

      setMapData({ mapName, sourceSchema, mappings, fileName: file.name });
      setStage("parsed");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const generate = async () => {
    setStage("generating");
    setEsql("");
    setProgress(0);
    try {
      const allActive = mapData.mappings.filter(m => m.rule.type !== 'Not Mapped');
      const half = Math.ceil(allActive.length / 2);
      const part1 = allActive.slice(0, half);
      const part2 = allActive.slice(half);
      const moduleName = mapData.mapName.replace(/[^a-zA-Z0-9_]/g, '_');

      // Both passes: ask Claude for ONLY indented SET/IF statements, no module wrapper
      const prompt1 = buildPrompt(part1, mapData.mapName, mapData.sourceSchema);
      let body1 = '';
      await callClaude(prompt1, (text) => {
        body1 = text;
        setProgress(Math.min(45, Math.round((text.length / 4000) * 45)));
      });

      const prompt2 = buildPrompt(part2, mapData.mapName, mapData.sourceSchema);
      let body2 = '';
      await callClaude(prompt2, (text) => {
        body2 = text;
        setProgress(45 + Math.min(50, Math.round((text.length / 4000) * 50)));
      });

      // Strip any module/function boilerplate Claude may have added despite
      // instructions not to. A BLACKLIST (not a whitelist) is used here on
      // purpose: a whitelist of allowed line prefixes drops continuation
      // lines of any wrapped SET/IF statement, which is what caused
      // statements to get spliced together and IF/END IF counts to go
      // unbalanced.
      const extractStatements = (esql) => {
        return esql
          .split('\n')
          .filter(line => {
            const t = line.trim();
            if (t === '') return true;
            if (/^CREATE\s+(COMPUTE\s+)?MODULE\b/i.test(t)) return false;
            if (/^CREATE\s+FUNCTION\b/i.test(t)) return false;
            if (/^CREATE\s+PROCEDURE\b/i.test(t)) return false;
            if (/^END\s+MODULE\b/i.test(t)) return false;
            if (/^PROPAGATE\b/i.test(t)) return false;
            if (/^RETURN\s+(TRUE|FALSE)\s*;?\s*$/i.test(t)) return false;
            if (t === 'BEGIN') return false;
            if (t === 'END;') return false;
            // Strip stray markdown/header artifacts Claude sometimes prepends
            // to a part's raw response (e.g. "# ESQL Conversion - ... Mappings"
            // or fenced code blocks). '#' and '```' are never valid ESQL syntax
            // at the start of a line, so these are safe to blacklist outright.
            if (t.startsWith('#')) return false;
            if (t.startsWith('```')) return false;
            return true;
          })
          .join('\n');
      };

      const stmts1 = extractStatements(body1);
      const stmts2 = extractStatements(body2);

      // Wrap in a single clean module
      const merged = `CREATE COMPUTE MODULE ${moduleName}
  CREATE FUNCTION Main() RETURNS BOOLEAN
  BEGIN
    CALL CopyMessageHeaders();
    SET OutputRoot.DFDL = InputRoot.DFDL;

    -- ── Part 1 Mappings (1-${part1.length}) ──────────────────────────────────
${stmts1.trim()}

    -- ── Part 2 Mappings (${part1.length + 1}-${allActive.length}) ──────────────────────────────
${stmts2.trim()}

    PROPAGATE TO TERMINAL 'out';
    RETURN FALSE;
  END;

  CREATE PROCEDURE CopyMessageHeaders() BEGIN
    DECLARE I INTEGER 1;
    DECLARE J INTEGER CARDINALITY(InputRoot.*[]);
    WHILE I < J DO
      SET OutputRoot.*[I] = InputRoot.*[I];
      SET I = I + 1;
    END WHILE;
  END;

  CREATE PROCEDURE F_MAP_HL7_MRG() BEGIN
    SET OutputRoot.DFDL.HL7.MRG = InputRoot.DFDL.HL7.MRG;
  END;

  CREATE PROCEDURE F_MAP_PID3(IN mrnValue CHARACTER) BEGIN
    SET OutputRoot.DFDL.HL7.PID_LOOP.PID.PatientIDInternalID[1].ID = mrnValue;
    SET OutputRoot.DFDL.HL7.PID_LOOP.PID.PatientIDInternalID[1].IdentifierTypeCode = 'MRN';
  END;

END MODULE;`;

      setEsql(merged);
      setProgress(100);
      setStage('done');
    } catch (e) {
      setError(e.message);
      setStage("parsed");
    }
  };

  const openMappingSpec = () => {
    if (!mapData) return;
    const html = buildMappingSpecHtml(mapData);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  };

  const copy = () => navigator.clipboard.writeText(esql);
  const download = () => {
    const blob = new Blob([esql], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (mapData?.mapName || "mapping") + ".esql";
    a.click();
  };

  const activeMappings = mapData?.mappings.filter((m) => m.rule.type !== "Not Mapped") || [];
  const filteredMappings = mapData?.mappings.filter((m) =>
    filter === "all" ? true : filter === "active" ? m.rule.type !== "Not Mapped" : m.rule.type === filter
  ) || [];

  const typeCounts = mapData?.mappings.reduce((acc, m) => {
    acc[m.rule.type] = (acc[m.rule.type] || 0) + 1;
    return acc;
  }, {}) || {};

  return (
    <div style={{
      minHeight: "100vh",
      background: COLORS.bg,
      color: COLORS.text,
      fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Header */}
      <div style={{
        borderBottom: `1px solid ${COLORS.border}`,
        padding: "14px 24px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: COLORS.surface,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: `linear-gradient(135deg, ${COLORS.accent}, #a78bfa)`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 16,
        }}>⇄</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.02em" }}>
            ITX → ACE Migration Agent
          </div>
          <div style={{ fontSize: 11, color: COLORS.muted }}>
            WTX map → ESQL DFDL Compute node
          </div>
        </div>
        {mapData && (
          <div style={{
            marginLeft: "auto",
            background: COLORS.accentDim + "40",
            border: `1px solid ${COLORS.accentDim}`,
            borderRadius: 6,
            padding: "4px 12px",
            fontSize: 12,
            color: COLORS.accent,
          }}>
            {mapData.mapName}
          </div>
        )}
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* Left panel */}
        <div style={{
          width: stage === "upload" ? "100%" : 420,
          borderRight: `1px solid ${COLORS.border}`,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          transition: "width 0.3s ease",
        }}>

          {/* Upload zone */}
          {stage === "upload" && (
            <div style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 40,
            }}>
              <div
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileRef.current.click()}
                style={{
                  border: `2px dashed ${COLORS.accentDim}`,
                  borderRadius: 16,
                  padding: "60px 80px",
                  textAlign: "center",
                  cursor: "pointer",
                  maxWidth: 480,
                  transition: "border-color 0.2s",
                }}
              >
                <div style={{ fontSize: 48, marginBottom: 16 }}>📦</div>
                <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
                  Drop your IIB/ACE Interchange ZIP
                </div>
                <div style={{ color: COLORS.muted, fontSize: 13, marginBottom: 24, lineHeight: 1.6 }}>
                  The agent will parse the <code style={{ color: COLORS.accent }}>.mms</code> WTX binary map,
                  extract all field-level mappings, and generate an ESQL DFDL Compute node.
                </div>
                <div style={{
                  background: COLORS.accent,
                  color: "#fff",
                  borderRadius: 8,
                  padding: "10px 24px",
                  fontWeight: 600,
                  fontSize: 14,
                  display: "inline-block",
                }}>Browse File</div>
                <input ref={fileRef} type="file" accept=".zip" style={{ display: "none" }}
                  onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
              </div>
            </div>
          )}

          {/* Mappings panel */}
          {stage !== "upload" && mapData && (
            <>
              {/* Stats bar */}
              <div style={{
                padding: "12px 16px",
                borderBottom: `1px solid ${COLORS.border}`,
                display: "flex",
                gap: 16,
                flexWrap: "wrap",
                alignItems: "center",
              }}>
                <div style={{ fontSize: 12 }}>
                  <span style={{ color: COLORS.green, fontWeight: 700 }}>{activeMappings.length}</span>
                  <span style={{ color: COLORS.muted }}> active</span>
                </div>
                <div style={{ fontSize: 12 }}>
                  <span style={{ color: COLORS.muted, fontWeight: 700 }}>{typeCounts["Not Mapped"] || 0}</span>
                  <span style={{ color: COLORS.muted }}> unmapped</span>
                </div>
                <div style={{ fontSize: 12 }}>
                  <span style={{ color: COLORS.text, fontWeight: 700 }}>{mapData.mappings.length}</span>
                  <span style={{ color: COLORS.muted }}> total</span>
                </div>
                {mapData.sourceSchema && (
                  <div style={{ marginLeft: "auto", fontSize: 11, color: COLORS.muted, fontFamily: "monospace" }}>
                    {mapData.sourceSchema}
                  </div>
                )}
              </div>

              {/* Type filter chips */}
              <div style={{
                padding: "8px 12px",
                borderBottom: `1px solid ${COLORS.border}`,
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
              }}>
                {["all", "active", ...Object.keys(typeCounts)].map((f) => (
                  <button key={f} onClick={() => setFilter(f)} style={{
                    background: filter === f ? COLORS.accentDim : "transparent",
                    border: `1px solid ${filter === f ? COLORS.accent : COLORS.border}`,
                    color: filter === f ? COLORS.accent : COLORS.muted,
                    borderRadius: 4,
                    padding: "2px 8px",
                    fontSize: 11,
                    cursor: "pointer",
                    fontWeight: filter === f ? 600 : 400,
                  }}>
                    {f}{f !== "all" && f !== "active" && typeCounts[f] ? ` (${typeCounts[f]})` : ""}
                  </button>
                ))}
              </div>

              {/* Mapping table header */}
              <div style={{
                display: "grid",
                gridTemplateColumns: "28px 1fr 1fr 130px",
                gap: 8,
                padding: "6px 12px",
                background: COLORS.code,
                fontSize: 10,
                color: COLORS.muted,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                borderBottom: `1px solid ${COLORS.border}`,
              }}>
                <span>#</span>
                <span>Target Field</span>
                <span>Source / Value</span>
                <span>Type</span>
              </div>

              {/* Scrollable rows */}
              <div style={{ flex: 1, overflowY: "auto" }}>
                {filteredMappings.map((m, i) => (
                  <MappingRow key={i} m={m} idx={i} />
                ))}
              </div>

              {/* Generate button */}
              <div style={{
                padding: "12px 16px",
                borderTop: `1px solid ${COLORS.border}`,
                background: COLORS.surface,
              }}>
                {stage === "generating" ? (
                  <div>
                    <div style={{
                      height: 4,
                      background: COLORS.border,
                      borderRadius: 2,
                      marginBottom: 8,
                      overflow: "hidden",
                    }}>
                      <div style={{
                        height: "100%",
                        width: `${progress}%`,
                        background: `linear-gradient(90deg, ${COLORS.accent}, #a78bfa)`,
                        transition: "width 0.3s ease",
                        borderRadius: 2,
                      }} />
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.muted, textAlign: "center" }}>
                      Generating ESQL… {progress}%
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={openMappingSpec} title="Open an HTML mapping spec with an Export to Word button" style={{
                      flex: "0 0 auto",
                      background: "transparent",
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: 8,
                      padding: "11px 14px",
                      color: COLORS.text,
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}>
                      📄 Mapping Spec
                    </button>
                    <button onClick={generate} style={{
                      flex: 1,
                      background: `linear-gradient(135deg, ${COLORS.accent}, #a78bfa)`,
                      border: "none",
                      borderRadius: 8,
                      padding: "11px 0",
                      color: "#fff",
                      fontWeight: 700,
                      fontSize: 14,
                      cursor: "pointer",
                      letterSpacing: "-0.01em",
                    }}>
                      {stage === "done" ? "↺ Regenerate ESQL" : "⚡ Generate ACE ESQL"}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right panel — ESQL output */}
        {stage !== "upload" && (
          <div style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}>
            {/* Toolbar */}
            <div style={{
              padding: "10px 16px",
              borderBottom: `1px solid ${COLORS.border}`,
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: COLORS.surface,
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.muted }}>
                ESQL OUTPUT
              </span>
              {esql && (
                <>
                  <span style={{ fontSize: 11, color: COLORS.muted, marginLeft: 4 }}>
                    {esql.split("\n").length} lines
                  </span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <button onClick={copy} style={{
                      background: "transparent",
                      border: `1px solid ${COLORS.border}`,
                      color: COLORS.text,
                      borderRadius: 6,
                      padding: "5px 12px",
                      fontSize: 12,
                      cursor: "pointer",
                    }}>⎘ Copy</button>
                    <button onClick={download} style={{
                      background: COLORS.accent,
                      border: "none",
                      color: "#fff",
                      borderRadius: 6,
                      padding: "5px 12px",
                      fontSize: 12,
                      cursor: "pointer",
                      fontWeight: 600,
                    }}>↓ .esql</button>
                  </div>
                </>
              )}
            </div>

            {/* Code display */}
            <div style={{
              flex: 1,
              overflowY: "auto",
              background: COLORS.code,
              padding: "16px 20px",
            }}>
              {!esql && stage !== "generating" && (
                <div style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                  color: COLORS.muted,
                }}>
                  <div style={{ fontSize: 36 }}>⚡</div>
                  <div style={{ fontSize: 14 }}>Click "Generate ACE ESQL" to start</div>
                  <div style={{ fontSize: 12, textAlign: "center", maxWidth: 340, lineHeight: 1.6 }}>
                    The AI agent will convert all {activeMappings.length} active WTX rules
                    into an IBM ACE ESQL DFDL Compute node module
                  </div>
                </div>
              )}
              {esql && (
                <pre style={{
                  margin: 0,
                  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
                  fontSize: 12,
                  lineHeight: 1.65,
                  color: "#e2e8f0",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>
                  {colorizeEsql(esql)}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Error bar */}
      {error && (
        <div style={{
          background: "#7f1d1d",
          borderTop: `1px solid #ef4444`,
          padding: "10px 20px",
          fontSize: 13,
          color: "#fca5a5",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}>
          <span>⚠</span>
          <span>{error}</span>
          <button onClick={() => setError("")} style={{
            marginLeft: "auto", background: "none", border: "none",
            color: "#fca5a5", cursor: "pointer", fontSize: 16,
          }}>×</button>
        </div>
      )}
    </div>
  );
}

// ─── Minimal syntax highlight ────────────────────────────────────────────────
function colorizeEsql(code) {
  const lines = code.split("\n");
  return lines.map((line, i) => {
    let color = "#e2e8f0";
    if (/^\s*--/.test(line)) color = "#6b7280";
    else if (/^\s*(CREATE|MODULE|PROCEDURE|FUNCTION|BEGIN|END|DECLARE)\b/i.test(line)) color = "#a78bfa";
    else if (/^\s*(SET|IF|ELSEIF|ELSE|THEN|RETURN|CALL)\b/i.test(line)) color = "#6c8ef5";
    else if (/InputRoot|OutputRoot/.test(line)) color = "#4ade80";
    return (
      <span key={i} style={{ color, display: "block" }}>{line + "\n"}</span>
    );
  });
}

// ─── JSZip-based ZIP parser ──────────────────────────────────────────────────
async function parseZip(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const files = {};
  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir) {
      const ab = await file.async('arraybuffer');
      files[name] = ab;
    }
  }
  return files;
}
