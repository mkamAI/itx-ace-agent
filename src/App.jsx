import { useState, useCallback, useRef, useEffect } from "react";
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


// ─── ACE Graphical Mapping (.map) generation ─────────────────────────────────
// Reference sample supplied by the user (MFP_MICHART_PACEART.map) — a real,
// hand-built .map for the same HL7 v2.7 ADT message family. Used as a
// structural/style exemplar in the generation prompt below (few-shot), and
// its boilerplate header/footer (everything outside the per-segment field
// logic) is reused verbatim so the outer envelope is always well-formed,
// mirroring how ESQL generation hardcodes its module wrapper rather than
// asking the model to regenerate boilerplate it might get subtly wrong.
const SAMPLE_MAP_XML = `<?xml version="1.0" encoding="UTF-8"?><mappingRoot xmlns="http://www.ibm.com/2008/ccl/Mapping" domainID="com.ibm.msl.mapping.xml" domainIDExtension="mb" mainMap="true" targetNamespace="default" version="8.0.5.0" xmlns:map="default">
    <input path="mbsharedlib://HL7v27ADTSharedLibrary/chapter3.xsd"/>
    <output path="mbsharedlib://HL7v27ADTSharedLibrary/chapter3.xsd"/>
    <namespaces>
        <namespace kind="supplement" prefix="MSH" uri="urn:hl7-org:v2xml"/>
        <namespace kind="extension" prefix="fn" uri="http://www.w3.org/2005/xpath-functions"/>
    </namespaces>
    <generation engine="xquery"/>
    <mappingDeclaration name="MFP_MICHART_PACEART">
        <input namespace="urn:hl7-org:v2xml" path="mb:msg(ADT_ALL,assembly,DFDL,Properties)" var="MessageAssembly"/>
        <output namespace="urn:hl7-org:v2xml" path="mb:msg(ADT_ALL,assembly,DFDL,Properties)" var="MessageAssembly1"/>
        <move>
            <input path="$MessageAssembly/Properties"/>
            <output path="$MessageAssembly1/Properties"/>
            <override>
                <assign value="{HL7v27ADTSharedLibrary}">
                    <output path="$MessageAssembly1/Properties/MessageSet"/>
                </assign>
                <assign value="{urn:hl7-org:v2xml}:ADT_ALL">
                    <output path="$MessageAssembly1/Properties/MessageType"/>
                </assign>
            </override>
        </move>
        <if>
            <input path="$MessageAssembly/ADT_ALL" var="ADT_ALL"/>
            <output path="$MessageAssembly1/ADT_ALL"/>
            <test lang="xpath">$ADT_ALL/MSH:MSH/MSH:MSH.9.MessageType/MSH:MSG.2 = ('A04', 'A08', 'A28', 'A29', 'A47')&#13;
and $ADT_ALL/MSH:PV1/MSH:PV1.3.AssignedPatientLocation/MSH:PL.1/MSH:HD.1 = ('AEP','ESA','CES','7E1','7W1','8W','9WWB','9WWM','9WEB','9WEM','10E','10W','11W','12E','12W')</test>
            <local>
                <input path="$ADT_ALL/MSH" var="MSH"/>
                <output path="MSH"/>
                <move>
                    <input path="$MSH/MSH.1.FieldSeparator" var="MSH1FieldSeparator"/>
                    <output path="MSH.1.FieldSeparator"/>
                </move>
                <move>
                    <input path="$MSH/MSH.2.ServiceString" var="MSH2ServiceString"/>
                    <output path="MSH.2.ServiceString"/>
                </move>
                <assign value="MICHART">
                    <output path="MSH.3.SendingApplication/HD.1"/>
                </assign>
                <assign value="MICHART">
                    <output path="MSH.4.SendingFacility/HD.1"/>
                </assign>
                <assign value="WBI">
                    <output path="MSH.5.ReceivingApplication/HD.1"/>
                </assign>
                <assign value="WBI">
                    <output path="MSH.6.ReceivingFacility/HD.1"/>
                </assign>
                <move>
                    <input path="$MSH/MSH.7.DateTimeOfMessage" var="MSH7DateTimeOfMessage"/>
                    <output path="MSH.7.DateTimeOfMessage"/>
                </move>
                <move>
                    <input path="$MSH/MSH.9.MessageType/MSG.1" var="MSG1"/>
                    <output path="MSH.9.MessageType/MSG.1"/>
                </move>
                <move>
                    <input path="$MSH/MSH.9.MessageType/MSG.2" var="MSG2"/>
                    <output path="MSH.9.MessageType/MSG.2"/>
                </move>
                <move>
                    <input path="$MSH/MSH.10.MessageControlID" var="MSH10MessageControlID"/>
                    <output path="MSH.10.MessageControlID"/>
                </move>
                <move>
                    <input path="$MSH/MSH.11.ProcessingID/PT.1" var="PT1"/>
                    <output path="MSH.11.ProcessingID/PT.1"/>
                </move>
                <move>
                    <input path="$MSH/MSH.12.VersionID" var="MSH12VersionID"/>
                    <output path="MSH.12.VersionID"/>
                </move>
            </local>
            <local>
                <input path="$ADT_ALL/EVN" var="EVN"/>
                <output path="EVN"/>
                <function ref="fn:substring">
                    <input path="$EVN/EVN.1.EventTypeCode" var="EVN1EventTypeCode"/>
                    <output path="EVN.1.EventTypeCode"/>
                    <param name="sourceString" value="$EVN1EventTypeCode"/>
                    <param name="startLocation" value="1"/>
                    <param name="length" value="3"/>
                </function>
                <move>
                    <input path="$EVN/EVN.2.RecordedDateTime" var="EVN2RecordedDateTime"/>
                    <output path="EVN.2.RecordedDateTime"/>
                </move>
                <move>
                    <input path="$EVN/EVN.3.DateTimePlannedEvent" var="EVN3DateTimePlannedEvent"/>
                    <output path="EVN.3.DateTimePlannedEvent"/>
                </move>
                <foreach>
                    <input path="$EVN/EVN.5.OperatorID[1]" var="EVN5OperatorID"/>
                    <output path="EVN.5.OperatorID"/>
                    <move>
                        <input path="$EVN5OperatorID/XCN.1" var="XCN1"/>
                        <output path="XCN.1"/>
                    </move>
                </foreach>
                <function ref="fn:substring">
                    <input path="$EVN/EVN.4.EventReasonCode/CWE.1" var="CWE1"/>
                    <output path="EVN.4.EventReasonCode/CWE.1"/>
                    <param name="sourceString" value="$CWE1"/>
                    <param name="startLocation" value="1"/>
                    <param name="length" value="4"/>
                </function>
            </local>
            <local>
                <input path="$ADT_ALL/PID" var="PID"/>
                <output path="PID"/>
                <foreach>
                    <input path="$PID/PID.3.PatientIdentifierList" var="PID3PatientIdentifierList"/>
                    <output path="PID.3.PatientIdentifierList"/>
                    <filter lang="xpath">$PID3PatientIdentifierList/MSH:CX.5 = 'MRN'</filter>
                    <move>
                        <input path="$PID3PatientIdentifierList/CX.1" var="CX1"/>
                        <output path="CX.1"/>
                    </move>
                </foreach>
                <move>
                    <input path="$PID/PID.5.PatientName" var="PID5PatientName"/>
                    <output path="PID.5.PatientName"/>
                </move>
                <move>
                    <input path="$PID/PID.7.DateTimeOfBirth" var="PID7DateTimeOfBirth"/>
                    <output path="PID.7.DateTimeOfBirth"/>
                </move>
                <move>
                    <input path="$PID/PID.8.AdministrativeSex" var="PID8AdministrativeSex"/>
                    <output path="PID.8.AdministrativeSex"/>
                </move>
                <move>
                    <input path="$PID/PID.11.PatientAddress" var="PID11PatientAddress"/>
                    <output path="PID.11.PatientAddress"/>
                </move>
                <move>
                    <input path="$PID/PID.13.PhoneNumberHome" var="PID13PhoneNumberHome"/>
                    <output path="PID.13.PhoneNumberHome"/>
                </move>
                <move>
                    <input path="$PID/PID.14.PhoneNumberBusiness" var="PID14PhoneNumberBusiness"/>
                    <output path="PID.14.PhoneNumberBusiness"/>
                </move>
                <move>
                    <input path="$PID/PID.15.PrimaryLanguage" var="PID15PrimaryLanguage"/>
                    <output path="PID.15.PrimaryLanguage"/>
                </move>
                <move>
                    <input path="$PID/PID.16.MaritalStatus" var="PID16MaritalStatus"/>
                    <output path="PID.16.MaritalStatus"/>
                </move>
                <move>
                    <input path="$PID/PID.29.PatientDeathDateandTime" var="PID29PatientDeathDateandTime"/>
                    <output path="PID.29.PatientDeathDateandTime"/>
                </move>
                <move>
                    <input path="$PID/PID.30.PatientDeathIndicator" var="PID30PatientDeathIndicator"/>
                    <output path="PID.30.PatientDeathIndicator"/>
                </move>
            </local>
            <local>
                <input path="$ADT_ALL/PV1" var="PV1"/>
                <output path="PV1"/>
                <move>
                    <input path="$PV1/PV1.2.PatientClass" var="PV12PatientClass"/>
                    <output path="PV1.2.PatientClass"/>
                </move>
                <move>
                    <input path="$PV1/PV1.3.AssignedPatientLocation" var="PV13AssignedPatientLocation"/>
                    <output path="PV1.3.AssignedPatientLocation"/>
                </move>
            </local>
            <local>
                <input path="$ADT_ALL/PV2" var="PV2"/>
                <output path="PV2"/>
                <test lang="xpath">$PV2/MSH:PV2.7.VisitUserCode != ''</test>
                <move>
                    <input path="$PV2/PV2.7.VisitUserCode" var="PV27VisitUserCode"/>
                    <output path="PV2.7.VisitUserCode"/>
                </move>
            </local>
            <local>
                <input path="$ADT_ALL/MRG" var="MRG"/>
                <output path="MRG"/>
                <move>
                    <input path="$MRG/MRG.1.PriorPatientIdentifierList" var="MRG1PriorPatientIdentifierList"/>
                    <output path="MRG.1.PriorPatientIdentifierList"/>
                </move>
            </local>
        </if>
    </mappingDeclaration>
</mappingRoot>`;

const MAP_XML_HEADER = (name) => `<?xml version="1.0" encoding="UTF-8"?><mappingRoot xmlns="http://www.ibm.com/2008/ccl/Mapping" domainID="com.ibm.msl.mapping.xml" domainIDExtension="mb" mainMap="true" targetNamespace="default" version="8.0.5.0" xmlns:map="default">
    <input path="mbsharedlib://HL7v27ADTSharedLibrary/chapter3.xsd"/>
    <output path="mbsharedlib://HL7v27ADTSharedLibrary/chapter3.xsd"/>
    <namespaces>
        <namespace kind="supplement" prefix="MSH" uri="urn:hl7-org:v2xml"/>
        <namespace kind="extension" prefix="fn" uri="http://www.w3.org/2005/xpath-functions"/>
    </namespaces>
    <generation engine="xquery"/>
    <mappingDeclaration name="${name}">
        <input namespace="urn:hl7-org:v2xml" path="mb:msg(ADT_ALL,assembly,DFDL,Properties)" var="MessageAssembly"/>
        <output namespace="urn:hl7-org:v2xml" path="mb:msg(ADT_ALL,assembly,DFDL,Properties)" var="MessageAssembly1"/>
        <move>
            <input path="$MessageAssembly/Properties"/>
            <output path="$MessageAssembly1/Properties"/>
            <override>
                <assign value="{HL7v27ADTSharedLibrary}">
                    <output path="$MessageAssembly1/Properties/MessageSet"/>
                </assign>
                <assign value="{urn:hl7-org:v2xml}:ADT_ALL">
                    <output path="$MessageAssembly1/Properties/MessageType"/>
                </assign>
            </override>
        </move>
`;

const MAP_XML_FOOTER = `    </mappingDeclaration>
</mappingRoot>`;

// Builds the prompt asking Claude to generate only the per-segment field
// logic (everything that goes between MAP_XML_HEADER and MAP_XML_FOOTER),
// grouped by HL7 segment, using SAMPLE_MAP_XML as a few-shot style guide.
function buildMapPrompt(mapData) {
  const active = mapData.mappings.filter((m) => m.rule.type !== "Not Mapped");
  const groups = {};
  active.forEach((m) => {
    const t = parseWtxFieldPath(m.target);
    const seg = (t.path.split(".")[0] || "OTHER").toUpperCase();
    (groups[seg] = groups[seg] || []).push({ ...m, targetPath: t.path, targetCard: t.card });
  });

  const segmentBlocks = Object.entries(groups).map(([seg, fields]) => {
    const lines = fields.map((f) => {
      const parts = [`target="${f.targetPath}"`, `card="${f.targetCard || "1"}"`, `source="${f.source}"`, `type=${f.rule.type}`];
      if (f.rule.constant) parts.push(`constant=${f.rule.constant}`);
      if (f.rule.expr) parts.push(`expr=${f.rule.expr}`);
      if (f.rule.condition) parts.push(`condition=${f.rule.condition}`);
      return "  - " + parts.join(" | ");
    }).join("\n");
    return `Segment ${seg} (${fields.length} fields):\n${lines}`;
  }).join("\n\n");

  return `You are an IBM ACE/Integration Bus "Graphical Data Mapping" (.map) developer. Generate the field-mapping body of a .map XML document (IBM's mapping editor XQuery-domain format, xmlns="http://www.ibm.com/2008/ccl/Mapping").

Below is a REAL, hand-built reference .map file for a different flow in the same HL7 v2.7 ADT message family — study its exact tag usage, attribute names, variable-naming convention, and namespace prefix usage (the "MSH:" prefix supplements elements that live in the "urn:hl7-org:v2xml" namespace; "fn:" prefixes XPath function extensions):

--- REFERENCE SAMPLE START ---
${SAMPLE_MAP_XML}
--- REFERENCE SAMPLE END ---

Now generate the equivalent body for a NEW mapping named "${mapData.mapName}", using these field mappings grouped by HL7 segment:

${segmentBlocks}

Rules for what to emit:
- Wrap everything in ONE top-level element that declares the ADT_ALL input/output vars, exactly like the reference sample's <if> element does: <input path="$MessageAssembly/ADT_ALL" var="ADT_ALL"/> and <output path="$MessageAssembly1/ADT_ALL"/>. If none of the source fields imply an overall trigger-event/location business condition, use a <local> element instead of <if> (omit the <test> element entirely) — do not invent a fake business condition just to match the sample.
- Inside that, emit one <local> block per HL7 segment (input path="$ADT_ALL/<SEG>" var="<SEG>", output path="<SEG>"), in the same style as the sample's MSH/EVN/PID/PV1/PV2/MRG locals.
- For each field of type "Direct Map": emit a <move> with <input>/<output>, using a var name that concatenates the segment + field number + field name exactly like the sample (e.g. PID5PatientName, MSH1FieldSeparator).
- For each field of type "Constant": emit <assign value="CONSTANT_VALUE"><output path="..."/></assign>, with value set to the constant text itself (no surrounding quotes).
- For each field of type "Conditional": emit an <if> nested inside the segment's <local>, with a <test lang="xpath"> that best-effort translates the WTX condition text into an XPath boolean expression referencing the segment variable (e.g. $PID/...), and a <move> or <assign> inside for the actual field value.
- For each field of type "Member Lookup", "Extract", "Expression", or "Sub-Map Call": emit a <move> as a best-effort direct copy, but add an XML comment immediately before it like <!-- TODO: rule type was "Extract" — verify against source expression: <original expression text> -->.
- If a target field's cardinality looks like a repeating list (card other than "1", or the field name ends in "List"), wrap it in <foreach> like the sample's PID.3.PatientIdentifierList example (only add a <filter lang="xpath"> if the source data implies a specific identifier-type filter — otherwise omit the filter).
- Never invent fields, segments, or business rules not present in the data above.

Output ONLY the raw XML for that one top-level element (the <if> or <local> block and everything nested inside it) — no markdown code fences, no XML declaration, no surrounding <mappingDeclaration> or <mappingRoot> tags, no commentary before or after.`;
}

// ─── Claude API call ──────────────────────────────────────────────────────────
async function streamClaudeResponse(resp, onChunk) {
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
  return streamClaudeResponse(resp, onChunk);
}

// Multi-turn chat call used by the in-app "Ask about this map" chatbot.
// Keeps a separate system prompt (the serialized mapping data) from the
// visible conversation history, so each turn re-grounds the model in the
// currently-loaded map without re-sending it as a fake user message.
async function callClaudeChat(systemPrompt, messages, onChunk) {
  const resp = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      stream: true,
      system: systemPrompt,
      messages,
    }),
  });
  return streamClaudeResponse(resp, onChunk);
}

// Serializes every mapping in the currently-loaded map into a compact
// system prompt so the chatbot can answer questions grounded only in this
// session's data (no persistence, no cross-session/database lookups).
function buildChatSystemPrompt(mapData) {
  const lines = mapData.mappings.map((m, i) => {
    const r = m.rule || {};
    const parts = [`${i + 1}. target="${m.target}"`, `source="${m.source || ""}"`, `type=${r.type || "Unknown"}`];
    if (r.expr) parts.push(`expr=${r.expr}`);
    if (r.constant) parts.push(`constant=${r.constant}`);
    if (r.condition) parts.push(`condition=${r.condition}`);
    return parts.join(" | ");
  }).join("\n");

  return `You are a helpful assistant answering questions about a single IBM WTX/ITX field mapping that is currently loaded in this session. Answer ONLY using the mapping data below — never invent fields, sources, or rules that aren't listed, and never reference any other map or session.

Map name: ${mapData.mapName || "Unknown"}
Source schema: ${mapData.sourceSchema || "Unknown"}
File: ${mapData.fileName || "Unknown"}
Total mappings: ${mapData.mappings.length}

Each line below is one field mapping rule (1-indexed):
${lines}

When answering:
- Reference exact target/source field names from the data above.
- If asked "how many" or "which fields", count or list precisely from the data — don't estimate.
- If something isn't present in the data, say so plainly instead of guessing.
- Keep answers concise and specific. Plain text only, no markdown headers.`;
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

  // ACE Graphical Mapping (.map) output — separate from ESQL, its own
  // generation state, and its own tab in the output panel.
  const [mapXml, setMapXml] = useState("");
  const [mapGenerating, setMapGenerating] = useState(false);
  const [mapProgress, setMapProgress] = useState(0);
  const [activeOutputTab, setActiveOutputTab] = useState("esql"); // "esql" | "map"

  // Chatbot state — scoped to the currently loaded map, current session only.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatScrollRef = useRef(null);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, chatOpen]);

  const sendChatMessage = async () => {
    const question = chatInput.trim();
    if (!question || chatLoading || !mapData) return;
    setChatInput("");
    const history = [...chatMessages, { role: "user", content: question }];
    setChatMessages(history);
    setChatLoading(true);
    try {
      const system = buildChatSystemPrompt(mapData);
      await callClaudeChat(system, history, (text) => {
        setChatMessages([...history, { role: "assistant", content: text }]);
      });
    } catch (e) {
      setChatMessages([...history, { role: "assistant", content: `⚠ ${e.message}` }]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleChatKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  };

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

  const generateMapFile = async () => {
    setMapGenerating(true);
    setMapXml("");
    setMapProgress(0);
    try {
      const prompt = buildMapPrompt(mapData);
      let body = "";
      await callClaude(prompt, (text) => {
        body = text;
        setMapProgress(Math.min(90, Math.round((text.length / 3000) * 90)));
      });

      // Blacklist stray boilerplate Claude may add despite instructions not
      // to (markdown fences, a duplicate XML declaration, or a re-stated
      // mappingDeclaration/mappingRoot tag) — blacklist, not whitelist, so
      // any legitimate nested XML line is kept by default. See
      // feedback_blacklist_over_whitelist in memory for why this matters.
      const cleaned = body
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          if (t.startsWith("```")) return false;
          if (/^<\?xml/i.test(t)) return false;
          if (/^<\/?mappingRoot\b/i.test(t)) return false;
          if (/^<\/?mappingDeclaration\b/i.test(t)) return false;
          return true;
        })
        .join("\n");

      const full = MAP_XML_HEADER(mapData.mapName) + cleaned.trim() + "\n" + MAP_XML_FOOTER;

      // Best-effort well-formedness check — warns but still shows the output,
      // since a partial/imperfect map is still useful as a starting point.
      try {
        const doc = new DOMParser().parseFromString(full, "application/xml");
        const perr = doc.querySelector("parsererror");
        if (perr) {
          setError("Generated .map may not be well-formed XML — review before importing into the ACE Toolkit.");
        }
      } catch {}

      setMapXml(full);
      setMapProgress(100);
      setActiveOutputTab("map");
    } catch (e) {
      setError(e.message);
    } finally {
      setMapGenerating(false);
    }
  };

  const openMappingSpec = () => {
    if (!mapData) return;
    const html = buildMappingSpecHtml(mapData);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  };

  const activeOutputContent = activeOutputTab === "map" ? mapXml : esql;
  const copy = () => navigator.clipboard.writeText(activeOutputContent);
  const download = () => {
    const ext = activeOutputTab === "map" ? ".map" : ".esql";
    const blob = new Blob([activeOutputContent], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (mapData?.mapName || "mapping") + ext;
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
                {stage === "generating" || mapGenerating ? (
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
                        width: `${mapGenerating ? mapProgress : progress}%`,
                        background: `linear-gradient(90deg, ${COLORS.accent}, #a78bfa)`,
                        transition: "width 0.3s ease",
                        borderRadius: 2,
                      }} />
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.muted, textAlign: "center" }}>
                      {mapGenerating ? `Generating .map… ${mapProgress}%` : `Generating ESQL… ${progress}%`}
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
                      minWidth: 140,
                    }}>
                      {stage === "done" ? "↺ Regenerate ESQL" : "⚡ Generate ACE ESQL"}
                    </button>
                    <button onClick={generateMapFile} title="Generate an IBM ACE Graphical Data Mapping (.map) XML file" style={{
                      flex: 1,
                      background: "transparent",
                      border: `1px solid ${COLORS.accentDim}`,
                      borderRadius: 8,
                      padding: "11px 0",
                      color: COLORS.accent,
                      fontWeight: 700,
                      fontSize: 14,
                      cursor: "pointer",
                      letterSpacing: "-0.01em",
                      minWidth: 140,
                    }}>
                      {mapXml ? "↺ Regenerate .map" : "🗺 Generate .map"}
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
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={() => setActiveOutputTab("esql")} style={{
                  background: activeOutputTab === "esql" ? COLORS.accentDim + "50" : "transparent",
                  border: `1px solid ${activeOutputTab === "esql" ? COLORS.accent : COLORS.border}`,
                  color: activeOutputTab === "esql" ? COLORS.accent : COLORS.muted,
                  borderRadius: 6,
                  padding: "4px 10px",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  letterSpacing: "0.04em",
                }}>ESQL</button>
                <button onClick={() => mapXml && setActiveOutputTab("map")} disabled={!mapXml} style={{
                  background: activeOutputTab === "map" ? COLORS.accentDim + "50" : "transparent",
                  border: `1px solid ${activeOutputTab === "map" ? COLORS.accent : COLORS.border}`,
                  color: !mapXml ? COLORS.muted + "80" : activeOutputTab === "map" ? COLORS.accent : COLORS.muted,
                  borderRadius: 6,
                  padding: "4px 10px",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: mapXml ? "pointer" : "default",
                  letterSpacing: "0.04em",
                }}>.MAP</button>
              </div>
              {activeOutputContent && (
                <>
                  <span style={{ fontSize: 11, color: COLORS.muted, marginLeft: 4 }}>
                    {activeOutputContent.split("\n").length} lines
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
                    }}>↓ {activeOutputTab === "map" ? ".map" : ".esql"}</button>
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
              {!activeOutputContent && !(stage === "generating" || mapGenerating) && (
                <div style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                  color: COLORS.muted,
                }}>
                  <div style={{ fontSize: 36 }}>{activeOutputTab === "map" ? "🗺" : "⚡"}</div>
                  <div style={{ fontSize: 14 }}>
                    {activeOutputTab === "map" ? 'Click "Generate .map" to start' : 'Click "Generate ACE ESQL" to start'}
                  </div>
                  <div style={{ fontSize: 12, textAlign: "center", maxWidth: 340, lineHeight: 1.6 }}>
                    {activeOutputTab === "map"
                      ? `The AI agent will convert all ${activeMappings.length} active WTX rules into an IBM ACE Graphical Data Mapping (.map) XML file`
                      : `The AI agent will convert all ${activeMappings.length} active WTX rules into an IBM ACE ESQL DFDL Compute node module`}
                  </div>
                </div>
              )}
              {activeOutputContent && activeOutputTab === "esql" && (
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
              {activeOutputContent && activeOutputTab === "map" && (
                <pre style={{
                  margin: 0,
                  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
                  fontSize: 12,
                  lineHeight: 1.65,
                  color: "#e2e8f0",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>
                  {mapXml}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Chatbot — floating toggle + drawer, available once a map is loaded */}
      {mapData && !chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          title="Ask about this map"
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            width: 52,
            height: 52,
            borderRadius: "50%",
            background: `linear-gradient(135deg, ${COLORS.accent}, #a78bfa)`,
            border: "none",
            color: "#fff",
            fontSize: 22,
            cursor: "pointer",
            boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
            zIndex: 200,
          }}
        >💬</button>
      )}

      {mapData && chatOpen && (
        <div style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          width: 380,
          height: 520,
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 12,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
          zIndex: 200,
        }}>
          {/* Chat header */}
          <div style={{
            padding: "12px 14px",
            borderBottom: `1px solid ${COLORS.border}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}>
            <span style={{ fontSize: 16 }}>💬</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Ask about this map</div>
              <div style={{ fontSize: 10, color: COLORS.muted }}>{mapData.mapName} · session only</div>
            </div>
            <button onClick={() => setChatOpen(false)} style={{
              background: "none", border: "none", color: COLORS.muted,
              cursor: "pointer", fontSize: 18, lineHeight: 1,
            }}>×</button>
          </div>

          {/* Messages */}
          <div ref={chatScrollRef} style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            {chatMessages.length === 0 && (
              <div style={{ color: COLORS.muted, fontSize: 12, lineHeight: 1.6 }}>
                Ask anything about the {mapData.mappings.length} fields in this map — e.g.
                "What maps to PID.PatientIDInternalID?" or "Which fields are constants?"
              </div>
            )}
            {chatMessages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                background: m.role === "user" ? COLORS.accentDim + "60" : COLORS.code,
                border: `1px solid ${m.role === "user" ? COLORS.accentDim : COLORS.border}`,
                borderRadius: 10,
                padding: "8px 11px",
                fontSize: 12.5,
                lineHeight: 1.55,
                color: COLORS.text,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}>
                {m.content || (chatLoading && i === chatMessages.length - 1 ? "…" : "")}
              </div>
            ))}
          </div>

          {/* Input */}
          <div style={{ padding: 10, borderTop: `1px solid ${COLORS.border}`, display: "flex", gap: 8 }}>
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={handleChatKeyDown}
              placeholder="Ask about a field, source, or rule…"
              rows={1}
              style={{
                flex: 1,
                resize: "none",
                background: COLORS.code,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 8,
                padding: "8px 10px",
                color: COLORS.text,
                fontSize: 12.5,
                fontFamily: "inherit",
              }}
            />
            <button
              onClick={sendChatMessage}
              disabled={chatLoading || !chatInput.trim()}
              style={{
                background: chatLoading || !chatInput.trim() ? COLORS.border : COLORS.accent,
                border: "none",
                borderRadius: 8,
                padding: "0 14px",
                color: "#fff",
                fontWeight: 700,
                fontSize: 13,
                cursor: chatLoading || !chatInput.trim() ? "default" : "pointer",
              }}
            >↑</button>
          </div>
        </div>
      )}

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

      {/* Miracle Logo Header */}
      <header style={{
        background: 'linear-gradient(135deg, #1d4ed8 0%, #1e40af 100%)',
        padding: '14px 32px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        boxShadow: '0 2px 8px rgba(29,78,216,0.25)',
        flexShrink: 0,
      }}>
        <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
          <div style={{
            width: '36px', height: '36px', borderRadius: '8px',
            background: '#ffffff', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontWeight: '800', fontSize: '18px',
            color: '#1d4ed8', letterSpacing: '-1px',
          }}>M</div>
          <span style={{color: '#ffffff', fontSize: '20px', fontWeight: '700', letterSpacing: '-0.3px'}}>miracle</span>
        </div>
        <div style={{width: '1px', height: '24px', background: 'rgba(255,255,255,0.3)'}}></div>
        <span style={{color: 'rgba(255,255,255,0.85)', fontSize: '14px', fontWeight: '400'}}>ITX → ACE Migration Agent</span>
      </header>
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
import { useState, useCallback, useRef, useEffect } from "react";
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


// ─── ACE Graphical Mapping (.map) generation ─────────────────────────────────
// Reference sample supplied by the user (MFP_MICHART_PACEART.map) — a real,
// hand-built .map for the same HL7 v2.7 ADT message family. Used as a
// structural/style exemplar in the generation prompt below (few-shot), and
// its boilerplate header/footer (everything outside the per-segment field
// logic) is reused verbatim so the outer envelope is always well-formed,
// mirroring how ESQL generation hardcodes its module wrapper rather than
// asking the model to regenerate boilerplate it might get subtly wrong.
const SAMPLE_MAP_XML = `<?xml version="1.0" encoding="UTF-8"?><mappingRoot xmlns="http://www.ibm.com/2008/ccl/Mapping" domainID="com.ibm.msl.mapping.xml" domainIDExtension="mb" mainMap="true" targetNamespace="default" version="8.0.5.0" xmlns:map="default">
    <input path="mbsharedlib://HL7v27ADTSharedLibrary/chapter3.xsd"/>
    <output path="mbsharedlib://HL7v27ADTSharedLibrary/chapter3.xsd"/>
    <namespaces>
        <namespace kind="supplement" prefix="MSH" uri="urn:hl7-org:v2xml"/>
        <namespace kind="extension" prefix="fn" uri="http://www.w3.org/2005/xpath-functions"/>
    </namespaces>
    <generation engine="xquery"/>
    <mappingDeclaration name="MFP_MICHART_PACEART">
        <input namespace="urn:hl7-org:v2xml" path="mb:msg(ADT_ALL,assembly,DFDL,Properties)" var="MessageAssembly"/>
        <output namespace="urn:hl7-org:v2xml" path="mb:msg(ADT_ALL,assembly,DFDL,Properties)" var="MessageAssembly1"/>
        <move>
            <input path="$MessageAssembly/Properties"/>
            <output path="$MessageAssembly1/Properties"/>
            <override>
                <assign value="{HL7v27ADTSharedLibrary}">
                    <output path="$MessageAssembly1/Properties/MessageSet"/>
                </assign>
                <assign value="{urn:hl7-org:v2xml}:ADT_ALL">
                    <output path="$MessageAssembly1/Properties/MessageType"/>
                </assign>
            </override>
        </move>
        <if>
            <input path="$MessageAssembly/ADT_ALL" var="ADT_ALL"/>
            <output path="$MessageAssembly1/ADT_ALL"/>
            <test lang="xpath">$ADT_ALL/MSH:MSH/MSH:MSH.9.MessageType/MSH:MSG.2 = ('A04', 'A08', 'A28', 'A29', 'A47')&#13;
and $ADT_ALL/MSH:PV1/MSH:PV1.3.AssignedPatientLocation/MSH:PL.1/MSH:HD.1 = ('AEP','ESA','CES','7E1','7W1','8W','9WWB','9WWM','9WEB','9WEM','10E','10W','11W','12E','12W')</test>
            <local>
                <input path="$ADT_ALL/MSH" var="MSH"/>
                <output path="MSH"/>
                <move>
                    <input path="$MSH/MSH.1.FieldSeparator" var="MSH1FieldSeparator"/>
                    <output path="MSH.1.FieldSeparator"/>
                </move>
                <move>
                    <input path="$MSH/MSH.2.ServiceString" var="MSH2ServiceString"/>
                    <output path="MSH.2.ServiceString"/>
                </move>
                <assign value="MICHART">
                    <output path="MSH.3.SendingApplication/HD.1"/>
                </assign>
                <assign value="MICHART">
                    <output path="MSH.4.SendingFacility/HD.1"/>
                </assign>
                <assign value="WBI">
                    <output path="MSH.5.ReceivingApplication/HD.1"/>
                </assign>
                <assign value="WBI">
                    <output path="MSH.6.ReceivingFacility/HD.1"/>
                </assign>
                <move>
                    <input path="$MSH/MSH.7.DateTimeOfMessage" var="MSH7DateTimeOfMessage"/>
                    <output path="MSH.7.DateTimeOfMessage"/>
                </move>
                <move>
                    <input path="$MSH/MSH.9.MessageType/MSG.1" var="MSG1"/>
                    <output path="MSH.9.MessageType/MSG.1"/>
                </move>
                <move>
                    <input path="$MSH/MSH.9.MessageType/MSG.2" var="MSG2"/>
                    <output path="MSH.9.MessageType/MSG.2"/>
                </move>
                <move>
                    <input path="$MSH/MSH.10.MessageControlID" var="MSH10MessageControlID"/>
                    <output path="MSH.10.MessageControlID"/>
                </move>
                <move>
                    <input path="$MSH/MSH.11.ProcessingID/PT.1" var="PT1"/>
                    <output path="MSH.11.ProcessingID/PT.1"/>
                </move>
                <move>
                    <input path="$MSH/MSH.12.VersionID" var="MSH12VersionID"/>
                    <output path="MSH.12.VersionID"/>
                </move>
            </local>
            <local>
                <input path="$ADT_ALL/EVN" var="EVN"/>
                <output path="EVN"/>
                <function ref="fn:substring">
                    <input path="$EVN/EVN.1.EventTypeCode" var="EVN1EventTypeCode"/>
                    <output path="EVN.1.EventTypeCode"/>
                    <param name="sourceString" value="$EVN1EventTypeCode"/>
                    <param name="startLocation" value="1"/>
                    <param name="length" value="3"/>
                </function>
                <move>
                    <input path="$EVN/EVN.2.RecordedDateTime" var="EVN2RecordedDateTime"/>
                    <output path="EVN.2.RecordedDateTime"/>
                </move>
                <move>
                    <input path="$EVN/EVN.3.DateTimePlannedEvent" var="EVN3DateTimePlannedEvent"/>
                    <output path="EVN.3.DateTimePlannedEvent"/>
                </move>
                <foreach>
                    <input path="$EVN/EVN.5.OperatorID[1]" var="EVN5OperatorID"/>
                    <output path="EVN.5.OperatorID"/>
                    <move>
                        <input path="$EVN5OperatorID/XCN.1" var="XCN1"/>
                        <output path="XCN.1"/>
                    </move>
                </foreach>
                <function ref="fn:substring">
                    <input path="$EVN/EVN.4.EventReasonCode/CWE.1" var="CWE1"/>
                    <output path="EVN.4.EventReasonCode/CWE.1"/>
                    <param name="sourceString" value="$CWE1"/>
                    <param name="startLocation" value="1"/>
                    <param name="length" value="4"/>
                </function>
            </local>
            <local>
                <input path="$ADT_ALL/PID" var="PID"/>
                <output path="PID"/>
                <foreach>
                    <input path="$PID/PID.3.PatientIdentifierList" var="PID3PatientIdentifierList"/>
                    <output path="PID.3.PatientIdentifierList"/>
                    <filter lang="xpath">$PID3PatientIdentifierList/MSH:CX.5 = 'MRN'</filter>
                    <move>
                        <input path="$PID3PatientIdentifierList/CX.1" var="CX1"/>
                        <output path="CX.1"/>
                    </move>
                </foreach>
                <move>
                    <input path="$PID/PID.5.PatientName" var="PID5PatientName"/>
                    <output path="PID.5.PatientName"/>
                </move>
                <move>
                    <input path="$PID/PID.7.DateTimeOfBirth" var="PID7DateTimeOfBirth"/>
                    <output path="PID.7.DateTimeOfBirth"/>
                </move>
                <move>
                    <input path="$PID/PID.8.AdministrativeSex" var="PID8AdministrativeSex"/>
                    <output path="PID.8.AdministrativeSex"/>
                </move>
                <move>
                    <input path="$PID/PID.11.PatientAddress" var="PID11PatientAddress"/>
                    <output path="PID.11.PatientAddress"/>
                </move>
                <move>
                    <input path="$PID/PID.13.PhoneNumberHome" var="PID13PhoneNumberHome"/>
                    <output path="PID.13.PhoneNumberHome"/>
                </move>
                <move>
                    <input path="$PID/PID.14.PhoneNumberBusiness" var="PID14PhoneNumberBusiness"/>
                    <output path="PID.14.PhoneNumberBusiness"/>
                </move>
                <move>
                    <input path="$PID/PID.15.PrimaryLanguage" var="PID15PrimaryLanguage"/>
                    <output path="PID.15.PrimaryLanguage"/>
                </move>
                <move>
                    <input path="$PID/PID.16.MaritalStatus" var="PID16MaritalStatus"/>
                    <output path="PID.16.MaritalStatus"/>
                </move>
                <move>
                    <input path="$PID/PID.29.PatientDeathDateandTime" var="PID29PatientDeathDateandTime"/>
                    <output path="PID.29.PatientDeathDateandTime"/>
                </move>
                <move>
                    <input path="$PID/PID.30.PatientDeathIndicator" var="PID30PatientDeathIndicator"/>
                    <output path="PID.30.PatientDeathIndicator"/>
                </move>
            </local>
            <local>
                <input path="$ADT_ALL/PV1" var="PV1"/>
                <output path="PV1"/>
                <move>
                    <input path="$PV1/PV1.2.PatientClass" var="PV12PatientClass"/>
                    <output path="PV1.2.PatientClass"/>
                </move>
                <move>
                    <input path="$PV1/PV1.3.AssignedPatientLocation" var="PV13AssignedPatientLocation"/>
                    <output path="PV1.3.AssignedPatientLocation"/>
                </move>
            </local>
            <local>
                <input path="$ADT_ALL/PV2" var="PV2"/>
                <output path="PV2"/>
                <test lang="xpath">$PV2/MSH:PV2.7.VisitUserCode != ''</test>
                <move>
                    <input path="$PV2/PV2.7.VisitUserCode" var="PV27VisitUserCode"/>
                    <output path="PV2.7.VisitUserCode"/>
                </move>
            </local>
            <local>
                <input path="$ADT_ALL/MRG" var="MRG"/>
                <output path="MRG"/>
                <move>
                    <input path="$MRG/MRG.1.PriorPatientIdentifierList" var="MRG1PriorPatientIdentifierList"/>
                    <output path="MRG.1.PriorPatientIdentifierList"/>
                </move>
            </local>
        </if>
    </mappingDeclaration>
</mappingRoot>`;

const MAP_XML_HEADER = (name) => `<?xml version="1.0" encoding="UTF-8"?><mappingRoot xmlns="http://www.ibm.com/2008/ccl/Mapping" domainID="com.ibm.msl.mapping.xml" domainIDExtension="mb" mainMap="true" targetNamespace="default" version="8.0.5.0" xmlns:map="default">
    <input path="mbsharedlib://HL7v27ADTSharedLibrary/chapter3.xsd"/>
    <output path="mbsharedlib://HL7v27ADTSharedLibrary/chapter3.xsd"/>
    <namespaces>
        <namespace kind="supplement" prefix="MSH" uri="urn:hl7-org:v2xml"/>
        <namespace kind="extension" prefix="fn" uri="http://www.w3.org/2005/xpath-functions"/>
    </namespaces>
    <generation engine="xquery"/>
    <mappingDeclaration name="${name}">
        <input namespace="urn:hl7-org:v2xml" path="mb:msg(ADT_ALL,assembly,DFDL,Properties)" var="MessageAssembly"/>
        <output namespace="urn:hl7-org:v2xml" path="mb:msg(ADT_ALL,assembly,DFDL,Properties)" var="MessageAssembly1"/>
        <move>
            <input path="$MessageAssembly/Properties"/>
            <output path="$MessageAssembly1/Properties"/>
            <override>
                <assign value="{HL7v27ADTSharedLibrary}">
                    <output path="$MessageAssembly1/Properties/MessageSet"/>
                </assign>
                <assign value="{urn:hl7-org:v2xml}:ADT_ALL">
                    <output path="$MessageAssembly1/Properties/MessageType"/>
                </assign>
            </override>
        </move>
`;

const MAP_XML_FOOTER = `    </mappingDeclaration>
</mappingRoot>`;

// Builds the prompt asking Claude to generate only the per-segment field
// logic (everything that goes between MAP_XML_HEADER and MAP_XML_FOOTER),
// grouped by HL7 segment, using SAMPLE_MAP_XML as a few-shot style guide.
function buildMapPrompt(mapData) {
  const active = mapData.mappings.filter((m) => m.rule.type !== "Not Mapped");
  const groups = {};
  active.forEach((m) => {
    const t = parseWtxFieldPath(m.target);
    const seg = (t.path.split(".")[0] || "OTHER").toUpperCase();
    (groups[seg] = groups[seg] || []).push({ ...m, targetPath: t.path, targetCard: t.card });
  });

  const segmentBlocks = Object.entries(groups).map(([seg, fields]) => {
    const lines = fields.map((f) => {
      const parts = [`target="${f.targetPath}"`, `card="${f.targetCard || "1"}"`, `source="${f.source}"`, `type=${f.rule.type}`];
      if (f.rule.constant) parts.push(`constant=${f.rule.constant}`);
      if (f.rule.expr) parts.push(`expr=${f.rule.expr}`);
      if (f.rule.condition) parts.push(`condition=${f.rule.condition}`);
      return "  - " + parts.join(" | ");
    }).join("\n");
    return `Segment ${seg} (${fields.length} fields):\n${lines}`;
  }).join("\n\n");

  return `You are an IBM ACE/Integration Bus "Graphical Data Mapping" (.map) developer. Generate the field-mapping body of a .map XML document (IBM's mapping editor XQuery-domain format, xmlns="http://www.ibm.com/2008/ccl/Mapping").

Below is a REAL, hand-built reference .map file for a different flow in the same HL7 v2.7 ADT message family — study its exact tag usage, attribute names, variable-naming convention, and namespace prefix usage (the "MSH:" prefix supplements elements that live in the "urn:hl7-org:v2xml" namespace; "fn:" prefixes XPath function extensions):

--- REFERENCE SAMPLE START ---
${SAMPLE_MAP_XML}
--- REFERENCE SAMPLE END ---

Now generate the equivalent body for a NEW mapping named "${mapData.mapName}", using these field mappings grouped by HL7 segment:

${segmentBlocks}

Rules for what to emit:
- Wrap everything in ONE top-level element that declares the ADT_ALL input/output vars, exactly like the reference sample's <if> element does: <input path="$MessageAssembly/ADT_ALL" var="ADT_ALL"/> and <output path="$MessageAssembly1/ADT_ALL"/>. If none of the source fields imply an overall trigger-event/location business condition, use a <local> element instead of <if> (omit the <test> element entirely) — do not invent a fake business condition just to match the sample.
- Inside that, emit one <local> block per HL7 segment (input path="$ADT_ALL/<SEG>" var="<SEG>", output path="<SEG>"), in the same style as the sample's MSH/EVN/PID/PV1/PV2/MRG locals.
- For each field of type "Direct Map": emit a <move> with <input>/<output>, using a var name that concatenates the segment + field number + field name exactly like the sample (e.g. PID5PatientName, MSH1FieldSeparator).
- For each field of type "Constant": emit <assign value="CONSTANT_VALUE"><output path="..."/></assign>, with value set to the constant text itself (no surrounding quotes).
- For each field of type "Conditional": emit an <if> nested inside the segment's <local>, with a <test lang="xpath"> that best-effort translates the WTX condition text into an XPath boolean expression referencing the segment variable (e.g. $PID/...), and a <move> or <assign> inside for the actual field value.
- For each field of type "Member Lookup", "Extract", "Expression", or "Sub-Map Call": emit a <move> as a best-effort direct copy, but add an XML comment immediately before it like <!-- TODO: rule type was "Extract" — verify against source expression: <original expression text> -->.
- If a target field's cardinality looks like a repeating list (card other than "1", or the field name ends in "List"), wrap it in <foreach> like the sample's PID.3.PatientIdentifierList example (only add a <filter lang="xpath"> if the source data implies a specific identifier-type filter — otherwise omit the filter).
- Never invent fields, segments, or business rules not present in the data above.

Output ONLY the raw XML for that one top-level element (the <if> or <local> block and everything nested inside it) — no markdown code fences, no XML declaration, no surrounding <mappingDeclaration> or <mappingRoot> tags, no commentary before or after.`;
}

// ─── Claude API call ──────────────────────────────────────────────────────────
async function streamClaudeResponse(resp, onChunk) {
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
  return streamClaudeResponse(resp, onChunk);
}

// Multi-turn chat call used by the in-app "Ask about this map" chatbot.
// Keeps a separate system prompt (the serialized mapping data) from the
// visible conversation history, so each turn re-grounds the model in the
// currently-loaded map without re-sending it as a fake user message.
async function callClaudeChat(systemPrompt, messages, onChunk) {
  const resp = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      stream: true,
      system: systemPrompt,
      messages,
    }),
  });
  return streamClaudeResponse(resp, onChunk);
}

// Serializes every mapping in the currently-loaded map into a compact
// system prompt so the chatbot can answer questions grounded only in this
// session's data (no persistence, no cross-session/database lookups).
function buildChatSystemPrompt(mapData) {
  const lines = mapData.mappings.map((m, i) => {
    const r = m.rule || {};
    const parts = [`${i + 1}. target="${m.target}"`, `source="${m.source || ""}"`, `type=${r.type || "Unknown"}`];
    if (r.expr) parts.push(`expr=${r.expr}`);
    if (r.constant) parts.push(`constant=${r.constant}`);
    if (r.condition) parts.push(`condition=${r.condition}`);
    return parts.join(" | ");
  }).join("\n");

  return `You are a helpful assistant answering questions about a single IBM WTX/ITX field mapping that is currently loaded in this session. Answer ONLY using the mapping data below — never invent fields, sources, or rules that aren't listed, and never reference any other map or session.

Map name: ${mapData.mapName || "Unknown"}
Source schema: ${mapData.sourceSchema || "Unknown"}
File: ${mapData.fileName || "Unknown"}
Total mappings: ${mapData.mappings.length}

Each line below is one field mapping rule (1-indexed):
${lines}

When answering:
- Reference exact target/source field names from the data above.
- If asked "how many" or "which fields", count or list precisely from the data — don't estimate.
- If something isn't present in the data, say so plainly instead of guessing.
- Keep answers concise and specific. Plain text only, no markdown headers.`;
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

  // ACE Graphical Mapping (.map) output — separate from ESQL, its own
  // generation state, and its own tab in the output panel.
  const [mapXml, setMapXml] = useState("");
  const [mapGenerating, setMapGenerating] = useState(false);
  const [mapProgress, setMapProgress] = useState(0);
  const [activeOutputTab, setActiveOutputTab] = useState("esql"); // "esql" | "map"

  // Chatbot state — scoped to the currently loaded map, current session only.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatScrollRef = useRef(null);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, chatOpen]);

  const sendChatMessage = async () => {
    const question = chatInput.trim();
    if (!question || chatLoading || !mapData) return;
    setChatInput("");
    const history = [...chatMessages, { role: "user", content: question }];
    setChatMessages(history);
    setChatLoading(true);
    try {
      const system = buildChatSystemPrompt(mapData);
      await callClaudeChat(system, history, (text) => {
        setChatMessages([...history, { role: "assistant", content: text }]);
      });
    } catch (e) {
      setChatMessages([...history, { role: "assistant", content: `⚠ ${e.message}` }]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleChatKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  };

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

  const generateMapFile = async () => {
    setMapGenerating(true);
    setMapXml("");
    setMapProgress(0);
    try {
      const prompt = buildMapPrompt(mapData);
      let body = "";
      await callClaude(prompt, (text) => {
        body = text;
        setMapProgress(Math.min(90, Math.round((text.length / 3000) * 90)));
      });

      // Blacklist stray boilerplate Claude may add despite instructions not
      // to (markdown fences, a duplicate XML declaration, or a re-stated
      // mappingDeclaration/mappingRoot tag) — blacklist, not whitelist, so
      // any legitimate nested XML line is kept by default. See
      // feedback_blacklist_over_whitelist in memory for why this matters.
      const cleaned = body
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          if (t.startsWith("```")) return false;
          if (/^<\?xml/i.test(t)) return false;
          if (/^<\/?mappingRoot\b/i.test(t)) return false;
          if (/^<\/?mappingDeclaration\b/i.test(t)) return false;
          return true;
        })
        .join("\n");

      const full = MAP_XML_HEADER(mapData.mapName) + cleaned.trim() + "\n" + MAP_XML_FOOTER;

      // Best-effort well-formedness check — warns but still shows the output,
      // since a partial/imperfect map is still useful as a starting point.
      try {
        const doc = new DOMParser().parseFromString(full, "application/xml");
        const perr = doc.querySelector("parsererror");
        if (perr) {
          setError("Generated .map may not be well-formed XML — review before importing into the ACE Toolkit.");
        }
      } catch {}

      setMapXml(full);
      setMapProgress(100);
      setActiveOutputTab("map");
    } catch (e) {
      setError(e.message);
    } finally {
      setMapGenerating(false);
    }
  };

  const openMappingSpec = () => {
    if (!mapData) return;
    const html = buildMappingSpecHtml(mapData);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  };

  const activeOutputContent = activeOutputTab === "map" ? mapXml : esql;
  const copy = () => navigator.clipboard.writeText(activeOutputContent);
  const download = () => {
    const ext = activeOutputTab === "map" ? ".map" : ".esql";
    const blob = new Blob([activeOutputContent], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (mapData?.mapName || "mapping") + ext;
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
                {stage === "generating" || mapGenerating ? (
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
                        width: `${mapGenerating ? mapProgress : progress}%`,
                        background: `linear-gradient(90deg, ${COLORS.accent}, #a78bfa)`,
                        transition: "width 0.3s ease",
                        borderRadius: 2,
                      }} />
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.muted, textAlign: "center" }}>
                      {mapGenerating ? `Generating .map… ${mapProgress}%` : `Generating ESQL… ${progress}%`}
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
                      minWidth: 140,
                    }}>
                      {stage === "done" ? "↺ Regenerate ESQL" : "⚡ Generate ACE ESQL"}
                    </button>
                    <button onClick={generateMapFile} title="Generate an IBM ACE Graphical Data Mapping (.map) XML file" style={{
                      flex: 1,
                      background: "transparent",
                      border: `1px solid ${COLORS.accentDim}`,
                      borderRadius: 8,
                      padding: "11px 0",
                      color: COLORS.accent,
                      fontWeight: 700,
                      fontSize: 14,
                      cursor: "pointer",
                      letterSpacing: "-0.01em",
                      minWidth: 140,
                    }}>
                      {mapXml ? "↺ Regenerate .map" : "🗺 Generate .map"}
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
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={() => setActiveOutputTab("esql")} style={{
                  background: activeOutputTab === "esql" ? COLORS.accentDim + "50" : "transparent",
                  border: `1px solid ${activeOutputTab === "esql" ? COLORS.accent : COLORS.border}`,
                  color: activeOutputTab === "esql" ? COLORS.accent : COLORS.muted,
                  borderRadius: 6,
                  padding: "4px 10px",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  letterSpacing: "0.04em",
                }}>ESQL</button>
                <button onClick={() => mapXml && setActiveOutputTab("map")} disabled={!mapXml} style={{
                  background: activeOutputTab === "map" ? COLORS.accentDim + "50" : "transparent",
                  border: `1px solid ${activeOutputTab === "map" ? COLORS.accent : COLORS.border}`,
                  color: !mapXml ? COLORS.muted + "80" : activeOutputTab === "map" ? COLORS.accent : COLORS.muted,
                  borderRadius: 6,
                  padding: "4px 10px",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: mapXml ? "pointer" : "default",
                  letterSpacing: "0.04em",
                }}>.MAP</button>
              </div>
              {activeOutputContent && (
                <>
                  <span style={{ fontSize: 11, color: COLORS.muted, marginLeft: 4 }}>
                    {activeOutputContent.split("\n").length} lines
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
                    }}>↓ {activeOutputTab === "map" ? ".map" : ".esql"}</button>
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
              {!activeOutputContent && !(stage === "generating" || mapGenerating) && (
                <div style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                  color: COLORS.muted,
                }}>
                  <div style={{ fontSize: 36 }}>{activeOutputTab === "map" ? "🗺" : "⚡"}</div>
                  <div style={{ fontSize: 14 }}>
                    {activeOutputTab === "map" ? 'Click "Generate .map" to start' : 'Click "Generate ACE ESQL" to start'}
                  </div>
                  <div style={{ fontSize: 12, textAlign: "center", maxWidth: 340, lineHeight: 1.6 }}>
                    {activeOutputTab === "map"
                      ? `The AI agent will convert all ${activeMappings.length} active WTX rules into an IBM ACE Graphical Data Mapping (.map) XML file`
                      : `The AI agent will convert all ${activeMappings.length} active WTX rules into an IBM ACE ESQL DFDL Compute node module`}
                  </div>
                </div>
              )}
              {activeOutputContent && activeOutputTab === "esql" && (
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
              {activeOutputContent && activeOutputTab === "map" && (
                <pre style={{
                  margin: 0,
                  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
                  fontSize: 12,
                  lineHeight: 1.65,
                  color: "#e2e8f0",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>
                  {mapXml}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Chatbot — floating toggle + drawer, available once a map is loaded */}
      {mapData && !chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          title="Ask about this map"
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            width: 52,
            height: 52,
            borderRadius: "50%",
            background: `linear-gradient(135deg, ${COLORS.accent}, #a78bfa)`,
            border: "none",
            color: "#fff",
            fontSize: 22,
            cursor: "pointer",
            boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
            zIndex: 200,
          }}
        >💬</button>
      )}

      {mapData && chatOpen && (
        <div style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          width: 380,
          height: 520,
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 12,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
          zIndex: 200,
        }}>
          {/* Chat header */}
          <div style={{
            padding: "12px 14px",
            borderBottom: `1px solid ${COLORS.border}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}>
            <span style={{ fontSize: 16 }}>💬</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Ask about this map</div>
              <div style={{ fontSize: 10, color: COLORS.muted }}>{mapData.mapName} · session only</div>
            </div>
            <button onClick={() => setChatOpen(false)} style={{
              background: "none", border: "none", color: COLORS.muted,
              cursor: "pointer", fontSize: 18, lineHeight: 1,
            }}>×</button>
          </div>

          {/* Messages */}
          <div ref={chatScrollRef} style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            {chatMessages.length === 0 && (
              <div style={{ color: COLORS.muted, fontSize: 12, lineHeight: 1.6 }}>
                Ask anything about the {mapData.mappings.length} fields in this map — e.g.
                "What maps to PID.PatientIDInternalID?" or "Which fields are constants?"
              </div>
            )}
            {chatMessages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                background: m.role === "user" ? COLORS.accentDim + "60" : COLORS.code,
                border: `1px solid ${m.role === "user" ? COLORS.accentDim : COLORS.border}`,
                borderRadius: 10,
                padding: "8px 11px",
                fontSize: 12.5,
                lineHeight: 1.55,
                color: COLORS.text,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}>
                {m.content || (chatLoading && i === chatMessages.length - 1 ? "…" : "")}
              </div>
            ))}
          </div>

          {/* Input */}
          <div style={{ padding: 10, borderTop: `1px solid ${COLORS.border}`, display: "flex", gap: 8 }}>
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={handleChatKeyDown}
              placeholder="Ask about a field, source, or rule…"
              rows={1}
              style={{
                flex: 1,
                resize: "none",
                background: COLORS.code,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 8,
                padding: "8px 10px",
                color: COLORS.text,
                fontSize: 12.5,
                fontFamily: "inherit",
              }}
            />
            <button
              onClick={sendChatMessage}
              disabled={chatLoading || !chatInput.trim()}
              style={{
                background: chatLoading || !chatInput.trim() ? COLORS.border : COLORS.accent,
                border: "none",
                borderRadius: 8,
                padding: "0 14px",
                color: "#fff",
                fontWeight: 700,
                fontSize: 13,
                cursor: chatLoading || !chatInput.trim() ? "default" : "pointer",
              }}
            >↑</button>
          </div>
        </div>
      )}

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
