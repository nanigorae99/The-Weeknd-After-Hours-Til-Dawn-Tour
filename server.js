import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const DEFAULT_FILE_ID = '1znibvThdmYSJirzZbKHM82Zetvsg_u1D';

let cachedDriveStreamUrl = null;
let driveUrlExpiry = 0;
let cachedFileId = null;

async function getDriveStreamUrl(fileId) {
  if (cachedDriveStreamUrl && cachedFileId === fileId && Date.now() < driveUrlExpiry) {
    return cachedDriveStreamUrl;
  }
  const initUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  const res = await fetch(initUrl, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (location) {
    cachedDriveStreamUrl = location;
    cachedFileId = fileId;
    driveUrlExpiry = Date.now() + 15 * 60 * 1000; // 15 mins cache
    return location;
  }
  return initUrl;
}

// Robust audio streaming proxy for Google Drive
app.get('/api/audio', async (req, res) => {
  try {
    const fileId = req.query.id || DEFAULT_FILE_ID;
    let targetUrl;
    try {
      targetUrl = await getDriveStreamUrl(fileId);
    } catch {
      targetUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
    }

    const headers = {};
    if (req.headers.range) {
      headers['range'] = req.headers.range;
    }

    let upstream = await fetch(targetUrl, { headers });

    // In case Google Drive token expired (403), re-resolve location
    if (upstream.status === 403 || upstream.status === 404) {
      cachedDriveStreamUrl = null;
      targetUrl = await getDriveStreamUrl(fileId);
      upstream = await fetch(targetUrl, { headers });
    }

    res.status(upstream.status);

    const passHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
      'last-modified',
      'etag'
    ];
    for (const h of passHeaders) {
      const val = upstream.headers.get(h);
      if (val) res.setHeader(h, val);
    }
    if (!res.getHeader('accept-ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }
    if (!res.getHeader('content-type')) {
      res.setHeader('Content-Type', 'audio/mpeg');
    }

    if (!upstream.body) {
      return res.end();
    }

    const { Readable } = await import('stream');
    const nodeStream = Readable.fromWeb(upstream.body);

    req.on('close', () => {
      try {
        nodeStream.destroy();
      } catch {}
    });

    nodeStream.pipe(res);
  } catch (err) {
    console.error('Audio stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Audio stream failed' });
    }
  }
});

// Serve static assets from root
app.use(express.static(__dirname));

// Route all other requests to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
