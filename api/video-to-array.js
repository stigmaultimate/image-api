// api/video-to-array.js — CommonJS

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");

// Diz ao fluent-ffmpeg onde está o binário do ffmpeg
ffmpeg.setFfmpegPath(ffmpegStatic);

// Sua função RLE original intacta
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

// Função para extrair frames do MP4 usando FFmpeg
const { execSync } = require("child_process");

function extractFrames(videoPath, outputFolder, fps, width, height) {
  const ffmpegPath = require("ffmpeg-static");
  
  // Vamos imprimir o comando para ver se o caminho do ffmpeg está correto
  console.log("FFMPEG PATH:", ffmpegPath);
  
  // Adicionamos flags para ver se o arquivo existe e dar permissão de execução
  try {
    execSync(`chmod +x "${ffmpegPath}"`);
  } catch(e) {
    console.log("Aviso: Falha ao dar chmod, ignorando...");
  }

  const cmd = `"${ffmpegPath}" -i "${videoPath}" -vf "fps=${fps},scale=${width}:${height}" -q:v 2 "${outputFolder}/frame-%03d.png" 2>&1`;
  
  try {
    const output = execSync(cmd);
    return true;
  } catch (err) {
    // Aqui a gente captura o erro real do FFMPEG
    throw new Error(err.stdout ? err.stdout.toString() : "Erro desconhecido no FFMPEG");
  }
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { url, size = 60, persent = 1, fps = 15 } = req.body;
    if (!url) return res.status(400).json({ error: "url é obrigatório" });

    // Cuidando para não estourar a memória/timeout da Vercel
    const targetFps = Math.min(fps, 15); // Força máx 15 FPS pra não dar timeout
    const targetSize = Math.min(size, 80); // Limita o tamanho

    // Nomes de arquivos temporários na Vercel
    const jobId = crypto.randomBytes(8).toString("hex");
    const tmpDir = os.tmpdir();
    const videoPath = path.join(tmpDir, `${jobId}.mp4`);
    const framesFolder = path.join(tmpDir, jobId);
    
    fs.mkdirSync(framesFolder, { recursive: true });

    // 1. Baixa o vídeo
  const response = await fetch(url, { 
      headers: { "User-Agent": "Mozilla/5.0" } 
    });
    
    if (!response.ok) throw new Error(`Falha ao baixar vídeo: ${response.status}`);
    
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(videoPath, buffer);

    // 2. Extrai os frames com FFmpeg
    await extractFrames(videoPath, framesFolder, targetFps, targetSize, targetSize);

    // 3. Lê os frames extraídos e converte para array de pixels
    const files = fs.readdirSync(framesFolder).filter(f => f.endsWith('.png')).sort();
    const pixelFrames = [];
    const durations = [];
    let finalWidth = targetSize;
    let finalHeight = targetSize;

    for (const file of files) {
      const frameBuffer = fs.readFileSync(path.join(framesFolder, file));
      
      const meta = await sharp(frameBuffer).metadata();
      finalWidth = meta.width;
      finalHeight = meta.height;

      const raw = await sharp(frameBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer();

      pixelFrames.push(encodeRLE(raw, finalWidth, finalHeight, persent));
      durations.push(1 / targetFps); // Ex: 1/15 = 0.066s de duração por frame
    }

    // Limpeza da pasta temporária para não lotar a Vercel
    fs.unlinkSync(videoPath);
    for (const file of files) fs.unlinkSync(path.join(framesFolder, file));
    fs.rmdirSync(framesFolder);

    // 4. Retorna para o Roblox
    return res.status(200).json({
      status: "success",
      dimensions: {
        width: finalWidth,
        height: finalHeight,
        animated: true,
        durations: durations,
      },
      pixels: pixelFrames,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
