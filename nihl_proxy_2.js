// NIHL API Proxy — Node.js (no dependencies)
// Run: node nihl_proxy.js
// Exposes: POST http://localhost:3000 (any path accepted)

const http = require("http");
const https = require("https");

const PORT = 3000;
const NEOTA_HOST = "rc-eucs.neotalogic.com";
const NEOTA_PATH = "/a/7333?japi=true";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

http.createServer((req, res) => {
  console.log(req.method, req.url);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      console.log("→ Neota:", body.slice(0, 200));
      const opts = {
        hostname: NEOTA_HOST,
        path: NEOTA_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      };
      const proxy = https.request(opts, nr => {
        let data = "";
        nr.on("data", c => data += c);
        nr.on("end", () => {
          console.log("← Neota", nr.statusCode, ":", data.slice(0, 200));
          res.writeHead(nr.statusCode, CORS);
          res.end(data);
        });
      });
      proxy.on("error", e => {
        console.error("Neota error:", e.message);
        res.writeHead(502, CORS);
        res.end(JSON.stringify({ error: "Upstream error: " + e.message }));
      });
      proxy.write(body);
      proxy.end();
    });
    return;
  }

  res.writeHead(405, CORS);
  res.end(JSON.stringify({ error: "Use POST" }));

}).listen(PORT, () => {
  console.log("NIHL proxy running → http://localhost:" + PORT);
  console.log("Forwarding all POST → https://" + NEOTA_HOST + NEOTA_PATH);
});
