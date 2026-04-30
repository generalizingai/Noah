import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseToken, getDb } from '@/lib/firebase/admin';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { idToken } = await request.json();

    if (!idToken) {
      return NextResponse.json({ isAdmin: false, error: 'Missing token' }, { status: 400 });
    }

    const decodedToken = await verifyFirebaseToken(idToken);
    if (!decodedToken) {
      return NextResponse.json({ isAdmin: false, error: 'Invalid token' }, { status: 401 });
    }

    const db = getDb();
    const adminDoc = await db.collection('adminData').doc(decodedToken.uid).get();

    return NextResponse.json({ isAdmin: adminDoc.exists, uid: decodedToken.uid });
  } catch (error: any) {
    console.error('check-admin error:', error);
    return NextResponse.json({ isAdmin: false, error: error.message }, { status: 500 });
  }
}
