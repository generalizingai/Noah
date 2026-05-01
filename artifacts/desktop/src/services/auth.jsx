import React, { createContext, useContext, useState, useEffect } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  GoogleAuthProvider,
  signInWithCredential,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

let app;
if (getApps().length === 0) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApps()[0];
}

const auth = getAuth(app);

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsub;
  }, []);

  const signIn = async (email, password) => {
    return signInWithEmailAndPassword(auth, email, password);
  };

  const signInWithGoogle = async () => {
    // In Electron: delegate OAuth to the system browser via a local HTTP server.
    // This avoids every popup/redirect restriction that Electron imposes on custom
    // protocol origins (app://, file://).  The browser page does signInWithPopup
    // normally (localhost is always in Firebase's authorized domains), then POSTs
    // the raw Google credential (idToken + accessToken) back to the local server,
    // which relays it here so we can call signInWithCredential on this Firebase
    // instance.
    if (window.electronAPI?.startGoogleAuth) {
      return new Promise((resolve, reject) => {
        // Register the one-time result listener BEFORE opening the browser
        const cleanup = window.electronAPI.onGoogleAuthResult(async (result) => {
          if (result.error) {
            reject(new Error(result.error));
            return;
          }
          try {
            const credential = GoogleAuthProvider.credential(
              result.idToken,
              result.accessToken,
            );
            const userCredential = await signInWithCredential(auth, credential);
            resolve(userCredential);
          } catch (err) {
            reject(err);
          }
        });

        // Open browser (non-blocking — resolves immediately after server starts)
        window.electronAPI.startGoogleAuth(firebaseConfig).catch((err) => {
          cleanup();
          reject(err);
        });
      });
    }

    // Fallback for non-Electron (dev server in browser)
    const { signInWithPopup } = await import('firebase/auth');
    const provider = new GoogleAuthProvider();
    return signInWithPopup(auth, provider);
  };

  const signOut = async () => {
    return firebaseSignOut(auth);
  };

  const getToken = async () => {
    if (!user) return null;
    return user.getIdToken();
  };

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signInWithGoogle, signOut, getToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
export { auth };
