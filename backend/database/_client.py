import hashlib
import json
import os
import uuid

from google.cloud import firestore

_firebase_json = os.environ.get('SERVICE_ACCOUNT_JSON') or os.environ.get('FIREBASE_GOOGLE_CREDENTIALS_JSON')
if _firebase_json:
    service_account_info = json.loads(_firebase_json)
    with open('google-credentials.json', 'w') as f:
        json.dump(service_account_info, f)
    os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = 'google-credentials.json'
elif os.path.exists('google-credentials.json'):
    os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = 'google-credentials.json'

_project = os.environ.get('FIREBASE_PROJECT_ID') or os.environ.get('GOOGLE_CLOUD_PROJECT')
db = firestore.Client(project=_project) if _project else firestore.Client()


def get_users_uid():
    users_ref = db.collection('users')
    return [str(doc.id) for doc in users_ref.stream()]


def document_id_from_seed(seed: str) -> uuid.UUID:
    """Avoid repeating the same data"""
    seed_hash = hashlib.sha256(seed.encode('utf-8')).digest()
    generated_uuid = uuid.UUID(bytes=seed_hash[:16], version=4)
    return str(generated_uuid)
