"""hermes_cli.auth stub."""
PROVIDER_REGISTRY = {}

def _read_codex_tokens(): return None
def resolve_codex_runtime_credentials(): return None
def resolve_nous_runtime_credentials(): return None
def resolve_qwen_runtime_credentials(): return None
def resolve_runtime_provider(): return None
def resolve_api_key_provider_credentials(p, *a, **kw): return None
def is_provider_explicitly_configured(p): return False
def get_provider_auth_state(p): return None
def is_source_suppressed(*a, **kw): return False
def suppress_credential_source(*a, **kw): pass
