import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = process.env.SUPABASE_BUCKET_NAME || 'carousel-images';

export async function uploadImages(imagePaths) {
  const urls = [];

  for (const imagePath of imagePaths) {
    const timestamp = Date.now();
    const fileName = `${timestamp}-${path.basename(imagePath)}`;
    const fileBuffer = fs.readFileSync(imagePath);

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, fileBuffer, {
        contentType: 'image/png',
        upsert: true
      });

    if (error) throw new Error(`Supabase upload failed: ${error.message}`);

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
    urls.push(data.publicUrl);
    console.log(`  ☁️  Uploaded: ${fileName}`);
  }

  return urls;
}
