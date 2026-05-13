import axios from 'axios';

const BASE = 'https://graph.facebook.com/v21.0';
const PAGE_ID = process.env.FACEBOOK_PAGE_ID;
const TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadPhoto(imageUrl) {
  const res = await axios.post(`${BASE}/${PAGE_ID}/photos`, {
    url: imageUrl,
    published: false,
    access_token: TOKEN
  });
  return res.data.id;
}

export async function postToFacebook(imageUrls, caption) {
  console.log('  Uploading photos...');
  const photoIds = [];
  for (const url of imageUrls) {
    const id = await uploadPhoto(url);
    photoIds.push(id);
    await delay(500);
  }

  console.log('  Creating post...');
  const attachedMedia = photoIds.map((id) => ({ media_fbid: id }));

  const res = await axios.post(`${BASE}/${PAGE_ID}/feed`, {
    message: caption,
    attached_media: attachedMedia,
    access_token: TOKEN
  });

  console.log(`  ✅ Facebook post live! ID: ${res.data.id}`);
  return res.data.id;
}
