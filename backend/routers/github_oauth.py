import os
import secrets
import time
from typing import Dict
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse

from utils.http_client import get_auth_client
from utils.other import endpoints as auth

router = APIRouter(prefix="/api/v1/integrations/github", tags=["github_oauth"])

_PENDING: Dict[str, dict] = {}
_TTL_SECONDS = 300


def _cleanup_pending() -> None:
    now = time.time()
    stale = [k for k, v in _PENDING.items() if now - v.get("created_at", now) > _TTL_SECONDS]
    for k in stale:
        _PENDING.pop(k, None)


def _get_oauth_client_config() -> tuple[str, str]:
    client_id = os.getenv("GITHUB_OAUTH_CLIENT_ID", "").strip()
    client_secret = os.getenv("GITHUB_OAUTH_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=503,
            detail="GitHub OAuth is not configured on backend. Missing GITHUB_OAUTH_CLIENT_ID/SECRET.",
        )
    return client_id, client_secret


@router.post("/oauth/start")
async def github_oauth_start(request: Request, uid: str = Depends(auth.get_current_user_uid)):
    _cleanup_pending()
    client_id, _ = _get_oauth_client_config()

    state = secrets.token_urlsafe(24)
    redirect_uri = str(request.url_for("github_oauth_callback"))

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": "repo codespace read:user",
        "state": state,
    }
    auth_url = f"https://github.com/login/oauth/authorize?{urlencode(params)}"
    _PENDING[state] = {
        "uid": uid,
        "created_at": time.time(),
        "redirect_uri": redirect_uri,
        "token": None,
        "error": None,
        "consumed": False,
    }
    return {"auth_url": auth_url, "state": state, "expires_in": _TTL_SECONDS}


@router.get("/oauth/callback", response_class=HTMLResponse, name="github_oauth_callback")
async def github_oauth_callback(code: str = Query(...), state: str = Query(...)):
    _cleanup_pending()
    pending = _PENDING.get(state)
    if not pending:
        return HTMLResponse(
            "<h3>GitHub connect failed</h3><p>State expired or invalid. Please try again from Noah.</p>",
            status_code=400,
        )

    client_id, client_secret = _get_oauth_client_config()
    client = get_auth_client()
    try:
        resp = await client.post(
            "https://github.com/login/oauth/access_token",
            headers={"Accept": "application/json"},
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": pending.get("redirect_uri", ""),
                "state": state,
            },
        )
        payload = resp.json()
    except Exception as e:
        pending["error"] = f"OAuth exchange failed: {e}"
        return HTMLResponse(
            "<h3>GitHub connect failed</h3><p>Token exchange failed. Return to Noah and try again.</p>",
            status_code=500,
        )

    if not resp.is_success or payload.get("error"):
        pending["error"] = payload.get("error_description") or payload.get("error") or f"HTTP {resp.status_code}"
        return HTMLResponse(
            "<h3>GitHub connect failed</h3><p>Authorization was denied or invalid. Return to Noah and try again.</p>",
            status_code=400,
        )

    token = payload.get("access_token")
    if not token:
        pending["error"] = "No access token in OAuth response"
        return HTMLResponse(
            "<h3>GitHub connect failed</h3><p>No token returned. Return to Noah and try again.</p>",
            status_code=400,
        )

    pending["token"] = token
    pending["error"] = None

    return HTMLResponse(
        """
        <html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0b0f0b;color:#e8f0e8;padding:32px;">
          <h2 style="margin-top:0;color:#4ade80;">GitHub connected to Noah</h2>
          <p>You can close this tab and return to Noah.</p>
        </body></html>
        """
    )


@router.get("/oauth/result")
async def github_oauth_result(state: str, uid: str = Depends(auth.get_current_user_uid)):
    _cleanup_pending()
    pending = _PENDING.get(state)
    if not pending:
        raise HTTPException(status_code=404, detail="OAuth state not found or expired.")
    if pending.get("uid") != uid:
        raise HTTPException(status_code=403, detail="Not authorized for this OAuth state.")
    if pending.get("consumed"):
        raise HTTPException(status_code=410, detail="OAuth token already consumed.")
    if pending.get("error"):
        raise HTTPException(status_code=400, detail=pending["error"])
    if not pending.get("token"):
        return {"status": "pending"}

    pending["consumed"] = True
    token = pending["token"]
    _PENDING.pop(state, None)
    return {"status": "ok", "access_token": token}

