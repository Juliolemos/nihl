// NIHL MCP Server — exposes the Neota NIHL rules engine as an MCP tool.
// Deploy on Render. Add to Claude as a custom connector:
//   https://<your-app>.onrender.com/mcp
//
// Run locally:  npm install && npm start

import express from "express";
import https from "https";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = process.env.PORT || 3000;
const NEOTA_HOST = "rc-eucs.neotalogic.com";
const NEOTA_PATH = "/a/7333?japi=true";

// ---------- Neota call ----------
function neotaRequest(inputs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ inputs, outputs: ["incomplete", "report", "root"] });
    const req = https.request(
      {
        hostname: NEOTA_HOST,
        path: NEOTA_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Neota returned non-JSON: " + data.slice(0, 120)));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------- Tool input schema ----------
const ynu = z
  .enum(["true", "false", ""])
  .describe("'true', 'false', or '' if unknown");

const nihlInputs = {
  occupation: ynu.describe("Occupation in a noisy environment established — 'true'/'false'/''"),
  workingperiod: ynu.describe("Working period with the noisy employer established — 'true'/'false'/''"),
  noiseimmissionlevelc: ynu.describe("Noise level above legal threshold (85dB+) — 'true'/'false'/''"),
  noiseduration: ynu.describe("Noise exposure duration sufficient (regular, >1h) — 'true'/'false'/''"),
  noisestatus: ynu.describe("Noise type established (continuous/fluctuating/intermittent/impulsive) — 'true'/'false'/''"),
  typeofhearingloss: ynu.describe("Sensorineural hearing loss confirmed by audiology — 'true'/'false'/''"),
  practicaldamages: ynu.describe("Hearing loss causes practical disability in daily life — 'true'/'false'/''"),
  employeetoldofrisk: ynu.describe("Employee was informed of noise risks and trained — 'true'/'false'/''"),
  protectionzone: ynu.describe("Employer provided noise protection zones/signs — 'true'/'false'/''"),
  healthsurveillance: ynu.describe("Employer provided health/hearing surveillance — 'true'/'false'/''"),
  riskassessment: ynu.describe("Employer conducted a noise risk assessment — 'true'/'false'/''"),
  earprotection: ynu.describe("Adequate ear protection was provided by employer — 'true'/'false'/''"),
  testsubjective: ynu.describe("Subjective test reliability issues present (wax, exaggeration, asymmetry) — 'true'/'false'/''"),
  testobjective: ynu.describe("Objective test reliability issues present (calibration, background noise) — 'true'/'false'/''"),
  frequencydegree: ynu.describe("Audiogram frequency profile consistent with NIHL — 'true'/'false'/''"),
  medicalcauses: ynu.describe("Other medical cause of hearing loss present (Meniere's, ototoxic drugs, infection, etc.) — 'true'/'false'/''"),
  age: ynu.describe("Age-related hearing loss (presbycusis) is a primary factor — 'true'/'false'/''"),
};

// ---------- MCP server factory (stateless: one per request) ----------
function buildServer() {
  const server = new McpServer({
    name: "nihl-rules-engine",
    version: "1.0.0",
  });

  server.tool(
    "check_nihl_case",
    "Calls the deterministic Neota Logic rules engine for UK Noise-Induced Hearing Loss (NIHL) compensation claims. " +
      "This is the ONLY authoritative source for whether a claimant has a case — never determine the outcome without calling this tool. " +
      "Pass every input you have collected ('true'/'false') and '' for anything unknown. " +
      "Returns: root (true = claimant has a case, false = not), incomplete (true = more inputs needed), and report (engine's justification).",
    nihlInputs,
    async (args) => {
      // Fill any omitted fields with ""
      const inputs = {};
      for (const key of Object.keys(nihlInputs)) inputs[key] = args[key] ?? "";

      try {
        const result = await neotaRequest(inputs);
        const root = result.outputs?.root ?? result.root;
        const incomplete = result.outputs?.incomplete ?? result.incomplete;
        const report = result.outputs?.report ?? result.report;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ root, incomplete, report }, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "NIHL rules engine unreachable: " + e.message,
                instruction:
                  "Tell the user the rules engine is unavailable and that no assessment can be given. Do NOT determine the outcome yourself.",
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ---------- HTTP wiring (Streamable HTTP, stateless) ----------
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP error:", e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless server: reject GET/DELETE session calls politely
app.get("/mcp", (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  })
);
app.delete("/mcp", (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  })
);

// Health check for Render
app.get("/", (_req, res) =>
  res.send("NIHL MCP server running. Connect Claude to POST /mcp")
);

app.listen(PORT, () => {
  console.log("NIHL MCP server listening on port " + PORT);
  console.log("MCP endpoint: /mcp");
});
