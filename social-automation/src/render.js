import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '../output');
const SIZE = 1080;

function escapeXML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function splitLines(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (test.length <= maxChars) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function sharedDefs() {
  return `
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#05050F"/>
        <stop offset="100%" style="stop-color:#0E0528"/>
      </linearGradient>
      <linearGradient id="grd" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" style="stop-color:#8B5CF6"/>
        <stop offset="100%" style="stop-color:#3B82F6"/>
      </linearGradient>
      <filter id="glow">
        <feGaussianBlur stdDeviation="50"/>
      </filter>
    </defs>`;
}

function titleSlide(slide, total) {
  const hLines = splitLines(escapeXML(slide.headline), 20);
  const headlineSVG = hLines.map((line, i) =>
    `<text x="80" y="${430 + i * 78}" font-family="Arial Black, Arial, sans-serif" font-size="70" font-weight="900" fill="white">${line}</text>`
  ).join('');
  const subtextY = 430 + hLines.length * 78 + 50;

  return `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
    ${sharedDefs()}
    <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
    <!-- Glow orbs -->
    <circle cx="860" cy="180" r="320" fill="#8B5CF6" opacity="0.10" filter="url(#glow)"/>
    <circle cx="140" cy="880" r="260" fill="#3B82F6" opacity="0.09" filter="url(#glow)"/>
    <!-- Subtle grid -->
    <line x1="0" y1="540" x2="${SIZE}" y2="540" stroke="#ffffff" stroke-width="0.5" opacity="0.04"/>
    <line x1="540" y1="0" x2="540" y2="${SIZE}" stroke="#ffffff" stroke-width="0.5" opacity="0.04"/>
    <!-- Accent bar -->
    <rect x="80" y="370" width="7" height="${hLines.length * 78 + 30}" fill="url(#grd)" rx="4"/>
    <!-- Headline -->
    ${headlineSVG}
    <!-- Subtext -->
    <text x="80" y="${subtextY}" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#94A3B8">${escapeXML(slide.subtext)}</text>
    <!-- Swipe hint -->
    <text x="540" y="980" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#475569" text-anchor="middle" letter-spacing="3">SWIPE TO LEARN MORE  →</text>
    <!-- Bottom bar -->
    <rect x="0" y="1022" width="${SIZE}" height="58" fill="url(#grd)" opacity="0.85" rx="0"/>
    <text x="540" y="1059" font-family="Arial Black, Arial, sans-serif" font-size="22" fill="white" text-anchor="middle" letter-spacing="2">AI FOR BUSINESS</text>
    <!-- Counter -->
    <text x="1010" y="42" font-family="Arial, sans-serif" font-size="20" fill="#8B5CF6" text-anchor="end" font-weight="bold">1 / ${total}</text>
  </svg>`;
}

function contentSlide(slide, total) {
  const hLines = splitLines(escapeXML(slide.headline), 22);
  const bLines = splitLines(escapeXML(slide.body || ''), 36);

  const headlineSVG = hLines.map((line, i) =>
    `<text x="80" y="${370 + i * 68}" font-family="Arial Black, Arial, sans-serif" font-size="58" font-weight="900" fill="white">${line}</text>`
  ).join('');
  const bodyStartY = 370 + hLines.length * 68 + 55;
  const bodySVG = bLines.map((line, i) =>
    `<text x="80" y="${bodyStartY + i * 46}" font-family="Arial, Helvetica, sans-serif" font-size="36" fill="#CBD5E1">${line}</text>`
  ).join('');

  return `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
    ${sharedDefs()}
    <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
    <!-- Glow -->
    <circle cx="900" cy="880" r="280" fill="#8B5CF6" opacity="0.08" filter="url(#glow)"/>
    <!-- Number badge -->
    <rect x="80" y="100" width="92" height="92" rx="22" fill="url(#grd)"/>
    <text x="126" y="163" font-family="Arial Black, Arial, sans-serif" font-size="50" font-weight="900" fill="white" text-anchor="middle">${slide.number}</text>
    <!-- Divider -->
    <rect x="80" y="228" width="${SIZE - 160}" height="2" fill="url(#grd)" opacity="0.35" rx="1"/>
    <!-- Headline -->
    ${headlineSVG}
    <!-- Body -->
    ${bodySVG}
    <!-- Bottom bar -->
    <rect x="0" y="1022" width="${SIZE}" height="58" fill="url(#grd)" opacity="0.85"/>
    <text x="540" y="1059" font-family="Arial Black, Arial, sans-serif" font-size="22" fill="white" text-anchor="middle" letter-spacing="2">AI FOR BUSINESS</text>
    <!-- Counter -->
    <text x="1010" y="42" font-family="Arial, sans-serif" font-size="20" fill="#8B5CF6" text-anchor="end" font-weight="bold">${slide.number} / ${total}</text>
  </svg>`;
}

function ctaSlide(slide, total) {
  return `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
    ${sharedDefs()}
    <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
    <!-- Center glow -->
    <circle cx="540" cy="480" r="380" fill="#8B5CF6" opacity="0.09" filter="url(#glow)"/>
    <!-- Icon -->
    <text x="540" y="380" font-size="110" text-anchor="middle">🤖</text>
    <!-- Headline -->
    <text x="540" y="510" font-family="Arial Black, Arial, sans-serif" font-size="54" font-weight="900" fill="white" text-anchor="middle">${escapeXML(slide.headline)}</text>
    <!-- Subtext -->
    <text x="540" y="584" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#94A3B8" text-anchor="middle">${escapeXML(slide.subtext)}</text>
    <!-- Follow button -->
    <rect x="240" y="650" width="600" height="82" rx="41" fill="url(#grd)"/>
    <text x="540" y="702" font-family="Arial Black, Arial, sans-serif" font-size="28" fill="white" text-anchor="middle" font-weight="900">FOLLOW FOR MORE AI TIPS</text>
    <!-- Engagement row -->
    <text x="540" y="810" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="#475569" text-anchor="middle">❤️  Like   •   🔁  Share   •   🔖  Save</text>
    <!-- Bottom bar -->
    <rect x="0" y="1022" width="${SIZE}" height="58" fill="url(#grd)" opacity="0.85"/>
    <text x="540" y="1059" font-family="Arial Black, Arial, sans-serif" font-size="22" fill="white" text-anchor="middle" letter-spacing="2">AI FOR BUSINESS</text>
    <!-- Counter -->
    <text x="1010" y="42" font-family="Arial, sans-serif" font-size="20" fill="#8B5CF6" text-anchor="end" font-weight="bold">${total} / ${total}</text>
  </svg>`;
}

export async function renderSlides(slides) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const total = slides.length;
  const imagePaths = [];

  for (const slide of slides) {
    let svg;
    if (slide.type === 'title') svg = titleSlide(slide, total);
    else if (slide.type === 'cta') svg = ctaSlide(slide, total);
    else svg = contentSlide(slide, total);

    const outputPath = path.join(OUTPUT_DIR, `slide-${slide.number}.png`);
    await sharp(Buffer.from(svg)).png().toFile(outputPath);
    imagePaths.push(outputPath);
    console.log(`  🎨 Slide ${slide.number} rendered`);
  }

  return imagePaths;
}
