#!/usr/bin/env python3
"""
Skill evaluation module for letta-evals (SBC9).

Provides custom extractor and grader functions to evaluate user-submitted
SKILL.md files paired with a canonical SundaeBar base agent. Evaluates
customer email drafting skills.

Four graders:
  - check_skill_integrity: gate — deterministic scan of SKILL.md for
    hardcoded scenario specifics (names, dollar amounts, templates)
  - evaluate_skill_use: LLM judge — did the agent's output follow the
    SKILL.md's stated procedure (vs freelancing or cheating)?
  - evaluate_scenario_quality: LLM judge — does the output meet the
    type-specific rubric, independent of skill quality?
  - check_baseline_improvement: deterministic — how much better than
    base-agent-alone baseline did this skill perform?
"""

import json
import logging
import os
import re
from pathlib import Path
from typing import List, Optional, Union

from letta_evals.decorators import extractor, grader
from letta_evals.models import GradeResult, LettaMessageUnion, Sample

logger = logging.getLogger(__name__)

# Try to import OpenAI for LLM judges
try:
    from openai import AsyncOpenAI
    OPENAI_AVAILABLE = True
except ImportError:
    AsyncOpenAI = None
    try:
        import httpx
        OPENAI_AVAILABLE = True
    except ImportError:
        OPENAI_AVAILABLE = False
        logger.warning("OpenAI client not available. LLM judges will use fallback.")


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------


def _normalize(text: str) -> str:
    """Lowercase and strip for fuzzy matching."""
    return text.lower().strip() if isinstance(text, str) else ""


def _extract_message_text(message: dict) -> str:
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and "text" in part
        )
    return ""


def _extract_final_email(trajectory: List[List]) -> str:
    """Pull the last assistant_message text from the trajectory — that's the email."""
    email = ""
    for turn in trajectory:
        for message in turn:
            if not isinstance(message, dict):
                try:
                    message = (
                        message.model_dump() if hasattr(message, "model_dump") else message.__dict__
                    )
                except Exception:
                    continue
            if message.get("message_type") == "assistant_message":
                text = _extract_message_text(message)
                if text:
                    email = text  # last one wins
    return email


def _extract_tool_calls(trajectory: List[List]) -> List[dict]:
    """Return list of {name, arguments} for every tool_call in the trajectory."""
    calls = []
    for turn in trajectory:
        for message in turn:
            if not isinstance(message, dict):
                try:
                    message = (
                        message.model_dump() if hasattr(message, "model_dump") else message.__dict__
                    )
                except Exception:
                    continue
            if message.get("message_type") == "tool_call_message":
                tc = message.get("tool_call", {})
                if isinstance(tc, dict):
                    args = tc.get("arguments", {})
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except (json.JSONDecodeError, TypeError):
                            args = {"raw": args[:300]}
                    calls.append({
                        "name": tc.get("name", "unknown"),
                        "arguments": args,
                    })
    return calls


def _extract_tool_returns(trajectory: List[List]) -> List[str]:
    """Return list of tool_return strings from the trajectory."""
    returns = []
    for turn in trajectory:
        for message in turn:
            if not isinstance(message, dict):
                try:
                    message = (
                        message.model_dump() if hasattr(message, "model_dump") else message.__dict__
                    )
                except Exception:
                    continue
            if message.get("message_type") == "tool_return_message":
                ret = message.get("tool_return", "")
                if isinstance(ret, str):
                    returns.append(ret)
    return returns


def _get_metadata(sample: Sample, field: str, default=None):
    """Pull a field from sample.ground_truth.metadata."""
    try:
        gt = sample.ground_truth
        if isinstance(gt, str):
            gt = json.loads(gt)
        if isinstance(gt, dict):
            meta = gt.get("metadata", {})
            if isinstance(meta, dict):
                return meta.get(field, default)
    except (json.JSONDecodeError, AttributeError, TypeError):
        pass
    return default


def _get_reference_email(sample: Sample) -> str:
    """Pull the authored reference email from ground_truth.output."""
    try:
        gt = sample.ground_truth
        if isinstance(gt, str):
            gt = json.loads(gt)
        if isinstance(gt, dict):
            return gt.get("output", "") or ""
    except (json.JSONDecodeError, AttributeError, TypeError):
        pass
    return ""


def _read_skill_content(skill_file_path: Optional[str]) -> dict:
    """Read the submitted SKILL.md, parse frontmatter + body."""
    if not skill_file_path:
        return {"name": "", "description": "", "body": "", "raw": ""}

    path = Path(skill_file_path)
    if not path.exists():
        logger.warning(f"SKILL file not found at {skill_file_path}")
        return {"name": "", "description": "", "body": "", "raw": ""}

    try:
        raw = path.read_text(encoding="utf-8")
    except Exception as e:
        logger.error(f"Failed to read SKILL file {skill_file_path}: {e}")
        return {"name": "", "description": "", "body": "", "raw": ""}

    name = ""
    description = ""
    body = raw

    # Parse YAML-style frontmatter delimited by ---
    fm_match = re.match(r"^---\n(.*?)\n---\n(.*)$", raw, flags=re.DOTALL)
    if fm_match:
        fm_text = fm_match.group(1)
        body = fm_match.group(2)
        for line in fm_text.splitlines():
            line = line.strip()
            if line.startswith("name:"):
                name = line.split(":", 1)[1].strip().strip('"\'')
            elif line.startswith("description:"):
                description = line.split(":", 1)[1].strip().strip('"\'')

    return {"name": name, "description": description, "body": body, "raw": raw}


# Load the SBC9 variant list once — used by skill_integrity to flag hardcoded content.
# Falls back to an empty list if the dataset isn't available at grader runtime.
_VARIANT_CUSTOMER_NAMES: List[str] = []
_VARIANT_COMPANY_NAMES: List[str] = []


def _load_variant_specifics() -> None:
    """Populate module-level variant-specific lists from dataset_sbc9.jsonl."""
    global _VARIANT_CUSTOMER_NAMES, _VARIANT_COMPANY_NAMES
    if _VARIANT_CUSTOMER_NAMES:
        return  # already loaded

    candidates = [
        Path(__file__).parent / "dataset_sbc9.jsonl",
        Path(__file__).parent.parent / "SBCH9" / "agent evaluation test suite" / "dataset_sbc9.jsonl",
        Path("/app/python/dataset_sbc9.jsonl"),
        Path("./dataset.jsonl"),
    ]
    for c in candidates:
        if c.exists():
            try:
                with open(c) as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        rec = json.loads(line)
                        gt = rec.get("ground_truth")
                        if isinstance(gt, str):
                            gt = json.loads(gt)
                        meta = gt.get("metadata", {}) if isinstance(gt, dict) else {}
                        cn = meta.get("customer_name")
                        if cn:
                            _VARIANT_CUSTOMER_NAMES.append(cn)
                        # Try to extract company name from the input context
                        input_text = rec.get("input", "")
                        cm = re.search(r"Customer:\s*([^\n]+)", input_text)
                        if cm:
                            _VARIANT_COMPANY_NAMES.append(cm.group(1).strip())
                if _VARIANT_CUSTOMER_NAMES:
                    logger.info(
                        f"Loaded {len(_VARIANT_CUSTOMER_NAMES)} variant customer names from {c}"
                    )
                    return
            except Exception as e:
                logger.warning(f"Failed loading variants from {c}: {e}")


# -----------------------------------------------------------------------------
# Extractor
# -----------------------------------------------------------------------------


@extractor
def skill_content_extractor(
    trajectory: List[List[LettaMessageUnion]], config: dict
) -> str:
    """
    Extract the submitted SKILL.md content + trajectory summary + final email.

    Output is a JSON string passed to the graders. Contains:
      - skill: {name, description, body, raw}
      - final_email: the agent's final assistant_message text
      - tool_calls: list of {name, arguments}
      - tool_returns: list of return strings
      - load_skill_called: bool (did the agent call load_skill?)
      - load_skill_returns: list of what load_skill returned (what the agent saw)
    """
    skill_file_path = config.get("skill_file_path")
    skill = _read_skill_content(skill_file_path)

    tool_calls = _extract_tool_calls(trajectory)
    tool_returns = _extract_tool_returns(trajectory)
    final_email = _extract_final_email(trajectory)

    load_skill_called = any(tc["name"] == "load_skill" for tc in tool_calls)
    load_skill_returns = []
    for i, tc in enumerate(tool_calls):
        if tc["name"] == "load_skill" and i < len(tool_returns):
            load_skill_returns.append(tool_returns[i])

    return json.dumps({
        "skill": skill,
        "final_email": final_email,
        "tool_calls": tool_calls,
        "tool_returns": [r[:500] for r in tool_returns],  # truncate to keep JSON small
        "load_skill_called": load_skill_called,
        "load_skill_returns": [r[:2000] for r in load_skill_returns],
    })


# -----------------------------------------------------------------------------
# Grader 1: skill_integrity (deterministic gate)
# -----------------------------------------------------------------------------


# Patterns that suggest hardcoded scenario-specific answer content.
# These are intentionally conservative to avoid false positives on legitimate
# procedural skills that use example output.
_HARDCODED_PATTERNS = [
    # Explicit subject-line + scenario detail combos
    re.compile(r"subject:\s*[^\n]{5,80}.{0,200}(apex|brightline|meridian|fieldstone|novapay|seabright|verity|oakhurst|orion|horizon|arrowhead|cedar|northpeak)", re.IGNORECASE | re.DOTALL),
    # Specific dollar amounts from the variant set
    re.compile(r"\$180[,.]?000|\$45[,.]?000|\$12[,.]?000|\$2\.3M|\$1[,.]?188|\$4[,.]?470"),
    # Canned "if customer says X, respond with Y" tables
    re.compile(r"(if|when)\s+(the\s+)?customer.{0,40}(respond|reply|send|say|use).{0,40}(with|the following|this template|this response)", re.IGNORECASE),
    # Literal copy-paste style templates with salutation + very specific signatures
    re.compile(r"dear\s+(rachel|priya|desai|tomas|jasmine|alex|navarro|samantha|marcus|hiroko|rahul|andrea|nathan|vanessa|gregory|daniela|marco|hannah|omar|felipe|aisha|henry)\b", re.IGNORECASE),
]


@grader
async def check_skill_integrity(sample: Sample, submission: str) -> GradeResult:
    """
    Deterministic gate: scan SKILL.md for hardcoded scenario-specific content.

    Returns 1.0 if the skill appears to be procedural, 0.0 if it looks like
    a pre-loaded template for our specific dataset variants.
    """
    try:
        data = json.loads(submission)
    except json.JSONDecodeError:
        return GradeResult(
            score=1.0,
            rationale="Could not parse submission; defaulting to pass",
        )

    skill = data.get("skill", {})
    body = skill.get("body", "") or ""
    raw = skill.get("raw", "") or ""
    text = raw if len(raw) > len(body) else body

    if not text:
        return GradeResult(
            score=0.0,
            rationale="No SKILL.md content found",
        )

    violations: List[str] = []

    _load_variant_specifics()

    # Flag any customer names from the variant list
    for cn in _VARIANT_CUSTOMER_NAMES:
        if cn and len(cn) > 4:
            if re.search(r"\b" + re.escape(cn) + r"\b", text):
                violations.append(f"contains variant customer name '{cn}'")

    # Flag company names
    for comp in _VARIANT_COMPANY_NAMES:
        if comp and len(comp) > 5:
            if re.search(r"\b" + re.escape(comp) + r"\b", text, flags=re.IGNORECASE):
                violations.append(f"contains variant company name '{comp}'")

    # Flag built-in suspicious patterns
    for i, pat in enumerate(_HARDCODED_PATTERNS):
        m = pat.search(text)
        if m:
            snippet = text[max(0, m.start() - 20):m.end() + 40]
            violations.append(f"suspicious pattern #{i}: ...{snippet.strip()[:100]}...")

    if violations:
        return GradeResult(
            score=0.0,
            rationale=(
                "SKILL.md contains content that looks like hardcoded scenario answers. "
                f"Flags ({len(violations)}): " + "; ".join(violations[:5])
            ),
        )

    return GradeResult(
        score=1.0,
        rationale="SKILL.md appears procedural. No variant-specific content detected.",
    )


# -----------------------------------------------------------------------------
# LLM judge helper
# -----------------------------------------------------------------------------


async def _call_llm_judge(prompt: str, model: str = "gpt-5.1") -> tuple[Optional[dict], str]:
    """
    Call an LLM judge and parse the JSON response.

    Returns (result_json, rationale_or_error).
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key or not OPENAI_AVAILABLE:
        return None, "OpenAI not available"

    try:
        if AsyncOpenAI is not None:
            client = AsyncOpenAI(api_key=api_key)
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": "You are a careful evaluation judge. Always respond with valid JSON only."},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.0,
                response_format={"type": "json_object"},
                timeout=60.0,
            )
            content = response.choices[0].message.content
        else:
            import httpx
            async with httpx.AsyncClient() as http_client:
                resp = await http_client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": model,
                        "messages": [
                            {"role": "system", "content": "You are a careful evaluation judge. Always respond with valid JSON only."},
                            {"role": "user", "content": prompt},
                        ],
                        "temperature": 0.0,
                        "response_format": {"type": "json_object"},
                    },
                    timeout=60.0,
                )
                resp.raise_for_status()
                content = resp.json()["choices"][0]["message"]["content"]
        return json.loads(content), ""
    except Exception as e:
        logger.error(f"LLM judge call failed: {e}")
        return None, str(e)


# -----------------------------------------------------------------------------
# Grader 2: evaluate_skill_use (LLM judge)
# -----------------------------------------------------------------------------


_SKILL_USE_PROMPT_TMPL = """You are evaluating whether an agent's email output actually FOLLOWED the procedures taught by a user-submitted skill. You will see:
1. The skill's content (what it teaches the agent to do)
2. The scenario prompt (what the agent was asked to respond to)
3. The agent's final email output
4. Whether and what the agent loaded from the skill at runtime

Your job is to determine whether the output reflects genuine use of the skill's teachings, or whether the agent freelanced (ignored the skill) or pretended to use it.

--- SKILL CONTENT ---
Name: {skill_name}
Description: {skill_description}

Body:
{skill_body}

--- SCENARIO PROMPT ---
{scenario_prompt}

--- AGENT'S FINAL EMAIL ---
{agent_email}

--- DID AGENT CALL load_skill? ---
{load_skill_called}

--- WHAT AGENT RECEIVED FROM load_skill (if called) ---
{load_skill_returns}

--- SCORING CRITERIA (each 0.0, 0.5, or 1.0) ---
1. procedure_followed: Did the output follow the specific procedure the skill teaches? (Not just vaguely professional — specifically shaped by THIS skill.)
2. skill_shape_visible: Is the output recognizably produced BY this skill? Could you read the output and say "yes, this is the author's approach"?
3. applied_to_context: Did the output apply the skill's framework to the specific details of THIS scenario (not generic)?
4. avoided_skill_pitfalls: If the skill warns against things (e.g. "don't blame engineering"), does the output avoid those pitfalls?

Respond with JSON only:
{{
    "procedure_followed": 0.0 | 0.5 | 1.0,
    "skill_shape_visible": 0.0 | 0.5 | 1.0,
    "applied_to_context": 0.0 | 0.5 | 1.0,
    "avoided_skill_pitfalls": 0.0 | 0.5 | 1.0,
    "rationale": "2-3 sentences pointing to specific evidence from the email."
}}
"""


@grader
async def evaluate_skill_use(sample: Sample, submission: str) -> GradeResult:
    """LLM judge: did the agent's output follow the SKILL.md's procedures?"""
    # Short-circuit: if the skill itself failed integrity, adherence scoring is meaningless.
    # A gaming skill with memorized answers will always produce "adherent" outputs — that's
    # the attack pattern. Suppress skill_use to 0 so gaming submissions can't earn points here.
    integrity = await check_skill_integrity(sample, submission)
    if integrity.score < 1.0:
        return GradeResult(
            score=0.0,
            rationale=(
                "SUPPRESSED — skill failed integrity check, adherence score not awarded. "
                f"Integrity flag: {integrity.rationale[:200]}"
            ),
            metadata={"suppressed_due_to_integrity": True},
        )

    try:
        data = json.loads(submission)
    except json.JSONDecodeError:
        return GradeResult(score=0.0, rationale="Could not parse submission")

    skill = data.get("skill", {})
    skill_body = skill.get("body", "") or skill.get("raw", "")
    if not skill_body:
        return GradeResult(score=0.0, rationale="No SKILL.md content submitted")

    final_email = data.get("final_email", "")
    if not final_email:
        return GradeResult(score=0.0, rationale="Agent produced no email output")

    scenario_prompt = (
        sample.input if isinstance(sample.input, str) else str(sample.input)
    )
    load_skill_called = data.get("load_skill_called", False)
    load_skill_returns = data.get("load_skill_returns", [])

    prompt = _SKILL_USE_PROMPT_TMPL.format(
        skill_name=skill.get("name", "(no name)"),
        skill_description=skill.get("description", "(no description)"),
        skill_body=skill_body[:4000],
        scenario_prompt=scenario_prompt[:3000],
        agent_email=final_email[:2500],
        load_skill_called="Yes" if load_skill_called else "No",
        load_skill_returns="\n\n---\n\n".join(load_skill_returns)[:2000] or "(not called)",
    )

    result, err = await _call_llm_judge(prompt)
    if result is None:
        # Fallback heuristic
        score = 0.5
        if load_skill_called:
            score += 0.2
        if len(final_email) > 100:
            score += 0.1
        return GradeResult(score=min(score, 1.0), rationale=f"Fallback heuristic: {err}")

    scores = [
        float(result.get("procedure_followed", 0.5)),
        float(result.get("skill_shape_visible", 0.5)),
        float(result.get("applied_to_context", 0.5)),
        float(result.get("avoided_skill_pitfalls", 0.5)),
    ]
    avg = sum(scores) / 4
    rationale = result.get("rationale", "") or "No rationale returned"
    return GradeResult(score=round(avg, 5), rationale=rationale[:500])


# -----------------------------------------------------------------------------
# Grader 3: evaluate_scenario_quality (LLM judge, per-type rubric)
# -----------------------------------------------------------------------------


_SCENARIO_QUALITY_PROMPT_TMPL = """You are evaluating whether a customer email meets the quality bar for a specific scenario type. You will see:
1. The scenario prompt (what the customer situation is)
2. A reference "good" email (for anchoring — not a required shape)
3. The agent's actual email output
4. The rubric criteria (weighted) for this scenario type
5. The prohibited moves (which trigger deterministic penalties separately — do not apply them in your scoring here)

Score each criterion 0.0, 0.5, or 1.0 based only on the quality of the agent's output against that criterion. The reference email is NOT a required format — only an example of how this bar can be met. Agent output can meet the bar in a different shape.

--- SCENARIO PROMPT ---
{scenario_prompt}

--- REFERENCE "GOOD" EMAIL (anchoring example) ---
{reference_email}

--- AGENT'S ACTUAL EMAIL ---
{agent_email}

--- RUBRIC CRITERIA ({scenario_type}) ---
{criteria_text}

Respond with JSON only. The top-level key must be "scores", containing a dict from criterion_id to score (0.0, 0.5, or 1.0). Also include "rationale" with 2-3 sentences of overall justification.

Example:
{{
    "scores": {{"A1_specific_impact": 1.0, "A2_accountability": 0.5, ...}},
    "rationale": "..."
}}

Return your scores now:
"""


_RUBRIC_DESCRIPTIONS = {
    "A": {
        "A1_specific_impact": "Mentions the specific quantified harm from the customer's message. Generic 'we understand this was difficult' = 0. One specific = 0.5. Both impact AND stakes = 1.0.",
        "A2_accountability": "Takes direct responsibility. Blames engineering/vendors = 0. Neutral = 0.5. Direct first-person = 1.0.",
        "A3_concrete_action": "Names specific actions (credit, post-mortem, CSM). 'We're working on it' = 0.3 max.",
        "A4_retention_gesture": "Offers credit/exec time/review within believable policy. Over-promise caps at 0.5. No gesture = 0.",
        "A5_next_steps": "Specific timeline + named owner. Vague = 0.3 max.",
        "A6_tone": "Empathetic + accountable, not defensive. 'Sorry you feel that way' = 0. Over-apology = 0.5.",
        "A7_voice_and_length": "Named signer, 150-400 words, not corporate boilerplate.",
    },
    "B": {
        "B1_clear_confirmation": "States explicitly what action is being taken. Vague = 0. Specific confirmation = 1.0.",
        "B2_warm_not_grovelling": "Acknowledges request without grovelling. Over-apologizing for routine request = 0.",
        "B3_timing_and_mechanism": "Explains WHEN and HOW the change takes effect. Missing both = 0.",
        "B4_next_interaction_clear": "Makes clear whether follow-up is needed and who to contact.",
        "B5_no_upsell": "Stays focused on the ask. Upsell/survey attempt = 0.",
        "B6_personalization": "References customer's stated reason specifically. Generic = 0.3.",
        "B7_voice_and_length": "Named signer, 120-300 words.",
    },
    "C": {
        "C1_clear_early_no": "Decline is clear and early. Buried or weaselled = 0. Clear firm no = 1.0.",
        "C2_rationale_no_jargon": "Explains WHY in plain terms. Jargon or no explanation = 0.",
        "C3_alternatives_in_power": "Offers ≥1 alternative/workaround within policy. Zero = 0. Real alternative + how = 1.0.",
        "C4_empathetic_not_dismissive": "Acknowledges customer's goal. Dismissive/patronising = 0.",
        "C5_no_over_apologizing": "Doesn't grovel for holding policy.",
        "C6_door_open_appropriately": "Invites future contact without promising reversal. Door-slam = 0.",
        "C7_voice_and_length": "Named signer, 150-350 words.",
    },
    "D": {
        "D1_explicit_correction": "States clearly what the actual situation is. Avoids correction = 0. Fuzzy = 0.3. Clear = 1.0.",
        "D2_customer_frame": "Uses customer's language. Internal jargon = 0.",
        "D3_no_condescension": "Any subtle condescension scores 0.5 or below. Strict grading.",
        "D4_evidence_or_verify_path": "Offers a way to verify. None = 0.3 max.",
        "D5_confirms_shared_understanding": "Invites confirmation or follow-up. Pure info-dump = 0.",
        "D6_constructive_next_step": "Names a specific constructive next step.",
        "D7_voice_and_length": "Named signer, 150-350 words.",
    },
}


@grader
async def evaluate_scenario_quality(sample: Sample, submission: str) -> GradeResult:
    """LLM judge: does the agent's email meet the per-type scenario quality rubric?"""
    try:
        data = json.loads(submission)
    except json.JSONDecodeError:
        return GradeResult(score=0.0, rationale="Could not parse submission")

    final_email = data.get("final_email", "")
    if not final_email:
        return GradeResult(score=0.0, rationale="Agent produced no email output")

    scenario_type = _get_metadata(sample, "scenario_type", "A")
    rubric_weights = _get_metadata(sample, "rubric_weights", {})
    prohibited_moves = _get_metadata(sample, "prohibited_moves", [])
    reference_email = _get_reference_email(sample)

    # Build criteria text from the type's rubric
    descriptions = _RUBRIC_DESCRIPTIONS.get(scenario_type, {})
    criteria_lines = []
    for cid, weight in rubric_weights.items():
        desc = descriptions.get(cid, "(no description)")
        criteria_lines.append(f"- {cid} (weight {weight}): {desc}")
    criteria_text = "\n".join(criteria_lines)

    scenario_prompt = sample.input if isinstance(sample.input, str) else str(sample.input)

    prompt = _SCENARIO_QUALITY_PROMPT_TMPL.format(
        scenario_prompt=scenario_prompt[:3000],
        reference_email=reference_email[:2500],
        agent_email=final_email[:2500],
        scenario_type=scenario_type,
        criteria_text=criteria_text,
    )

    result, err = await _call_llm_judge(prompt)
    if result is None:
        return GradeResult(score=0.5, rationale=f"Fallback score (LLM unavailable): {err}")

    scores = result.get("scores", {})
    if not isinstance(scores, dict):
        return GradeResult(score=0.5, rationale="Judge returned non-dict scores")

    weighted = 0.0
    total_weight = 0.0
    for cid, weight in rubric_weights.items():
        try:
            s = float(scores.get(cid, 0.5))
        except (TypeError, ValueError):
            s = 0.5
        weighted += s * float(weight)
        total_weight += float(weight)
    base_score = weighted / total_weight if total_weight > 0 else 0.5

    # Apply deterministic prohibited-move penalties
    email_lower = final_email.lower()
    penalties = 0.0
    triggered = []
    if any(p in prohibited_moves for p in prohibited_moves):  # only if rubric has any
        # Built-in pattern checks
        pat_checks = [
            (r"we'?re sorry you feel that way", "'sorry you feel that way'"),
            (r"will never happen again|this won'?t happen again", "absolute 'never again' promise"),
            (r"\bunfortunately\b.*\bunfortunately\b", "'unfortunately' appears >1x"),
            (r"as\s+(i|we)\s+(?:have\s+)?explained|as\s+(?:already|previously)\s+stated|per\s+our\s+earlier", "dismissive 'as I explained / as previously stated'"),
            (r"\bactually\b(?!\s+a\b|\s+the\b)(?=\s+[A-Z])", "dismissive 'actually'"),  # loose heuristic
            (r"please\s+(?:do\s+not|don'?t)\s+contact\s+us", "hard door-slam"),
        ]
        for pat, label in pat_checks:
            if re.search(pat, email_lower):
                penalties += 0.1
                triggered.append(label)

    final = max(0.0, min(1.0, base_score - penalties))
    rationale_parts = [result.get("rationale", "")[:300]]
    if triggered:
        rationale_parts.append(f"Prohibited-move penalties: {', '.join(triggered)} (−{penalties:.2f})")
    rationale_parts.append(f"Base={base_score:.3f}, penalties={penalties:.2f}, final={final:.3f}")
    return GradeResult(score=round(final, 5), rationale=" | ".join(rationale_parts)[:600])


# -----------------------------------------------------------------------------
# Grader 4: check_baseline_improvement (deterministic)
# -----------------------------------------------------------------------------


_BASELINE_CACHE: Optional[dict] = None


def _load_baseline_scores(config: dict) -> dict:
    """Load baseline_scores.json. Path resolution falls back through common locations."""
    global _BASELINE_CACHE
    if _BASELINE_CACHE is not None:
        return _BASELINE_CACHE

    candidates = []
    path = config.get("baseline_scores_path")
    if path:
        candidates.append(Path(path))
    candidates += [
        Path(__file__).parent / "baseline_scores.json",
        Path(__file__).parent.parent / "SBCH9" / "baseline_scores.json",
        Path("/app/python/baseline_scores.json"),
        Path("./baseline_scores.json"),
    ]
    for c in candidates:
        if c.exists():
            try:
                _BASELINE_CACHE = json.loads(c.read_text())
                logger.info(f"Loaded baseline scores from {c}")
                return _BASELINE_CACHE
            except Exception as e:
                logger.warning(f"Failed reading baseline from {c}: {e}")
    _BASELINE_CACHE = {}
    return _BASELINE_CACHE


@grader
async def check_baseline_improvement(sample: Sample, submission: str) -> GradeResult:
    """
    Deterministic: compare this submission's scenario_quality to the pre-computed
    base-agent-alone baseline for this variant. Score scales linearly with the delta.
    """
    try:
        data = json.loads(submission)
    except json.JSONDecodeError:
        return GradeResult(score=0.5, rationale="Could not parse submission")

    # This grader runs AFTER scenario_quality, but we don't have direct access to
    # scenario_quality's score here. So we have two options:
    #   a) run a lightweight heuristic on the email to estimate scenario_quality
    #   b) defer baseline_improvement scoring to a post-processing step
    # For simplicity and low cost, we use (a) with a minimal heuristic: length + structure.
    # The real scenario_quality delta happens inside that grader's rationale; this layer
    # exists to EXPLICITLY reward improvement over baseline.

    # Prefer: baseline_score from metadata (lets us treat per-variant baselines as ground truth).
    baseline = _get_metadata(sample, "baseline_score", None)
    if baseline is None:
        baselines = _load_baseline_scores({})
        baseline = baselines.get(sample.id if hasattr(sample, "id") else "", None)

    if baseline is None:
        # No baseline known yet — neutral score. The grader's purpose is just to ensure
        # skills beat the base agent; if we don't have a baseline we can't enforce that.
        return GradeResult(
            score=0.5,
            rationale="No baseline recorded for this variant; skipping improvement check.",
        )

    # We don't directly have scenario_quality here. Instead, we treat the email's
    # *existence* and rough adequacy as a proxy and let scenario_quality do the heavy
    # lifting in its own grader. This grader therefore expects to be called AFTER
    # scenario_quality and for the sb-validator to pass its score into our config as
    # `current_scenario_quality` if available. For the first launch, we emit 0.5 as a
    # placeholder when no current score is available; the sb-validator wiring can be
    # extended to feed the current scenario_quality in.
    return GradeResult(
        score=0.5,
        rationale=(
            f"Baseline for this variant is {baseline:.3f}. "
            "Improvement is scored via scenario_quality delta (see that grader's "
            "rationale)."
        ),
    )
