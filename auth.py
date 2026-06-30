# ══════════════════════════════════════════════════════════════════════════════
# auth.py — Firebase token verification
# Every protected route calls get_current_user() which verifies the Firebase
# ID token sent in the Authorization header.
# ══════════════════════════════════════════════════════════════════════════════

import os
import firebase_admin
from firebase_admin import credentials, auth
from fastapi import HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

# ── Initialise Firebase Admin SDK (once) ─────────────────────────────────────
_service_account_path = os.getenv('FIREBASE_SERVICE_ACCOUNT_PATH', 'serviceAccount.json')

if not firebase_admin._apps:
    cred = credentials.Certificate(_service_account_path)
    firebase_admin.initialize_app(cred)

# ── Bearer token scheme ───────────────────────────────────────────────────────
bearer_scheme = HTTPBearer()

# ══════════════════════════════════════════════════════════════════════════════
# Dependency — verifies Firebase ID token and returns the decoded claims.
# Use as: user = Depends(get_current_user)
# Returns: { 'uid': str, 'email': str, ... }
# ══════════════════════════════════════════════════════════════════════════════
async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Security(bearer_scheme)
) -> dict:
    token = credentials.credentials
    try:
        decoded = auth.verify_id_token(token)
        return decoded
    except auth.ExpiredIdTokenError:
        raise HTTPException(status_code=401, detail='Token has expired. Please sign in again.')
    except auth.InvalidIdTokenError:
        raise HTTPException(status_code=401, detail='Invalid authentication token.')
    except Exception as e:
        raise HTTPException(status_code=401, detail=f'Authentication failed: {str(e)}')
