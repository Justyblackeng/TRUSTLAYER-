// Builds public/mock.html: the REAL page (public/index.html) plus an in-browser fake API.
// Re-run after changing the page so the mock never drifts from the real thing:  npm run build:mock
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const mock = fs.readFileSync(path.join(root, "mock/mock-backend.js"), "utf8");
const out = page
  .replace(/<title>.*?<\/title>/, "<title>TrustLayer (mock)</title>")
  .replace("<script>", () => "<script>\n" + mock + "\n</script>\n<script>"); // inject before the app script
fs.writeFileSync(path.join(root, "public/mock.html"), out);
console.log("Wrote public/mock.html (" + Math.round(out.length / 1024) + " KB)");
