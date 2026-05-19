const fs = require('fs');
const path = require('path');

async function run() {
  const sharp = tryRequireSharp();
  if (!sharp) return;

  const svgPath = path.join(__dirname, '..', 'frontend', 'assets', 'logo.svg');
  const outDir = path.join(__dirname, '..', 'frontend', 'assets');

  if (!fs.existsSync(svgPath)) {
    console.error('Arquivo SVG não encontrado em:', svgPath);
    process.exit(1);
  }

  const svg = fs.readFileSync(svgPath);

  const sizes = [192, 512];

  for (const s of sizes) {
    const outPath = path.join(outDir, `logo-${s}.png`);
    try {
      await sharp(svg)
        .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(outPath);
      console.log('Gerado:', outPath);
    } catch (err) {
      console.error('Erro ao gerar', outPath, err.message);
    }
  }
}

function tryRequireSharp() {
  try {
    return require('sharp');
  } catch (e) {
    console.error('Módulo "sharp" não encontrado. Instale com: npm install sharp --save-dev');
    return null;
  }
}

run();
