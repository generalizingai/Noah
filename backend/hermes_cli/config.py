"""hermes_cli.config stub."""
import os
from pathlib import Path

def get_hermes_home(): return Path.home() / ".hermes"
def get_config_path(*p): return Path.home() / ".hermes" / "config.json"
def get_env_path(): return Path.home() / ".hermes" / ".env"
def get_env_value(k, default=None): return os.environ.get(k, default)
def remove_env_value(k): pass
def ensure_hermes_home(): Path.home().joinpath(".hermes").mkdir(parents=True, exist_ok=True)
def get_compatible_custom_providers(): return []
def get_custom_provider_context_length(n): return 128000
