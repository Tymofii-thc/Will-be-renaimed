// Minimal demo service. Change the VERSION string to produce a different image.
const http = require("http");
const VERSION = process.env.APP_VERSION || "1.0.0";

http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "demo-app", version: VERSION }));
  })
  .listen(3000, () => console.log(`demo-app ${VERSION} listening on :3000`));
