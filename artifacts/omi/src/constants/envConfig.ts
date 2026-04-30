const envConfig = {
  API_URL: import.meta.env.VITE_API_URL ?? 'https://api.omi.me',
  NODE_ENV: import.meta.env.MODE,
  IS_DEVELOPMENT: import.meta.env.MODE === 'development',
  WEB_URL: import.meta.env.VITE_WEB_URL ?? window.location.origin,
  APP_NAME: import.meta.env.VITE_APP_NAME ?? 'Noah',
  GLEAP_API_KEY: import.meta.env.VITE_GLEAP_API_KEY,
  ALGOLIA_APP_ID: import.meta.env.VITE_ALGOLIA_APP_ID ?? '',
  ALGOLIA_SEARCH_API_KEY: import.meta.env.VITE_ALGOLIA_API_KEY ?? '',
  ALGOLIA_INDEX_NAME: import.meta.env.VITE_ALGOLIA_INDEX_NAME ?? 'memories',
};

export default envConfig;
