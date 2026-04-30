import hashlib
import json
import logging
import os
import uuid

logger = logging.getLogger(__name__)

_firebase_json = os.environ.get('SERVICE_ACCOUNT_JSON') or os.environ.get('FIREBASE_GOOGLE_CREDENTIALS_JSON')
if _firebase_json:
    try:
        service_account_info = json.loads(_firebase_json)
        with open('google-credentials.json', 'w') as f:
            json.dump(service_account_info, f)
        os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = 'google-credentials.json'
    except Exception as e:
        logger.warning(f"Failed to write google-credentials.json: {e}")
elif os.path.exists('google-credentials.json'):
    os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = 'google-credentials.json'

_project = os.environ.get('FIREBASE_PROJECT_ID') or os.environ.get('GOOGLE_CLOUD_PROJECT')

_db = None


def _get_db():
    global _db
    if _db is None:
        from google.cloud import firestore
        try:
            _db = firestore.Client(project=_project) if _project else firestore.Client()
        except Exception as e:
            logger.error(f"Firestore init failed: {e}")
            raise
    return _db


class _LazyDB:
    def __getattr__(self, name):
        return getattr(_get_db(), name)


db = _LazyDB()


def get_users_uid():
    users_ref = db.collection('users')
    return [str(doc.id) for doc in users_ref.stream()]


def document_id_from_seed(seed: str) -> uuid.UUID:
    """Avoid repeating the same data"""
    seed_hash = hashlib.sha256(seed.encode('utf-8')).digest()
    generated_uuid = uuid.UUID(bytes=seed_hash[:16], version=4)
    return str(generated_uuid)
