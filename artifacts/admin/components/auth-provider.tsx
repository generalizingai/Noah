'use client';

import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User, onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth';
import { getFirebaseAuth } from '@/lib/firebase/client';
import { DEV_BYPASS_ENABLED, DEV_BYPASS_TOKEN, DEV_BYPASS_UID } from '@/lib/dev-auth';
import { useRouter } from 'next/navigation';

interface AuthContextProps {
  user: User | null;
  isAdmin: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextProps>({
  user: null,
  isAdmin: false,
  loading: true,
  signOut: async () => {},
});

function createBypassUser(): User {
  return {
    uid: DEV_BYPASS_UID,
    getIdToken: async () => DEV_BYPASS_TOKEN,
  } as User;
}

async function checkAdminServerSide(user: User): Promise<boolean | null> {
  // Returns true = confirmed admin, false = confirmed NOT admin (403), null = transient error (retry)
  try {
    const idToken = await user.getIdToken();
    const res = await fetch('/admin/api/auth/check-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (res.status === 403) return false; // Definitely not admin
    if (!res.ok) return null;             // Transient (5xx, 502, etc) — retry
    const data = await res.json();
    return data.isAdmin === true ? true : false;
  } catch (err) {
    console.error('Admin check failed:', err);
    return null; // Network error — retry
  }
}

async function checkAdminWithRetry(user: User, maxAttempts = 5, delayMs = 1500): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delayMs));
    const result = await checkAdminServerSide(user);
    if (result !== null) return result;
    console.warn(`Admin check transient error, attempt ${attempt + 1}/${maxAttempts}`);
  }
  return false; // All retries failed — treat as not admin
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const bypassAuth = DEV_BYPASS_ENABLED;
  const [user, setUser] = useState<User | null>(bypassAuth ? createBypassUser() : null);
  const [isAdmin, setIsAdmin] = useState<boolean>(bypassAuth);
  const [loading, setLoading] = useState<boolean>(!bypassAuth);
  const router = useRouter();

  const signOut = async () => {
    try {
      await firebaseSignOut(getFirebaseAuth());
      setUser(null);
      setIsAdmin(false);
      router.push('/login');
    } catch (error) {
      console.error('Error signing out:', error);
    }
  };

  useEffect(() => {
    if (bypassAuth) {
      setUser(createBypassUser());
      setIsAdmin(true);
      setLoading(false);
      return;
    }

    const auth = getFirebaseAuth();
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setLoading(true);
      if (currentUser) {
        console.log('Signed in:', currentUser.email);
        const adminOk = await checkAdminWithRetry(currentUser);
        if (adminOk) {
          setUser(currentUser);
          setIsAdmin(true);
          console.log(`Admin verified: ${currentUser.email}`);
        } else {
          console.warn(`Not an admin: ${currentUser.email}`);
          await firebaseSignOut(auth);
          setUser(null);
          setIsAdmin(false);
          router.push('/login?error=unauthorized');
        }
      } else {
        setUser(null);
        setIsAdmin(false);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [bypassAuth, router]);

  return (
    <AuthContext.Provider value={{ user, isAdmin, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
