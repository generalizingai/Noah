import 'dotenv/config';
import { generateCarouselContent } from './generate.js';
import { renderSlides } from './render.js';
import { uploadImages } from './upload.js';
import { postToInstagram } from './instagram.js';
import { postToFacebook } from './facebook.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, '../post-log.json');

function cleanup(imagePaths) {
  for (const p of imagePaths) {
    try { fs.unlinkSync(p); } catch {}
  }
}

function saveLog(entry) {
  const logs = fs.existsSync(LOG_FILE)
    ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'))
    : [];
  logs.push(entry);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

async function run() {
  const startTime = Date.now();
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🤖 Social Media Automation Starting');
  console.log(`  📅 ${new Date().toLocaleString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let imagePaths = [];

  try {
    // 1. Generate content with Claude
    console.log('✍️  Generating carousel content...');
    const content = await generateCarouselContent();
    console.log(`  📌 Topic: ${content.topic}\n`);

    // 2. Render slides to PNG
    console.log('🎨 Rendering slides...');
    imagePaths = await renderSlides(content.slides);
    console.log();

    // 3. Upload to Supabase Storage
    console.log('☁️  Uploading to Supabase...');
    const imageUrls = await uploadImages(imagePaths);
    console.log();

    // 4. Post to Instagram
    console.log('📸 Posting to Instagram...');
    const igPostId = await postToInstagram(imageUrls, content.caption);
    console.log();

    // 5. Post to Facebook
    console.log('📘 Posting to Facebook...');
    const fbPostId = await postToFacebook(imageUrls, content.caption);
    console.log();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  ✅ Done in ${elapsed}s`);
    console.log(`  📸 Instagram: ${igPostId}`);
    console.log(`  📘 Facebook:  ${fbPostId}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    saveLog({
      date: new Date().toISOString(),
      topic: content.topic,
      instagram_post_id: igPostId,
      facebook_post_id: fbPostId,
      status: 'success',
      elapsed_seconds: parseFloat(elapsed)
    });

  } catch (err) {
    console.error('\n❌ Error:', err.message);
    if (err.response?.data) {
      console.error('API Response:', JSON.stringify(err.response.data, null, 2));
    }

    saveLog({
      date: new Date().toISOString(),
      error: err.message,
      status: 'failed'
    });

    process.exit(1);
  } finally {
    cleanup(imagePaths);
  }
}

run();
