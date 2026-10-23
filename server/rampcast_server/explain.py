"""Plain-language briefings and explanations.

Claude writes them from the JSON facts we pass in, citing fact ids. Numbers always come from the engine,
never from the model. Without credentials (or on any API failure) a template writes the same facts.
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

import anthropic

log = logging.getLogger("rampcast.explain")

MODEL = "claude-opus-5-5"
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
    if os.environ.get("RAMPCAST_DISABLE_CLAUDE"):
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
                or (Path.home() / ".config" / "anthropic").exists())


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(timeout=60, max_retries=1)
    return _client


def _cited(text: str, facts: dict) -> list[str]:
    ids = set(re.findall(r"\[([A-Za-z0-9_.\-]+)\]", text))
    known = {f["id"] for f in facts.get("facts", [])}
    return sorted(ids & known) if known else sorted(ids)


def explain(kind: str, facts: dict, cache_key: str, question: str | None = None) -> dict:
    if cache_key in _cache:
        return _cache[cache_key]
    result = None
    if claude_available():
        try:
            prompt = (f"Task: {kind}.\n" + (f"Manager's question: {question}\n" if question else "")
                      + "Facts (JSON):\n" + json.dumps(facts, indent=1, default=str))
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
                    result = {"text": text, "cited_ids": _cited(text, facts), "model": response.model,
                              "fallback": False}
        except anthropic.RateLimitError:
            log.warning("Claude rate limited; using template")
        except anthropic.APIStatusError as e:
            log.warning("Claude API error %s; using template", e.status_code)
        except anthropic.APIConnectionError:
            log.warning("Claude unreachable; using template")
        except Exception as e:  # missing credentials and similar client-side errors
            log.warning("Claude unavailable (%s); using template", type(e).__name__)
    if result is None:
        text = template(kind, facts)
        result = {"text": text, "cited_ids": _cited(text, facts), "model": "template", "fallback": True}
    _cache[cache_key] = result
    return result


def template(kind: str, facts: dict) -> str:
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
    if kind == "whatif":
        return (f"The change delays {v('whatif.affected')} of our inbound jets by up to {v('whatif.max_delay_min')} min. "
                f"{v('whatif.customs_at_risk')} international arrivals now risk missing customs. "
                f"Hours over capacity move from {v('whatif.hours_before')} to {v('whatif.hours_after')} under the current plan. "
                f"Alternate-airport options go to each operator's dispatcher; the pilot in command decides. "
                f"The FBO general manager approves holding stands, and customer service sends any customs request.")
    return "No explanation available."
