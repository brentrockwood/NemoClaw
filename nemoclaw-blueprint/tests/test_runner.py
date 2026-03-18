# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for orchestrator/runner.py — Ollama profile and blueprint YAML."""

from pathlib import Path

import pytest
import yaml

BLUEPRINT_PATH = Path(__file__).parent.parent / "blueprint.yaml"
POLICIES_DIR = Path(__file__).parent.parent / "policies"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def load_blueprint() -> dict:
    with BLUEPRINT_PATH.open() as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# Blueprint YAML structure
# ---------------------------------------------------------------------------


def test_blueprint_is_valid_yaml() -> None:
    blueprint = load_blueprint()
    assert isinstance(blueprint, dict)


def test_ollama_in_profiles() -> None:
    blueprint = load_blueprint()
    assert "ollama" in blueprint["profiles"]


def test_ollama_inference_profile_present() -> None:
    blueprint = load_blueprint()
    profiles = blueprint["components"]["inference"]["profiles"]
    assert "ollama" in profiles


def test_ollama_profile_provider_type() -> None:
    blueprint = load_blueprint()
    ollama = blueprint["components"]["inference"]["profiles"]["ollama"]
    assert ollama["provider_type"] == "ollama"


def test_ollama_profile_credential_default() -> None:
    blueprint = load_blueprint()
    ollama = blueprint["components"]["inference"]["profiles"]["ollama"]
    assert ollama["credential_default"] == "ollama"
    assert ollama["credential_env"] == "OPENAI_API_KEY"


def test_ollama_profile_dynamic_endpoint() -> None:
    blueprint = load_blueprint()
    ollama = blueprint["components"]["inference"]["profiles"]["ollama"]
    assert ollama.get("dynamic_endpoint") is True


def test_ollama_service_policy_addition_present() -> None:
    blueprint = load_blueprint()
    additions = blueprint["components"]["policy"]["additions"]
    assert "ollama_service" in additions


# ---------------------------------------------------------------------------
# Preset YAML
# ---------------------------------------------------------------------------


def test_ollama_preset_is_valid_yaml() -> None:
    preset_path = POLICIES_DIR / "presets" / "ollama.yaml"
    with preset_path.open() as f:
        preset = yaml.safe_load(f)
    assert isinstance(preset, dict)


def test_ollama_preset_name() -> None:
    preset_path = POLICIES_DIR / "presets" / "ollama.yaml"
    with preset_path.open() as f:
        preset = yaml.safe_load(f)
    assert preset["preset"]["name"] == "ollama"


def test_ollama_preset_has_network_policies() -> None:
    preset_path = POLICIES_DIR / "presets" / "ollama.yaml"
    with preset_path.open() as f:
        preset = yaml.safe_load(f)
    assert "network_policies" in preset
    assert "ollama_server" in preset["network_policies"]


# ---------------------------------------------------------------------------
# runner.py helpers
# ---------------------------------------------------------------------------


def test_normalize_v1_appends_suffix() -> None:
    from orchestrator.runner import normalize_v1

    assert normalize_v1("http://localhost:11434") == "http://localhost:11434/v1"


def test_normalize_v1_no_double_append() -> None:
    from orchestrator.runner import normalize_v1

    assert normalize_v1("http://localhost:11434/v1") == "http://localhost:11434/v1"


def test_normalize_v1_strips_trailing_slash() -> None:
    from orchestrator.runner import normalize_v1

    assert normalize_v1("http://localhost:11434/") == "http://localhost:11434/v1"


def test_resolve_dynamic_endpoint_ollama_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    from orchestrator.runner import resolve_dynamic_endpoint

    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ai.example.org:11434")
    assert resolve_dynamic_endpoint("ollama") == "http://ai.example.org:11434/v1"


def test_resolve_dynamic_endpoint_ollama_default(monkeypatch: pytest.MonkeyPatch) -> None:
    from orchestrator.runner import resolve_dynamic_endpoint

    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    assert resolve_dynamic_endpoint("ollama") == "http://localhost:11434/v1"


def test_resolve_ollama_host_strips_scheme_and_port() -> None:
    from orchestrator.runner import resolve_ollama_host

    assert resolve_ollama_host("http://ai.example.org:11434/v1") == "ai.example.org"


def test_resolve_ollama_host_localhost() -> None:
    from orchestrator.runner import resolve_ollama_host

    assert resolve_ollama_host("http://localhost:11434/v1") == "localhost"


# ---------------------------------------------------------------------------
# action_plan — Ollama profile
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def mock_openshell(monkeypatch: pytest.MonkeyPatch) -> None:
    """Prevent action_plan from aborting because openshell is not installed."""
    monkeypatch.setattr("orchestrator.runner.openshell_available", lambda: True)


def test_plan_ollama_endpoint_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    from orchestrator.runner import action_plan

    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ai.example.org:11434")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    plan = action_plan("ollama", load_blueprint())

    assert plan["inference"]["endpoint"] == "http://ai.example.org:11434/v1"


def test_plan_ollama_defaults_to_localhost(monkeypatch: pytest.MonkeyPatch) -> None:
    from orchestrator.runner import action_plan

    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    plan = action_plan("ollama", load_blueprint())

    assert plan["inference"]["endpoint"] == "http://localhost:11434/v1"


def test_plan_ollama_no_double_v1(monkeypatch: pytest.MonkeyPatch) -> None:
    from orchestrator.runner import action_plan

    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ai.example.org:11434/v1")

    plan = action_plan("ollama", load_blueprint())

    assert plan["inference"]["endpoint"] == "http://ai.example.org:11434/v1"


def test_plan_ollama_credential_defaults_to_ollama(monkeypatch: pytest.MonkeyPatch) -> None:
    from orchestrator.runner import action_plan

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    plan = action_plan("ollama", load_blueprint())

    assert plan["inference"]["credential"] == "ollama"


def test_plan_ollama_resolves_host_placeholder(monkeypatch: pytest.MonkeyPatch) -> None:
    from orchestrator.runner import action_plan

    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ai.example.org:11434")

    plan = action_plan("ollama", load_blueprint())

    ollama_addition = plan["policy_additions"].get("ollama_service", {})
    endpoints = ollama_addition.get("endpoints", [])
    assert any(ep.get("host") == "ai.example.org" for ep in endpoints)


def test_plan_ollama_provider_type(monkeypatch: pytest.MonkeyPatch) -> None:
    from orchestrator.runner import action_plan

    plan = action_plan("ollama", load_blueprint())

    assert plan["inference"]["provider_type"] == "ollama"
