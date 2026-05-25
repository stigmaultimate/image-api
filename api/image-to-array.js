// api/image-to-array.js — CommonJS (sem import)

const sharp = require("sharp");
const { parseGIF, decompressFrames } = require("gifuct-js");

function encodeRLE(pixels, width, height, threshold) {
  const result = {};
  const q = Math.max(1, threshold);

  for (let y = 0; y < height; y++) {
    const row = [];
    let spanLen = 1;
    let spanR, spanG, spanB;

    const getPixel = (x) => {
      const i = (y * width + x) * 4;
      return [
        Math.min(255, Math.round(pixels[i]     / q) * q),
        Math.min(255, Math.round(pixels[i + 1] / q) * q),
        Math.min(255, Math.round(pixels[i + 2] / q) * q),
      ];
    };

    [spanR, spanG, spanB] = getPixel(0);

    for (let x = 1; x < width; x++) {
      const [r, g, b] = getPixel(x);
      if (r === spanR && g === spanG && b === spanB) {
        spanLen++;
      } else {
        row.push([spanLen, spanR, spanG, spanB]);
        spanLen = 1; spanR = r; spanG = g; spanB = b;
      }
    }
    row.push([spanLen, spanR, spanG, spanB]);
    result[y + 1] = row;
  }

  return result;
}

async function processGIF(buffer, size, threshold, fps) {
  const gif = parseGIF(buffer);
  const frames = decompressFrames(gif, true);
  if (!frames || frames.length === 0) throw new Error("GIF sem frames");

  const origWidth  = gif.lsd.width;
  const origHeight = gif.lsd.height;
  const scale  = Math.min(1, size / Math.max(origWidth, origHeight));
  const width  = Math.max(1, Math.round(origWidth  * scale));
  const height = Math.max(1, Math.round(origHeight * scale));

  const pixelFrames = [];
  const durations   = [];
  const canvas = new Uint8ClampedArray(origWidth * origHeight * 4);

  for (const frame of frames) {
    const { pixels: framePx, dims } = frame;
    for (let i = 0; i < dims.height; i++) {
      for (let j = 0; j < dims.width; j++) {
        const srcIdx = (i * dims.width + j) * 4;
        const dstIdx = ((dims.top + i) * origWidth + (dims.left + j)) * 4;
        if (framePx[srcIdx + 3] !== 0) {
          canvas[dstIdx]     = framePx[srcIdx];
          canvas[dstIdx + 1] = framePx[srcIdx + 1];
          canvas[dstIdx + 2] = framePx[srcIdx + 2];
          canvas[dstIdx + 3] = framePx[srcIdx + 3];
        }
      }
    }

    const resized = await sharp(Buffer.from(canvas), {
      raw: { width: origWidth, height: origHeight, channels: 4 },
    }).resize(width, height, { fit: "fill" }).raw().toBuffer();

    pixelFrames.push(encodeRLE(resized, width, height, threshold));
    durations.push((frame.delay || Math.round(100 / fps)) / 100);
  }

  return { pixels: pixelFrames, width, height, animated: true, durations };
}

async function processImage(buffer, size, threshold) {
  const meta = await sharp(buffer).metadata();
  const scale  = Math.min(1, size / Math.max(meta.width, meta.height));
  const width  = Math.max(1, Math.round(meta.width  * scale));
  const height = Math.max(1, Math.round(meta.height * scale));

  const raw = await sharp(buffer)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  return { pixels: encodeRLE(raw, width, height, threshold), width, height, animated: false };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { url, size = 64, persent = 1, animated = true, fps = 24 } = req.body;
    if (!url) return res.status(400).json({ error: "url é obrigatório" });

    const fetch = (await import("node-fetch")).default;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!response.ok) {
      return res.status(400).json({ error: `Falha ao baixar imagem: ${response.status}` });
    }

    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(await response.arrayBuffer());
    const isGif  = animated && (contentType.includes("gif") || url.toLowerCase().endsWith(".gif"));

    const result = isGif
      ? await processGIF(buffer, size, persent, fps)
      : await processImage(buffer, size, persent);

    return res.status(200).json({
      status: "success",
      dimensions: {
        width:     result.width,
        height:    result.height,
        animated:  result.animated,
        durations: result.durations || null,
      },
      pixels: result.pixels,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
