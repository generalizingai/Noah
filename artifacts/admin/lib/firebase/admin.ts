import * as admin from 'firebase-admin';

function ensureInitialized() {
  if (admin.apps.length) return;

  let credential: admin.credential.Credential;

  if (process.env.FIREBASE_GOOGLE_CREDENTIALS_JSON) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_GOOGLE_CREDENTIALS_JSON);
      credential = admin.credential.cert(serviceAccount);
    } catch (e) {
      throw new Error('Failed to parse FIREBASE_GOOGLE_CREDENTIALS_JSON');
    }
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    });
  } else {
    throw new Error('Missing Firebase Admin SDK credentials. Set FIREBASE_GOOGLE_CREDENTIALS_JSON or individual FIREBASE_* vars.');
  }

  try {
    admin.initializeApp({ credential });
    console.log('Firebase Admin SDK initialized successfully.');
  } catch (error: any) {
    console.error('Firebase Admin SDK initialization error:', error.stack);
    throw error;
  }
}

export function getDb() {
  ensureInitialized();
  return admin.firestore();
}

export function getAdminAuth() {
  ensureInitialized();
  return admin.auth();
}

export const verifyFirebaseToken = async (token: string) => {
  ensureInitialized();
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    return decodedToken;
  } catch (error) {
    console.error('Error verifying Firebase ID token:', error);
    return null;
  }
};

export default admin;
