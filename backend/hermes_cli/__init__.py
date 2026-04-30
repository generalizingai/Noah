"""
hermes_cli stub — minimal shim so upstream hermes agent files can be imported
without the full hermes_cli CLI package installed.

The real hermes_cli package is part of the NousResearch/hermes-agent CLI tool.
Noah's backend does not require it; these stubs keep import-time failures from
propagating through the vendored agent_upstream/ files.
"""
__version__ = "0.0.0-noah-stub"
