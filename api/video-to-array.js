// api/video-to-array.js — CommonJS

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const crypto = require("crypto");
const sharp  = require("sharp");
const { execSync } = require("child_process");

// ─── RLE encoder ────────────────────────────────────────────────────────────
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

// ─── Frame extractor ─────────────────────────────────────────────────────────
function extractFrames(videoPath, outputFolder, fps, width, height) {
  const ffmpegPath = require("ffmpeg-static");

  console.log("FFMPEG PATH:", ffmpegPath);

  try { execSync(`chmod +x "${ffmpegPath}"`); } catch (_) {}

  // O vídeo tem color range marcado como "tv, reserved" no metadata,
  // o que causa "Invalid color range" em qualquer filtro que tente ler essa flag.
  // A solução é fazer um re-encode parcial primeiro (-c:v libx264 -crf 0)
  // pra um arquivo intermediário limpo, sem a flag corrompida, antes de extrair frames.
  // Alternativa mais rápida: usar "scale2ref" com in_range forçado.
  // O jeito mais simples e confiável nessa versão do ffmpeg é usar
  // -vf com "colorspace" filter pra normalizar antes de qualquer coisa.
  const vf  = `colorspace=all=bt709:iall=bt601-6-625:fast=1,scale=${width}:${height}:flags=lanczos,fps=${fps},format=rgb24`;
  const cmd = `"${ffmpegPath}" -i "${videoPath}" -vf "${vf}" -q:v 2 "${outputFolder}/frame-%04d.png" 2>&1`;

  try {
    execSync(cmd, { maxBuffer: 100 * 1024 * 1024 }); // buffer 100 MB pro stdout do ffmpeg
  } catch (err) {
    const msg = err.stdout ? err.stdout.toString() : (err.message || "Erro desconhecido no FFMPEG");
    throw new Error(msg);
  }
}

// ─── Cleanup helper ──────────────────────────────────────────────────────────
function cleanup(videoPath, framesFolder) {
  try {
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (fs.existsSync(framesFolder)) {
      for (const f of fs.readdirSync(framesFolder)) {
        fs.unlinkSync(path.join(framesFolder, f));
      }
      fs.rmdirSync(framesFolder);
    }
  } catch (_) {}
}

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  const { url, size = 60, persent = 1, fps = 15 } = req.body ?? {};
  if (!url) return res.status(400).json({ error: "url é obrigatório" });

  const targetFps  = Math.min(Number(fps)  || 15, 15);
  const targetSize = Math.min(Number(size) || 60, 80);

  const jobId       = crypto.randomBytes(8).toString("hex");
  const tmpDir      = os.tmpdir();
  const videoPath   = path.join(tmpDir, `${jobId}.mp4`);
  const framesFolder = path.join(tmpDir, jobId);

  fs.mkdirSync(framesFolder, { recursive: true });

  try {
    // ── 1. Baixa o vídeo ──────────────────────────────────────────────────
    let response;
    try {
      // FIX 4: Timeout de 20 s pro download (evita o "fetch failed" genérico)
      response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal:  AbortSignal.timeout(20_000),
      });
    } catch (fetchErr) {
      // FIX 5: Mensagem de erro detalhada (antes mostrava só "fetch failed")
      throw new Error(`Falha ao baixar vídeo: ${fetchErr.message} | URL: ${url}`);
    }

    if (!response.ok) {
      throw new Error(`Servidor de vídeo retornou ${response.status} | URL: ${url}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(videoPath, buffer);

    // ── 2. Extrai frames ──────────────────────────────────────────────────
    extractFrames(videoPath, framesFolder, targetFps, targetSize, targetSize);

    // ── 3. Converte frames → RLE ──────────────────────────────────────────
    const files = fs.readdirSync(framesFolder)
      .filter(f => f.endsWith(".png"))
      .sort();

    if (files.length === 0) throw new Error("Nenhum frame foi extraído pelo FFmpeg.");

    const pixelFrames = [];
    const durations   = [];
    let finalWidth    = targetSize;
    let finalHeight   = targetSize;

    for (const file of files) {
      const frameBuffer = fs.readFileSync(path.join(framesFolder, file));

      const meta = await sharp(frameBuffer).metadata();
      finalWidth  = meta.width;
      finalHeight = meta.height;

      const raw = await sharp(frameBuffer).ensureAlpha().raw().toBuffer();

      pixelFrames.push(encodeRLE(raw, finalWidth, finalHeight, persent));
      durations.push(1 / targetFps);
    }

    // ── 4. Responde ───────────────────────────────────────────────────────
    return res.status(200).json({
      status: "success",
      dimensions: {
        width:    finalWidth,
        height:   finalHeight,
        animated: true,
        durations,
      },
      pixels: pixelFrames,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  } finally {
    // FIX 6: Limpeza SEMPRE roda, mesmo se der erro no meio
    cleanup(videoPath, framesFolder);
  }
};
