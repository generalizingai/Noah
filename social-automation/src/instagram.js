import axios from 'axios';

const BASE = 'https://graph.facebook.com/v21.0';
const IG_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function createMediaContainer(imageUrl) {
  const res = await axios.post(`${BASE}/${IG_ID}/media`, {
    image_url: imageUrl,
    is_carousel_item: true,
    access_token: TOKEN
  });
  return res.data.id;
}

async function createCarouselContainer(containerIds, caption) {
  const res = await axios.post(`${BASE}/${IG_ID}/media`, {
    media_type: 'CAROUSEL',
    children: containerIds.join(','),
    caption,
    access_token: TOKEN
  });
  return res.data.id;
}

async function publishCarousel(carouselId) {
  const res = await axios.post(`${BASE}/${IG_ID}/media_publish`, {
    creation_id: carouselId,
    access_token: TOKEN
  });
  return res.data.id;
}

export async function postToInstagram(imageUrls, caption) {
  console.log('  Creating media containers...');
  const containerIds = [];
  for (const url of imageUrls) {
    const id = await createMediaContainer(url);
    containerIds.push(id);
    await delay(1000);
  }

  console.log('  Creating carousel container...');
  const carouselId = await createCarouselContainer(containerIds, caption);

  // Give Instagram time to process
  await delay(4000);

  console.log('  Publishing...');
  const postId = await publishCarousel(carouselId);

  console.log(`  ✅ Instagram post live! ID: ${postId}`);
  return postId;
}
