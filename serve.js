const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json',
};

function serveSPA(baseDir, port) {
  http.createServer((req, res) => {
    let file = req.url.split('?')[0];
    if (file === '/') file = '/index.html';
    const fullPath = path.join(baseDir, file);

    fs.readFile(fullPath, (err, data) => {
      if (err || !fs.existsSync(fullPath)) {
        // SPA fallback: serve index.html for any non-file route
        fs.readFile(path.join(baseDir, 'index.html'), (err2, html) => {
          if (err2) { res.writeHead(500); res.end('Server error'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        });
        return;
      }
      const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  }).listen(port, '0.0.0.0', () => {
    console.log(`Serving ${baseDir} on port ${port}`);
  });
}

serveSPA(path.join(__dirname, 'web-client/dist'), 5173);
