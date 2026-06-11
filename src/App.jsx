import { useState, useCallback, useRef } from "react";

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

  const mapName = strings.find((s) => s.startsWith("MF_") || s.startsWith("F_MAP_")) || "Unknown Map";
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

// ─── Prompt builder ───────────────────────────────────────────────────────────
function buildPrompt(mappings, mapName, sourceSchema) {
  const active = mappings.filter((m) => m.rule.type !== "Not Mapped");

  const mappingLines = active
    .map((m, i) => {
      const t = parseWtxFieldPath(m.target);
      const s = m.rule.type === "Direct Map" ? parseWtxFieldPath(m.source) : { path: m.source };
      return `${i + 1}. TARGET: ${t.path} (card: ${t.card})
   SOURCE: ${s.path}
   TYPE: ${m.rule.type}${m.rule.constant ? `\n   CONSTANT: "${m.rule.constant}"` : ""}${m.rule.condition ? `\n   CONDITION: ${m.rule.condition}` : ""}${m.rule.expr ? `\n   EXPRESSION: ${m.rule.expr}` : ""}`;
    })
    .join("\n\n");

  return `IMPORTANT: Output raw ESQL code only. Do NOT use markdown, backticks, code fences, or any formatting. Start your response directly with: CREATE COMPUTE MODULE

You are an IBM ACE ESQL developer converting a WTX map to native ACE ESQL.
Map module name: ${mapName.replace(/[^a-zA-Z0-9_]/g, "_")}
Source schema: ${sourceSchema || "HL7 ADT 2.5"}
Total mappings to implement: ${active.length}

Use this exact ESQL structure:

CREATE COMPUTE MODULE <ModuleName>
  CREATE FUNCTION Main() RETURNS BOOLEAN
  BEGIN
    CALL CopyMessageHeaders();
    -- mappings here
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
END MODULE;

ESQL path conventions:
- Input:  InputRoot.MRM.<Segment>.<Field>
- Output: OutputRoot.MRM.<Segment>.<Field>
- Direct map: SET OutputRoot.MRM.X = InputRoot.MRM.Y;
- Constant:   SET OutputRoot.MRM.X = 'VALUE';
- Conditional: IF <cond> THEN SET OutputRoot.MRM.X = ...; END IF;
- For Sub-Map calls (F_MAP_xxx): inline as a helper procedure
- Add -- comment above each mapping explaining the field

ALL ${active.length} MAPPINGS TO IMPLEMENT:
${mappingLines}

REMINDER: Raw ESQL only. No markdown. No backticks. Start with CREATE COMPUTE MODULE.`;
}

// ─── Claude API call ──────────────────────────────────────────────────────────
async function callClaude(prompt, onChunk) {
  const resp = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) throw new Error(`API error ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const json = JSON.parse(line.slice(6));
          if (json.type === "content_block_delta" && json.delta?.text) {
            full += json.delta.text;
            onChunk(full);
          }
        } catch {}
      }
    }
  }
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
      const prompt = buildPrompt(mapData.mappings, mapData.mapName, mapData.sourceSchema);
      let chars = 0;
      await callClaude(prompt, (text) => {
        setEsql(text);
        chars = text.length;
        setProgress(Math.min(95, Math.round((chars / 6000) * 100)));
      });
      setProgress(100);
      setStage("done");
    } catch (e) {
      setError(e.message);
      setStage("parsed");
    }
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
                  <button onClick={generate} style={{
                    width: "100%",
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

// ─── Minimal browser ZIP parser ──────────────────────────────────────────────
async function parseZip(buffer) {
  // Find all local file headers (PK\x03\x04) and extract entries
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const files = {};

  let offset = 0;
  while (offset < bytes.length - 4) {
    // Local file header signature
    if (view.getUint32(offset, true) !== 0x04034b50) {
      offset++;
      continue;
    }
    const compression = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const fileNameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameBytes = bytes.slice(offset + 30, offset + 30 + fileNameLen);
    const name = new TextDecoder().decode(nameBytes);
    const dataOffset = offset + 30 + fileNameLen + extraLen;

    if (!name.endsWith("/")) {
      const compressedData = bytes.slice(dataOffset, dataOffset + compressedSize);
      if (compression === 0) {
        // Stored (no compression)
        files[name] = compressedData.buffer;
      } else if (compression === 8) {
        // Deflate
        try {
          const ds = new DecompressionStream("deflate-raw");
          const writer = ds.writable.getWriter();
          writer.write(compressedData);
          writer.close();
          const chunks = [];
          const reader = ds.readable.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const total = chunks.reduce((s, c) => s + c.length, 0);
          const out = new Uint8Array(total);
          let pos = 0;
          for (const c of chunks) { out.set(c, pos); pos += c.length; }
          files[name] = out.buffer;
        } catch (e) {
          // fallback: store compressed if decompression fails
          files[name] = compressedData.buffer;
        }
      }
    }
    offset = dataOffset + compressedSize;
    if (compressedSize === 0) offset = dataOffset + 1;
  }
  return files;
}
