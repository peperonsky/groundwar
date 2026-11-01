const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath.endsWith("/")) urlPath += "index.html";
  let p = path.join(root, urlPath);
  fs.readFile(p, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found: " + p);
      return;
    }
    const ext = path.extname(p);
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Content-Length": data.length });
    res.end(data);
  });
}).listen(8746, () => console.log("ready on 8746, serving", root));
