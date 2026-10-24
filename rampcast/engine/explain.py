"""Plain-language briefings and explanations.

By default the built-in writer below turns the engine's JSON facts into sentences, citing fact ids; it runs
offline and needs no keys. RAMPCAST_USE_LOCAL_LLM=1 lets a local model (Ollama, LM Studio, vLLM, llama.cpp; any
OpenAI-compatible chat endpoint at LOCAL_LLM_URL) word the same facts, and RAMPCAST_USE_CLAUDE=1 with an Anthropic
key lets Claude do it. If a model is down, the built-in writer answers. Numbers always come from the engine, never
from a language model.
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

import anthropic
import httpx

log = logging.getLogger("rampcast.explain")

MODEL = "claude-sonnet-5-5"   # team spec: Role 3 Claude layer runs on Sonnet
SYSTEM = (
    "You are the operations analyst inside RAMPCAST, a planning co-pilot for the manager of a private-jet FBO "
    "at Van Nuys Airport during Super Bowl LXI week. Write for a busy manager: short plain sentences, no hype, "
    "no headings, at most 6 sentences.\n"
    "Rules:\n"
    "- Use only the numbers and facts in the JSON you are given. Never invent or round them differently.\n"
    "- After each number, cite the fact id in square brackets, e.g. [B.kpis.empty_legs].\n"
    "- You suggest; people decide. Never tell anyone to land, hold, divert or clear an aircraft, never contact "
    "ATC, CBP or a cockpit, and never rank people by who they are.\n"
    "- End with one sentence naming what needs a human approval and which role approves it."
)

_cache: dict[str, dict] = {}
_client: anthropic.Anthropic | None = None


def claude_available() -> bool:
    if os.environ.get("RAMPCAST_DISABLE_CLAUDE") or not os.environ.get("RAMPCAST_USE_CLAUDE"):
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
                or (Path.home() / ".config" / "anthropic").exists())


def local_llm_available() -> bool:
    """True if local LLM is enabled via RAMPCAST_USE_LOCAL_LLM=1 or LOCAL_LLM_URL."""
    if os.environ.get("RAMPCAST_DISABLE_LOCAL_LLM"):
        return False
    return bool(os.environ.get("RAMPCAST_USE_LOCAL_LLM") or os.environ.get("LOCAL_LLM_URL"))


def _normalize_local_url(raw_url: str | None = None) -> str:
    url = (raw_url or os.environ.get("LOCAL_LLM_URL") or "http://127.0.0.1:11434/v1/chat/completions").strip()
    url = url.rstrip("/")
    if url.endswith("/chat/completions") or url.endswith("/api/chat") or url.endswith("/api/generate"):
        return url
    if url.endswith("/v1"):
        return f"{url}/chat/completions"
    return f"{url}/v1/chat/completions"


def get_local_model_name() -> str:
    """Return configured model or auto-detect from local Ollama/OpenAI server."""
    if os.environ.get("LOCAL_LLM_MODEL"):
        return os.environ["LOCAL_LLM_MODEL"]

    url = _normalize_local_url()
    base = url.split("/v1/")[0].split("/api/")[0].rstrip("/")
    try:
        with httpx.Client(timeout=1.0) as client:
            # Try Ollama /api/tags
            try:
                r = client.get(f"{base}/api/tags")
                if r.status_code == 200:
                    models = [m.get("name", "") for m in r.json().get("models", [])]
                    models = [m for m in models if "embed" not in m.lower()]
                    for pref in ("llama3.2:latest", "llama3.2", "llama3:latest", "llama3", "mistral", "qwen", "gemma"):
                        for m in models:
                            if m.lower() == pref or m.lower().startswith(pref):
                                return m
                    if models:
                        return models[0]
            except Exception:
                pass

            # Try /v1/models
            try:
                r = client.get(f"{base}/v1/models")
                if r.status_code == 200:
                    data = r.json().get("data", [])
                    models = [m.get("id", "") for m in data if isinstance(m, dict)]
                    models = [m for m in models if "embed" not in m.lower()]
                    for pref in ("llama3.2:latest", "llama3.2", "llama3:latest", "llama3", "mistral", "qwen", "gemma"):
                        for m in models:
                            if m.lower() == pref or m.lower().startswith(pref):
                                return m
                    if models:
                        return models[0]
            except Exception:
                pass
    except Exception:
        pass
    return "llama3.2"


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(timeout=60, max_retries=1)
    return _client


def _call_local_llm(prompt: str) -> dict | None:
    """Call a local OpenAI/Ollama-compatible chat completion server (e.g. Ollama, LM Studio, vLLM)."""
    url = _normalize_local_url()
    model = get_local_model_name()
    timeout = float(os.environ.get("LOCAL_LLM_TIMEOUT", "30.0"))

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "max_tokens": 1000,
    }

    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(url, json=payload)
            if resp.status_code == 200:
                data = resp.json()
                text = ""
                if "choices" in data and data["choices"]:
                    text = data["choices"][0].get("message", {}).get("content", "").strip()
                elif "message" in data:
                    text = data["message"].get("content", "").strip()
                elif "response" in data:
                    text = data.get("response", "").strip()

                if text:
                    return {"text": text, "model": data.get("model", model)}
            else:
                log.warning("Local LLM status %d from %s", resp.status_code, url)
    except Exception as e:
        log.warning("Local LLM request failed (%s): %s", type(e).__name__, e)
    return None


def _cited(text: str, facts: dict) -> list[str]:
    ids = set(re.findall(r"\[([A-Za-z0-9_.\-]+)\]", text))
    known = {f["id"] for f in facts.get("facts", [])}
    return sorted(ids & known) if known else sorted(ids)


def explain(kind: str, facts: dict, cache_key: str, question: str | None = None) -> dict:
    if cache_key in _cache:
        return _cache[cache_key]
    result = None
    prompt = (f"Task: {kind}.\n" + (f"Manager's question: {question}\n" if question else "")
              + "Facts (JSON):\n" + json.dumps(facts, indent=1, default=str))

    prefer_local = bool(os.environ.get("RAMPCAST_USE_LOCAL_LLM") or os.environ.get("RAMPCAST_PREFER_LOCAL_LLM"))

    def try_claude():
        if not claude_available():
            return None
        try:
            response = _get_client().beta.messages.create(
                model=MODEL,
                max_tokens=4000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                output_config={"effort": "low"},
                system=SYSTEM,
                messages=[{"role": "user", "content": prompt}],
            )
            if response.stop_reason != "refusal":
                text = "".join(b.text for b in response.content if b.type == "text").strip()
                if text:
                    return {"text": text, "cited_ids": _cited(text, facts), "model": response.model,
                            "fallback": False}
        except anthropic.RateLimitError:
            log.warning("Claude rate limited; trying fallback")
        except anthropic.APIStatusError as e:
            log.warning("Claude API error %s; trying fallback", e.status_code)
        except anthropic.APIConnectionError:
            log.warning("Claude unreachable; trying fallback")
        except Exception as e:
            log.warning("Claude unavailable (%s); trying fallback", type(e).__name__)
        return None

    def try_local():
        if not local_llm_available():
            return None
        local_res = _call_local_llm(prompt)
        if local_res and local_res.get("text"):
            text = local_res["text"]
            return {
                "text": text,
                "cited_ids": _cited(text, facts),
                "model": f"local:{local_res.get('model', 'llm')}",
                "fallback": False,
            }
        return None

    if prefer_local:
        result = try_local()
        if result is None:
            result = try_claude()
    else:
        result = try_claude()
        if result is None:
            result = try_local()

    # Built-in deterministic template fallback (runs 100% offline, no server needed)
    if result is None:
        text = template(kind, facts, question)
        result = {"text": text, "cited_ids": _cited(text, facts), "model": "template", "fallback": True}
    _cache[cache_key] = result
    return result


def template(kind: str, facts: dict, question: str | None = None) -> str:
    f = {x["id"]: x for x in facts.get("facts", [])}

    def v(fid: str) -> str:
        return f"{f[fid]['value']} [{fid}]" if fid in f else "n/a"

    if kind == "briefing":
        best = facts.get("recommended", "B")
        return (f"Scenario {facts.get('scenario', 'medium')}: unconstrained ramp demand peaks at "
                f"{v('status_quo.peak_demand')} large-cabin equivalents against {v('capacity')}, "
                f"{v('status_quo.hours_over_capacity')} hours over capacity if nothing changes. "
                f"Strategy {best} needs {v(best + '.kpis.empty_legs')} empty repositioning legs and "
                f"{v(best + '.kpis.co2_t')} t CO2, with {v(best + '.kpis.peak_line_staff')} line techs at the peak hour. "
                f"There are {v('alerts.high')} high-severity alerts open. "
                f"The FBO general manager approves the strategy; partner FBOs confirm their stands.")
    if kind == "question":
        return answer(facts, question or "")
    if kind == "whatif" and "whatif.peak_moves_after" in f:
        return (f"The delay moves {v('whatif.affected')} inbound jets {v('whatif.max_delay_min')} min later, so the morning bank "
                f"lands on top of the afternoon one: movements in the peak hour go from {v('whatif.peak_moves_before')} to "
                f"{v('whatif.peak_moves_after')}, and strategy B needs {v('whatif.staff_after')} line techs instead of "
                f"{v('whatif.staff_before')}. {v('whatif.commitments_at_risk')} fixed-time passenger commitments are now at risk "
                f"and {v('whatif.customs_at_risk')} international arrivals risk missing customs. "
                f"Hours over capacity move from {v('whatif.hours_before')} to {v('whatif.hours_after')}. "
                f"The line supervisor approves calling in the extra shift; operators' dispatchers and pilots decide any change to their flights.")
    if kind == "whatif":
        return (f"The change delays {v('whatif.affected')} of our inbound jets by up to {v('whatif.max_delay_min')} min. "
                f"{v('whatif.customs_at_risk')} international arrivals now risk missing customs. "
                f"Hours over capacity move from {v('whatif.hours_before')} to {v('whatif.hours_after')} under the current plan. "
                f"Alternate-airport options go to each operator's dispatcher; the pilot in command decides. "
                f"The FBO general manager approves holding stands, and customer service sends any customs request.")
    return "No explanation available."


def answer(facts: dict, question: str) -> str:
    """Rule-based answers to the manager's common questions, from the same facts as the briefing."""
    f = {x["id"]: x for x in facts.get("facts", [])}
    q = question.lower()
    best = facts.get("recommended", "B")
    ids = sorted({k.split(".")[0] for k in f if k[:1] in "ABC" and "." in k})

    def v(fid: str) -> str:
        return f"{f[fid]['value']} [{fid}]" if fid in f else "n/a"

    def line(sid: str, key: str, label: str) -> str:
        return f"{sid} {v(f'{sid}.kpis.{key}')} {label}"

    if any(w in q for w in ("staff", "crew", "tech", "people", "shift")):
        parts = "; ".join(line(s, "peak_line_staff", "line techs at the peak hour") for s in ids)
        return (f"Staffing by strategy: {parts}. The peak comes from movements, not parked jets, so the extra techs "
                f"cover arrival and departure banks. The FBO general manager approves the roster.")
    if any(w in q for w in ("co2", "carbon", "emission", "fuel", "green", "sustain")):
        parts = "; ".join(f"{line(s, 'empty_legs', 'empty legs')}, {v(f'{s}.kpis.co2_t')} t CO2" for s in ids)
        return (f"Emissions come from empty repositioning legs when jets cannot stay: {parts}. Partner airports close "
                f"by keep those legs short. The FBO general manager approves the strategy.")
    if any(w in q for w in ("overflow", "park", "space", "stand", "capacity", "full")):
        parts = "; ".join(f"{line(s, 'overflow_aircraft', 'overflow aircraft')}, {v(f'{s}.kpis.hours_over_capacity')} h over capacity" for s in ids)
        return (f"With no plan the ramp peaks at {v('status_quo.peak_demand')} large-cabin equivalents against {v('capacity')}, "
                f"{v('status_quo.hours_over_capacity')} hours over capacity. By strategy: {parts}. "
                f"The FBO general manager approves; partner FBOs confirm their stands.")
    if any(w in q for w in ("alert", "risk", "worry", "problem", "now")):
        top = facts.get("top_alerts") or []
        lead = f"There are {v('alerts.high')} high-severity alerts open."
        return lead + (" Top items: " + "; ".join(top) + "." if top else " Nothing urgent is open right now.") + \
            " Each alert names the role that acts on it; RAMPCAST does not act on its own."
    others = [s for s in ids if s != best]
    comp = "; ".join(f"{s}: {v(f'{s}.kpis.hours_over_capacity')} h over capacity, {v(f'{s}.kpis.co2_t')} t CO2, "
                     f"approved by {f[f'{s}.approvers']['value'] if f'{s}.approvers' in f else 'n/a'}" for s in others)
    return (f"Strategy {best} is suggested because it keeps the ramp within capacity with the least operational risk: "
            f"{v(f'{best}.kpis.hours_over_capacity')} h over capacity, {v(f'{best}.kpis.empty_legs')} empty legs, "
            f"{v(f'{best}.kpis.co2_t')} t CO2, {v(f'{best}.kpis.peak_line_staff')} line techs at the peak. "
            f"The alternatives: {comp}. The rule is: fewest hours over capacity, then lowest risk, then CO2 and staff. "
            f"It is a suggestion; the FBO general manager decides.")
